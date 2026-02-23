/**
 * MemoryManager — Tiered Context Loading (OpenViking-inspired)
 *
 * P0 (Abstract): one-sentence summary — always loaded
 * P1 (Overview): core overview — loaded for recent 7 days
 * P2 (Details): full content — loaded on demand only
 */
import fs from 'fs';
import path from 'path';

export interface MemoryEntry {
    date: string;
    cycle?: number;
    p0: string;       // one-sentence abstract
    p1: string;       // core overview (~200 chars)
    tags: string[];
    priority: 'P0' | 'P1' | 'P2';
    expires?: string;  // ISO date string
}

export interface AbstractIndex {
    entries: MemoryEntry[];
    lastUpdated: string;
}

export class MemoryManager {
    private memoryDir: string;
    private sharedDir: string;
    private archiveDir: string;

    constructor(dataDir: string) {
        this.memoryDir = path.join(dataDir, 'memory');
        this.sharedDir = path.join(dataDir, 'shared-memory');
        this.archiveDir = path.join(dataDir, 'memory', 'archive');
    }

    // ── P0: Abstract Index ──────────────────────────────────

    /** Load the .abstract index — minimal P0 summaries */
    loadP0(): MemoryEntry[] {
        const index = this._loadIndex(this.memoryDir);
        return index.entries;
    }

    /** Build system prompt from P0 entries (minimal tokens) */
    buildP0Prompt(): string {
        const entries = this.loadP0();
        if (entries.length === 0) return '';

        const lines = ['## 记忆索引 (P0)'];
        for (const e of entries.slice(-20)) {
            const tag = e.tags.length > 0 ? ` [${e.tags.join(',')}]` : '';
            lines.push(`- [${e.date}] [${e.priority}]${tag} ${e.p0}`);
        }
        return lines.join('\n');
    }

    // ── P1: Overview ────────────────────────────────────────

    /** Load P1 (overview) for recent N days */
    buildP1Prompt(days: number = 7): string {
        const entries = this.loadP0();
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);

        const recent = entries.filter(e => new Date(e.date) >= cutoff);
        if (recent.length === 0) return '';

        const lines = ['## 近期记忆 (P1)'];
        for (const e of recent) {
            lines.push(`### ${e.date} [${e.priority}]`);
            lines.push(e.p1);
            lines.push('');
        }
        return lines.join('\n');
    }

    // ── P2: Full Content ────────────────────────────────────

    /** Load P2 (full file) for a specific date */
    loadP2(date: string): string | null {
        try {
            return fs.readFileSync(path.join(this.memoryDir, `${date}.md`), 'utf-8');
        } catch { return null; }
    }

    // ── Shared Memory ───────────────────────────────────────

    /** Load shared memory for system prompt */
    buildSharedPrompt(): string {
        if (!fs.existsSync(this.sharedDir)) return '';

        const parts = ['## 共享记忆'];
        const files = fs.readdirSync(this.sharedDir).filter(f => f.endsWith('.md'));

        for (const file of files) {
            try {
                const content = fs.readFileSync(path.join(this.sharedDir, file), 'utf-8');
                parts.push(`### ${file.replace('.md', '')}`);
                parts.push(content.slice(0, 1000));
                parts.push('');
            } catch { /* skip */ }
        }

        return parts.length > 1 ? parts.join('\n') : '';
    }

    // ── Write Entry ─────────────────────────────────────────

    /** Write a memory entry with automatic P0/P1 generation and index update */
    writeEntry(opts: {
        task: string;
        result: string;
        reflection: string;
        cycle?: number;
        priority?: 'P0' | 'P1' | 'P2';
        tags?: string[];
    }): void {
        const dateStr = new Date().toISOString().slice(0, 10);
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });

        // Ensure memory directory exists
        if (!fs.existsSync(this.memoryDir)) {
            fs.mkdirSync(this.memoryDir, { recursive: true });
        }

        // Write P2 (full content) to daily file
        const p2Path = path.join(this.memoryDir, `${dateStr}.md`);
        const p2Content = [
            `\n## ${timestamp}`,
            `### Cycle #${opts.cycle ?? '?'}`,
            `**任务**: ${opts.task.slice(0, 2000)}`,
            `**结果**: ${opts.result.slice(0, 2000)}`,
            `**反思**: ${opts.reflection.slice(0, 2000)}`,
            '',
        ].join('\n');
        fs.appendFileSync(p2Path, p2Content, 'utf-8');

        // Generate P0 and P1
        const p0 = this._generateP0(opts.task, opts.result);
        const p1 = this._generateP1(opts.task, opts.result, opts.reflection);

        // Determine expiry based on priority
        const priority = opts.priority ?? this._autoPriority(opts.reflection);
        const expiresDate = new Date();
        switch (priority) {
            case 'P0': break; // permanent
            case 'P1': expiresDate.setDate(expiresDate.getDate() + 30); break;
            case 'P2': expiresDate.setDate(expiresDate.getDate() + 7); break;
        }

        // Update .abstract index
        const entry: MemoryEntry = {
            date: dateStr,
            cycle: opts.cycle,
            p0,
            p1,
            tags: opts.tags ?? this._autoTags(opts.task + ' ' + opts.result),
            priority,
            expires: priority === 'P0' ? undefined : expiresDate.toISOString().slice(0, 10),
        };
        this._updateIndex(this.memoryDir, entry);

        console.log(`[MEMORY] Written: ${dateStr} [${priority}] ${p0.slice(0, 60)}`);
    }

    // ── Archive ─────────────────────────────────────────────

    /** Archive expired memory entries */
    archiveExpired(): { archived: number; remaining: number } {
        const index = this._loadIndex(this.memoryDir);
        const today = new Date().toISOString().slice(0, 10);

        if (!fs.existsSync(this.archiveDir)) {
            fs.mkdirSync(this.archiveDir, { recursive: true });
        }

        const active: MemoryEntry[] = [];
        let archived = 0;

        for (const entry of index.entries) {
            if (entry.expires && entry.expires < today) {
                // Move P2 file to archive
                const src = path.join(this.memoryDir, `${entry.date}.md`);
                const dst = path.join(this.archiveDir, `${entry.date}.md`);
                if (fs.existsSync(src) && !fs.existsSync(dst)) {
                    fs.renameSync(src, dst);
                }
                archived++;
            } else {
                active.push(entry);
            }
        }

        // Update index
        this._saveIndex(this.memoryDir, { entries: active, lastUpdated: today });

        // Also save archived entries separately
        if (archived > 0) {
            const archivedIndex = this._loadIndex(this.archiveDir);
            const expired = index.entries.filter(e => e.expires && e.expires < today);
            archivedIndex.entries.push(...expired);
            archivedIndex.lastUpdated = today;
            this._saveIndex(this.archiveDir, archivedIndex);
        }

        return { archived, remaining: active.length };
    }

    // ── Private Helpers ─────────────────────────────────────

    /** Load .abstract index file */
    private _loadIndex(dir: string): AbstractIndex {
        try {
            const raw = fs.readFileSync(path.join(dir, '.abstract'), 'utf-8');
            return JSON.parse(raw) as AbstractIndex;
        } catch {
            return { entries: [], lastUpdated: '' };
        }
    }

    /** Save .abstract index file */
    private _saveIndex(dir: string, index: AbstractIndex): void {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '.abstract'), JSON.stringify(index, null, 2), 'utf-8');
    }

    /** Update index with new entry (merge by date) */
    private _updateIndex(dir: string, entry: MemoryEntry): void {
        const index = this._loadIndex(dir);

        // Check if we already have an entry for this date — append or merge
        const existing = index.entries.find(e => e.date === entry.date);
        if (existing) {
            // Update P0 to the latest
            existing.p0 = entry.p0;
            existing.p1 = `${existing.p1}\n${entry.p1}`.slice(0, 500);
            existing.cycle = entry.cycle;
            // Merge tags
            const tagSet = new Set([...existing.tags, ...entry.tags]);
            existing.tags = [...tagSet];
            // Keep the higher priority
            if (this._priorityRank(entry.priority) < this._priorityRank(existing.priority)) {
                existing.priority = entry.priority;
            }
        } else {
            index.entries.push(entry);
        }

        index.lastUpdated = new Date().toISOString().slice(0, 10);
        this._saveIndex(dir, index);
    }

    private _priorityRank(p: string): number {
        return p === 'P0' ? 0 : p === 'P1' ? 1 : 2;
    }

    /** Auto-generate P0 (one-sentence abstract) */
    private _generateP0(task: string, result: string): string {
        // Extract first meaningful line from task + result
        const taskClean = task.replace(/\n/g, ' ').slice(0, 100);
        const resultFirst = result.split('\n').find(l => l.trim().length > 10) ?? result.slice(0, 100);
        return `${taskClean} → ${resultFirst.replace(/\n/g, ' ').slice(0, 100)}`;
    }

    /** Auto-generate P1 (core overview) */
    private _generateP1(task: string, result: string, reflection: string): string {
        return [
            `任务: ${task.slice(0, 200).replace(/\n/g, ' ')}`,
            `结果: ${result.slice(0, 200).replace(/\n/g, ' ')}`,
            `反思: ${reflection.slice(0, 100).replace(/\n/g, ' ')}`,
        ].join('\n');
    }

    /** Auto-determine priority based on content */
    private _autoPriority(reflection: string): 'P0' | 'P1' | 'P2' {
        const text = reflection.toLowerCase();
        if (text.includes('教训') || text.includes('关键') || text.includes('重要') || text.includes('永远')) {
            return 'P0'; // lesson learned → permanent
        }
        if (text.includes('结果') || text.includes('发现') || text.includes('完成')) {
            return 'P1'; // task result → keep 30 days
        }
        return 'P2'; // routine → keep 7 days
    }

    /** Auto-extract tags from text */
    private _autoTags(text: string): string[] {
        const tags: string[] = [];
        const keywords: Record<string, string> = {
            'github': 'github', 'web': 'web', '爬虫': 'crawler',
            '小红书': 'xiaohongshu', 'feishu': 'feishu', '飞书': 'feishu',
            'api': 'api', '代码': 'code', '研究': 'research',
            '记忆': 'memory', '配置': 'config', 'bug': 'bug',
            '教训': 'lesson', '安全': 'security',
        };
        const lower = text.toLowerCase();
        for (const [key, tag] of Object.entries(keywords)) {
            if (lower.includes(key)) tags.push(tag);
        }
        return tags.slice(0, 5);
    }
}
