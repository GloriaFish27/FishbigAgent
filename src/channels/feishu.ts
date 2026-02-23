import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { IPC } from '../bridge/ipc.js';

interface FeishuConfig {
    appId: string;
    appSecret: string;
}

interface FeishuMessageEvent {
    message?: {
        message_id?: string;
        chat_id?: string;
        message_type?: string;
        content?: string;
    };
    sender?: {
        sender_id?: { open_id?: string };
    };
}

const DEDUP_FILE = 'seen-msg-ids.json';
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * FeishuBridge — pure message relay.
 * Feishu → inbox (for Brain to read)
 * outbox → Feishu (Brain writes responses here)
 */
export class FeishuBridge {
    private config: FeishuConfig;
    private ipc: IPC;
    private dataDir: string;
    private larkClient: Lark.Client;
    private wsClient?: Lark.WSClient;
    private seenIds: Map<string, number>; // msgId → timestamp

    constructor(config: FeishuConfig, ipc: IPC, dataDir: string) {
        this.config = config;
        this.ipc = ipc;
        this.dataDir = dataDir;
        this.larkClient = new Lark.Client({
            appId: config.appId,
            appSecret: config.appSecret,
            appType: Lark.AppType.SelfBuild,
            domain: Lark.Domain.Feishu,
        });

        // Load persisted dedup IDs (survive restarts)
        this.seenIds = this._loadSeenIds();
    }

    async connect(): Promise<void> {
        const eventDispatcher = new Lark.EventDispatcher({});

        eventDispatcher.register({
            'im.message.receive_v1': async (data) => {
                try { this._handle(data as unknown as FeishuMessageEvent); }
                catch (err) { console.error('[FEISHU] Error:', (err as Error).message); }
            },
        });

        this.wsClient = new Lark.WSClient({
            appId: this.config.appId,
            appSecret: this.config.appSecret,
            domain: Lark.Domain.Feishu,
            loggerLevel: Lark.LoggerLevel.info,
        });

        // Watch outbox: when Brain writes a response, send it to Feishu
        this.ipc.watchOutbox(async (msg) => {
            await this.sendMessage(msg.chatId, msg.text);
        });

        console.log('[FEISHU] Connecting...');
        this.wsClient.start({ eventDispatcher });
    }

    private _handle(event: FeishuMessageEvent): void {
        const msg = event.message;
        if (!msg) return;

        // Dedup — persistent across restarts, 24h TTL
        const msgId = msg.message_id ?? '';
        if (msgId && this.seenIds.has(msgId)) return;
        if (msgId) {
            this.seenIds.set(msgId, Date.now());
            this._saveSeenIds();
        }

        const chatId = msg.chat_id;
        if (!chatId) return;

        const messageType = msg.message_type ?? 'text';
        let text = '';
        let mediaInfo = '';

        try {
            const parsed = JSON.parse(msg.content ?? '{}');

            if (messageType === 'text') {
                text = parsed.text ?? '';
            } else if (messageType === 'post') {
                // Rich text: extract text content from nested structure
                text = this._parsePostContent(parsed);
            } else if (messageType === 'image') {
                // Image message — download and pass to brain
                const imageKey = parsed.image_key;
                if (imageKey) {
                    text = `[图片消息: image_key=${imageKey}]`;
                    mediaInfo = `image_key:${imageKey}`;
                    // Download async (don't block message handling)
                    this._downloadImage(msgId, imageKey).catch(err =>
                        console.error('[FEISHU] Image download failed:', err)
                    );
                }
            } else if (messageType === 'file') {
                const fileName = parsed.file_name ?? 'unknown';
                text = `[文件消息: ${fileName}]`;
            } else {
                // Audio, video, sticker, etc.
                text = `[${messageType}消息]`;
            }
        } catch {
            text = msg.content ?? '';
        }

        text = text.trim();
        if (!text) return;

        console.log(`[FEISHU] ← [${messageType}] "${text.slice(0, 80)}"`);

        this.ipc.writeInbox({
            chatId,
            text: mediaInfo ? `${text}\n${mediaInfo}` : text,
            type: 'feishu_message',
            from: event.sender?.sender_id?.open_id,
        });
    }

    async sendMessage(chatId: string, text: string): Promise<void> {
        const MAX_LEN = 4000;

        // Clean up excessive blank lines first
        const cleaned = text.replace(/\n{3,}/g, '\n\n').trim();

        if (cleaned.length <= MAX_LEN) {
            await this._sendOne(chatId, cleaned);
        } else {
            // Split at paragraph boundaries
            const chunks = this._splitMessage(cleaned, MAX_LEN);
            for (let i = 0; i < chunks.length; i++) {
                await this._sendOne(chatId, chunks[i]);
                if (i < chunks.length - 1) {
                    await new Promise(r => setTimeout(r, 300));
                }
            }
        }
    }

    private async _sendOne(chatId: string, text: string): Promise<void> {
        try {
            if (this._hasMarkdown(text)) {
                // Send as interactive card for rich markdown rendering
                await this.larkClient.im.message.create({
                    params: { receive_id_type: 'chat_id' },
                    data: {
                        receive_id: chatId,
                        msg_type: 'interactive',
                        content: JSON.stringify({
                            config: { wide_screen_mode: true },
                            elements: [{ tag: 'markdown', content: text }],
                        }),
                    },
                });
                console.log(`[FEISHU] →📋 card "${text.slice(0, 60)}..."`);
            } else {
                // Plain text
                await this.larkClient.im.message.create({
                    params: { receive_id_type: 'chat_id' },
                    data: {
                        receive_id: chatId,
                        msg_type: 'text',
                        content: JSON.stringify({ text }),
                    },
                });
                console.log(`[FEISHU] → "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);
            }
        } catch (err) {
            console.error('[FEISHU] Send error:', (err as Error).message);
        }
    }

    /** Detect if text contains markdown that benefits from card rendering */
    private _hasMarkdown(text: string): boolean {
        return /```|\*\*|^#{1,3}\s|^\|.*\|.*\||^[-*]\s/m.test(text);
    }

    /** Upload and send an image to Feishu */
    async sendImage(chatId: string, imagePath: string): Promise<void> {
        try {
            const buffer = fs.readFileSync(imagePath);
            const response = await this.larkClient.im.image.create({
                data: {
                    image_type: 'message',
                    image: Readable.from(buffer) as any,
                },
            }) as any;

            const imageKey = response?.image_key ?? response?.data?.image_key;
            if (!imageKey) {
                console.error('[FEISHU] Image upload failed: no image_key');
                return;
            }

            await this.larkClient.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: {
                    receive_id: chatId,
                    msg_type: 'image',
                    content: JSON.stringify({ image_key: imageKey }),
                },
            });
            console.log(`[FEISHU] →🖼️ image ${path.basename(imagePath)}`);
        } catch (err) {
            console.error('[FEISHU] Image send error:', (err as Error).message);
        }
    }

    /** Upload and send a file to Feishu */
    async sendFile(chatId: string, filePath: string): Promise<void> {
        try {
            const fileName = path.basename(filePath);
            const ext = path.extname(fileName).toLowerCase();
            const fileType = {
                '.pdf': 'pdf', '.doc': 'doc', '.docx': 'doc',
                '.xls': 'xls', '.xlsx': 'xls', '.ppt': 'ppt', '.pptx': 'ppt',
                '.mp4': 'mp4', '.opus': 'opus',
            }[ext] ?? 'stream';

            const response = await this.larkClient.im.file.create({
                data: {
                    file_type: fileType as any,
                    file_name: fileName,
                    file: fs.createReadStream(filePath) as any,
                },
            }) as any;

            const fileKey = response?.file_key ?? response?.data?.file_key;
            if (!fileKey) {
                console.error('[FEISHU] File upload failed: no file_key');
                return;
            }

            await this.larkClient.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: {
                    receive_id: chatId,
                    msg_type: 'file',
                    content: JSON.stringify({ file_key: fileKey }),
                },
            });
            console.log(`[FEISHU] →📎 file ${fileName}`);
        } catch (err) {
            console.error('[FEISHU] File send error:', (err as Error).message);
        }
    }

    /** Download an image from a message and save to data dir */
    private async _downloadImage(messageId: string, imageKey: string): Promise<void> {
        try {
            const response = await this.larkClient.im.messageResource.get({
                path: { message_id: messageId, file_key: imageKey },
                params: { type: 'image' },
            }) as any;

            if (response) {
                const imgDir = path.join(this.dataDir, 'images');
                fs.mkdirSync(imgDir, { recursive: true });
                const filePath = path.join(imgDir, `${imageKey}.png`);
                // Response is a readable stream
                const chunks: Buffer[] = [];
                for await (const chunk of response) {
                    chunks.push(Buffer.from(chunk));
                }
                fs.writeFileSync(filePath, Buffer.concat(chunks));
                console.log(`[FEISHU] 📷 Downloaded image: ${filePath}`);
            }
        } catch (err) {
            console.error('[FEISHU] Image download failed:', (err as Error).message);
        }
    }

    /** Parse post (rich text) content into plain text */
    private _parsePostContent(parsed: Record<string, unknown>): string {
        try {
            const title = (parsed.title as string) ?? '';
            const content = (parsed.content as Array<Array<Record<string, string>>>) ?? [];
            let text = title ? `${title}\n\n` : '';

            for (const paragraph of content) {
                if (Array.isArray(paragraph)) {
                    for (const el of paragraph) {
                        if (el.tag === 'text') text += el.text ?? '';
                        else if (el.tag === 'a') text += el.text ?? el.href ?? '';
                        else if (el.tag === 'at') text += `@${el.user_name ?? ''}`;
                        else if (el.tag === 'img') text += '[图片]';
                    }
                    text += '\n';
                }
            }
            return text.trim() || '[富文本消息]';
        } catch {
            return '[富文本消息]';
        }
    }

    /** Split text at paragraph boundaries, respecting max length */
    private _splitMessage(text: string, maxLen: number): string[] {
        const chunks: string[] = [];
        const paragraphs = text.split('\n\n');
        let current = '';

        for (const para of paragraphs) {
            if (current.length + para.length + 2 > maxLen && current.length > 0) {
                chunks.push(current.trim());
                current = para;
            } else {
                current += (current ? '\n\n' : '') + para;
            }
        }
        if (current.trim()) chunks.push(current.trim());

        // If any chunk is still too long, hard-split at newlines
        const result: string[] = [];
        for (const chunk of chunks) {
            if (chunk.length <= maxLen) {
                result.push(chunk);
            } else {
                const lines = chunk.split('\n');
                let buf = '';
                for (const line of lines) {
                    if (buf.length + line.length + 1 > maxLen && buf.length > 0) {
                        result.push(buf.trim());
                        buf = line;
                    } else {
                        buf += (buf ? '\n' : '') + line;
                    }
                }
                if (buf.trim()) result.push(buf.trim());
            }
        }
        return result;
    }

    disconnect(): void { /* no-op */ }

    /** Load persisted seen message IDs, prune entries older than DEDUP_TTL_MS */
    private _loadSeenIds(): Map<string, number> {
        const file = path.join(this.dataDir, DEDUP_FILE);
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, number>;
            const now = Date.now();
            const map = new Map<string, number>();
            for (const [id, ts] of Object.entries(raw)) {
                if (now - ts < DEDUP_TTL_MS) map.set(id, ts);
            }
            console.log(`[FEISHU] Loaded ${map.size} dedup IDs (pruned ${Object.keys(raw).length - map.size} old)`);
            return map;
        } catch {
            return new Map();
        }
    }

    /** Persist seen IDs to file */
    private _saveSeenIds(): void {
        const file = path.join(this.dataDir, DEDUP_FILE);
        const obj: Record<string, number> = {};
        const now = Date.now();
        for (const [id, ts] of this.seenIds) {
            if (now - ts < DEDUP_TTL_MS) obj[id] = ts;
        }
        try {
            fs.writeFileSync(file, JSON.stringify(obj));
        } catch { /* ignore */ }
    }
}
