/**
 * Conversation — manages per-chatId history + memory compaction
 *
 * - Keeps last 100 turns of raw conversation
 * - When > 100 turns: extract oldest 50 → memory.json, keep newest 50
 */
import fs from 'fs';
import path from 'path';
import { AntigravityAPI, MODELS, type ChatMessage } from './antigravity-api.js';

export interface HistoryEntry {
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
}

interface HistoryFile {
    chatId: string;
    messages: HistoryEntry[];
    totalTurns: number;
}

export interface MemoryEntry {
    id: string;
    type: 'key' | 'conclusion' | 'method' | 'url' | 'id' | 'data' | 'sensitive' | 'other';
    content: string;
    source: string;
    extractedAt: string;
}

interface MemoryFile {
    entries: MemoryEntry[];
}

const HISTORY_MAX = 100;
const COMPACT_BATCH = 50;

export class Conversation {
    private dataDir: string;
    private historyDir: string;
    private memoryPath: string;
    private api: AntigravityAPI;

    constructor(dataDir: string, api: AntigravityAPI) {
        this.dataDir = dataDir;
        this.historyDir = path.join(dataDir, 'history');
        this.memoryPath = path.join(dataDir, 'memory.json');
        fs.mkdirSync(this.historyDir, { recursive: true });
        this.api = api;
    }

    /** Load conversation history for a chat */
    load(chatId: string): HistoryEntry[] {
        const file = this._historyPath(chatId);
        if (!fs.existsSync(file)) return [];
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as HistoryFile;
            return data.messages;
        } catch { return []; }
    }

    /** Append a message and save */
    append(chatId: string, role: 'user' | 'assistant', content: string): void {
        const messages = this.load(chatId);
        messages.push({ role, content, timestamp: Date.now() });
        this._save(chatId, messages);
    }

    /** Get recent messages formatted for the API */
    getRecent(chatId: string, limit = 50): ChatMessage[] {
        const messages = this.load(chatId);
        return messages.slice(-limit).map(m => ({
            role: m.role === 'assistant' ? 'model' as const : 'user' as const,
            text: m.content,
        }));
    }

    /** Get memory entries */
    getMemory(): MemoryEntry[] {
        if (!fs.existsSync(this.memoryPath)) return [];
        try {
            const data = JSON.parse(fs.readFileSync(this.memoryPath, 'utf-8')) as MemoryFile;
            return data.entries;
        } catch { return []; }
    }

    /** Check if compaction is needed and run it */
    async maybeCompact(chatId: string): Promise<void> {
        const messages = this.load(chatId);
        if (messages.length <= HISTORY_MAX) return;

        console.log(`[CONV] History for ${chatId} has ${messages.length} turns, compacting oldest ${COMPACT_BATCH}...`);

        const oldest = messages.slice(0, COMPACT_BATCH);
        const newest = messages.slice(COMPACT_BATCH);

        // Extract key info from oldest messages
        const conversationText = oldest.map(m =>
            `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content}`
        ).join('\n');

        const extractPrompt = `从以下对话中提取所有关键信息，包括但不限于：
- 具体数据和数值
- 得出的结论
- API key、密码、凭证（标记 type 为 "sensitive"）
- 技术方法和解决方案
- 文件名、路径、URL
- ID、配置值
- 重要决策和原因

输出纯 JSON 数组，每条格式：{"type": "key|conclusion|method|url|id|data|sensitive|other", "content": "..."}
只输出 JSON，不要其他文字。`;

        try {
            const result = await this.api.complete(conversationText, extractPrompt, MODELS.compact);
            const extracted = this._parseExtraction(result);

            if (extracted.length > 0) {
                // Append to memory
                const memory = this.getMemory();
                const now = new Date().toISOString();
                for (const e of extracted) {
                    memory.push({
                        id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                        type: e.type ?? 'other',
                        content: e.content,
                        source: `conversation-${chatId}`,
                        extractedAt: now,
                    });
                }
                fs.writeFileSync(this.memoryPath, JSON.stringify({ entries: memory }, null, 2));
                console.log(`[CONV] Extracted ${extracted.length} entries → memory.json`);
            }
        } catch (err) {
            console.warn(`[CONV] Compaction LLM failed: ${(err as Error).message?.slice(0, 80)}`);
        }

        // Keep newest 50 regardless
        this._save(chatId, newest);
        console.log(`[CONV] Compacted: kept ${newest.length} recent messages`);
    }

    private _parseExtraction(raw: string): Array<{ type: MemoryEntry['type']; content: string }> {
        try {
            // Find JSON array in the response
            const match = raw.match(/\[[\s\S]*\]/);
            if (!match) return [];
            return JSON.parse(match[0]) as Array<{ type: MemoryEntry['type']; content: string }>;
        } catch { return []; }
    }

    private _historyPath(chatId: string): string {
        // Sanitize chatId for filename
        const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
        return path.join(this.historyDir, `${safe}.json`);
    }

    private _save(chatId: string, messages: HistoryEntry[]): void {
        const file = this._historyPath(chatId);
        const data: HistoryFile = { chatId, messages, totalTurns: messages.length };
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    }
}
