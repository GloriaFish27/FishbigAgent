/**
 * History — per-chatId conversation history
 *
 * Keeps latest 100 turns. When >100, oldest 50 are saved
 * to a compaction file for Antigravity to extract into memory.json.
 */
import fs from 'fs';
import path from 'path';

export interface HistoryEntry {
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
}

interface HistoryFile {
    chatId: string;
    messages: HistoryEntry[];
}

const MAX_TURNS = 100;
const COMPACT_SIZE = 50;

export class History {
    private historyDir: string;
    private compactDir: string;

    constructor(dataDir: string) {
        this.historyDir = path.join(dataDir, 'history');
        this.compactDir = path.join(dataDir, 'compaction');
        fs.mkdirSync(this.historyDir, { recursive: true });
        fs.mkdirSync(this.compactDir, { recursive: true });
    }

    /** Append a message to conversation history */
    append(chatId: string, role: 'user' | 'assistant', content: string): void {
        const messages = this.load(chatId);
        messages.push({ role, content, timestamp: Date.now() });

        // Auto-compact if over 100 turns
        if (messages.length > MAX_TURNS) {
            const oldest = messages.slice(0, COMPACT_SIZE);
            const newest = messages.slice(COMPACT_SIZE);

            // Save oldest to compaction file for Antigravity to extract key info
            const compactFile = path.join(this.compactDir, `${this._safe(chatId)}-${Date.now()}.json`);
            fs.writeFileSync(compactFile, JSON.stringify({
                chatId,
                messages: oldest,
                needsExtraction: true,
                createdAt: new Date().toISOString(),
            }, null, 2));
            console.log(`[HISTORY] Compacted ${oldest.length} turns → ${path.basename(compactFile)}`);

            this._save(chatId, newest);
        } else {
            this._save(chatId, messages);
        }
    }

    /** Load conversation history */
    load(chatId: string): HistoryEntry[] {
        const file = path.join(this.historyDir, `${this._safe(chatId)}.json`);
        if (!fs.existsSync(file)) return [];
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as HistoryFile;
            return data.messages;
        } catch { return []; }
    }

    /** Get recent messages as formatted text for context */
    getContext(chatId: string, limit = 50): string {
        const messages = this.load(chatId).slice(-limit);
        if (messages.length === 0) return '(no history)';
        return messages.map(m =>
            `${m.role === 'user' ? '👤 User' : '🐟 Agent'}: ${m.content}`
        ).join('\n');
    }

    private _save(chatId: string, messages: HistoryEntry[]): void {
        const file = path.join(this.historyDir, `${this._safe(chatId)}.json`);
        fs.writeFileSync(file, JSON.stringify({ chatId, messages } as HistoryFile, null, 2));
    }

    private _safe(chatId: string): string {
        return chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
    }
}
