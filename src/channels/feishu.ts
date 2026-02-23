import * as Lark from '@larksuiteoapi/node-sdk';
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

/**
 * FeishuBridge — pure message relay.
 * Feishu → inbox (for Antigravity to read)
 * outbox → Feishu (Antigravity writes responses here)
 */
export class FeishuBridge {
    private config: FeishuConfig;
    private ipc: IPC;
    private larkClient: Lark.Client;
    private wsClient?: Lark.WSClient;
    private seenIds = new Set<string>();

    constructor(config: FeishuConfig, ipc: IPC) {
        this.config = config;
        this.ipc = ipc;
        this.larkClient = new Lark.Client({
            appId: config.appId,
            appSecret: config.appSecret,
            appType: Lark.AppType.SelfBuild,
            domain: Lark.Domain.Feishu,
        });
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

        // Watch outbox: when Antigravity writes a response, send it to Feishu
        this.ipc.watchOutbox(async (msg) => {
            await this.sendMessage(msg.chatId, msg.text);
        });

        console.log('[FEISHU] Connecting...');
        this.wsClient.start({ eventDispatcher });
    }

    private _handle(event: FeishuMessageEvent): void {
        const msg = event.message;
        if (!msg || msg.message_type !== 'text') return;

        // Dedup
        const msgId = msg.message_id ?? '';
        if (msgId && this.seenIds.has(msgId)) return;
        if (msgId) {
            this.seenIds.add(msgId);
            setTimeout(() => this.seenIds.delete(msgId), 60000);
        }

        const chatId = msg.chat_id;
        if (!chatId) return;

        let text = '';
        try { text = (JSON.parse(msg.content ?? '{}') as { text?: string }).text ?? ''; }
        catch { text = msg.content ?? ''; }
        text = text.trim();
        if (!text) return;

        console.log(`[FEISHU] ← "${text.slice(0, 80)}"`);

        // Write to inbox for Brain to read (history is managed by ReplyEngine)
        this.ipc.writeInbox({ chatId, text, type: 'feishu_message', from: event.sender?.sender_id?.open_id });
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
            await this.larkClient.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: {
                    receive_id: chatId,
                    msg_type: 'text',
                    content: JSON.stringify({ text }),
                },
            });
            console.log(`[FEISHU] → "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);
        } catch (err) {
            console.error('[FEISHU] Send error:', (err as Error).message);
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
}
