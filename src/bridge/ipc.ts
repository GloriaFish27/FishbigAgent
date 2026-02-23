/**
 * FishbigBridge IPC Module
 *
 * File-based inter-process communication between the Feishu bridge
 * and Antigravity (the actual AI brain).
 *
 * Inbox:  Bridge writes incoming Feishu messages here.
 * Outbox: Antigravity writes responses here; Bridge watches and sends to Feishu.
 */
import fs from 'fs';
import path from 'path';

export interface InboxMessage {
    id: string;
    from?: string;
    chatId: string;
    text: string;
    type: 'feishu_message' | 'cron_trigger' | 'system';
    timestamp: number;
    processed?: boolean;
}

export interface OutboxMessage {
    chatId: string;
    replyTo?: string;
    text: string;
    timestamp: number;
}

export class IPC {
    private inboxDir: string;
    private outboxDir: string;
    private soulDir: string;

    constructor(baseDir: string) {
        this.inboxDir = path.join(baseDir, 'inbox');
        this.outboxDir = path.join(baseDir, 'outbox');
        this.soulDir = baseDir;
        fs.mkdirSync(this.inboxDir, { recursive: true });
        fs.mkdirSync(this.outboxDir, { recursive: true });
        console.log(`[IPC] Inbox:  ${this.inboxDir}`);
        console.log(`[IPC] Outbox: ${this.outboxDir}`);
    }

    /** Write an incoming Feishu message to inbox */
    writeInbox(msg: Omit<InboxMessage, 'id' | 'timestamp'>): string {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const full: InboxMessage = { id, timestamp: Date.now(), ...msg };
        const file = path.join(this.inboxDir, `${id}.json`);
        fs.writeFileSync(file, JSON.stringify(full, null, 2));
        console.log(`[IPC] Inbox ← "${msg.text.slice(0, 50)}" (${id})`);
        return id;
    }

    /** Read all unprocessed inbox messages, sorted by timestamp */
    readInbox(): InboxMessage[] {
        return fs.readdirSync(this.inboxDir)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                try { return JSON.parse(fs.readFileSync(path.join(this.inboxDir, f), 'utf-8')) as InboxMessage; }
                catch { return null; }
            })
            .filter((m): m is InboxMessage => m !== null && !m.processed)
            .sort((a, b) => a.timestamp - b.timestamp);
    }

    /** Mark an inbox message as processed */
    markProcessed(id: string): void {
        const file = path.join(this.inboxDir, `${id}.json`);
        if (!fs.existsSync(file)) return;
        const msg = JSON.parse(fs.readFileSync(file, 'utf-8')) as InboxMessage;
        msg.processed = true;
        fs.writeFileSync(file, JSON.stringify(msg, null, 2));
    }

    /** Write a response to the outbox (Antigravity calls this) */
    writeOutbox(msg: Omit<OutboxMessage, 'timestamp'>): void {
        const full: OutboxMessage = { ...msg, timestamp: Date.now() };
        const id = `${full.timestamp}-${Math.random().toString(36).slice(2, 7)}`;
        const file = path.join(this.outboxDir, `${id}.json`);
        fs.writeFileSync(file, JSON.stringify(full, null, 2));
        console.log(`[IPC] Outbox → "${msg.text.slice(0, 50)}" (${id})`);
    }

    /**
     * Watch outbox directory for new files. When a new .json appears,
     * the callback is invoked and the file is deleted.
     */
    watchOutbox(callback: (msg: OutboxMessage) => void): void {
        // Drain any pending outbox files on startup
        this._drainOutbox(callback);

        fs.watch(this.outboxDir, (event, filename) => {
            if (event === 'rename' && filename?.endsWith('.json')) {
                setTimeout(() => this._drainOutbox(callback), 100);
            }
        });
        console.log('[IPC] Watching outbox for Antigravity responses...');
    }

    private _drainOutbox(callback: (msg: OutboxMessage) => void): void {
        const files = fs.readdirSync(this.outboxDir).filter(f => f.endsWith('.json')).sort();
        for (const f of files) {
            const file = path.join(this.outboxDir, f);
            try {
                const msg = JSON.parse(fs.readFileSync(file, 'utf-8')) as OutboxMessage;
                fs.unlinkSync(file);
                callback(msg);
            } catch { /* ignore */ }
        }
    }

    /** Get path to a soul file */
    soulPath(name: string): string {
        return path.join(this.soulDir, name);
    }
}
