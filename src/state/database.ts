/**
 * SQLite State Database
 *
 * Persistent storage for turns, tool calls, spend tracking,
 * and general KV store. Replaces JSON file storage.
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync } from 'fs';

// ─── Types ─────────────────────────────────────────────────────

export interface TurnRow {
    id: string;
    timestamp: string;
    chatId: string;
    input: string;
    thinking: string;
    inputTokens: number;
    outputTokens: number;
    costEstimate: number;
}

export interface ToolCallRow {
    id: string;
    turnId: string;
    name: string;
    args: string;
    result: string;
    error: string | null;
    durationMs: number;
}

export interface SpendRow {
    id: string;
    toolName: string;
    inputTokens: number;
    outputTokens: number;
    costEstimate: number;
    windowHour: string;
    windowDay: string;
}

export interface OpportunityRow {
    id: string;
    source: string;       // 'reddit' | 'twitter' | 'moltbook'
    url: string;
    title: string;
    body: string;
    score: number;
    feasibility: number;
    status: string;        // 'discovered' | 'evaluated' | 'acted' | 'converted' | 'skipped'
    createdAt: string;
}

// ─── Database Class ────────────────────────────────────────────

export class AgentDatabase {
    public raw: Database.Database;

    constructor(dataDir: string) {
        mkdirSync(dataDir, { recursive: true });
        const dbPath = join(dataDir, 'state.db');
        this.raw = new Database(dbPath);
        this.raw.pragma('journal_mode = WAL');
        this.raw.pragma('busy_timeout = 5000');
        this._migrate();
    }

    private _migrate(): void {
        this.raw.exec(`
            CREATE TABLE IF NOT EXISTS turns (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                input TEXT NOT NULL DEFAULT '',
                thinking TEXT NOT NULL DEFAULT '',
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cost_estimate REAL NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS tool_calls (
                id TEXT PRIMARY KEY,
                turn_id TEXT NOT NULL,
                name TEXT NOT NULL,
                args TEXT NOT NULL DEFAULT '{}',
                result TEXT NOT NULL DEFAULT '',
                error TEXT,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (turn_id) REFERENCES turns(id)
            );

            CREATE TABLE IF NOT EXISTS spend_tracking (
                id TEXT PRIMARY KEY,
                tool_name TEXT NOT NULL,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cost_estimate REAL NOT NULL DEFAULT 0,
                window_hour TEXT NOT NULL,
                window_day TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS kv_store (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS opportunities (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                url TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                body TEXT NOT NULL DEFAULT '',
                score REAL NOT NULL DEFAULT 0,
                feasibility REAL NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'discovered',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_turns_chat ON turns(chat_id);
            CREATE INDEX IF NOT EXISTS idx_turns_time ON turns(timestamp);
            CREATE INDEX IF NOT EXISTS idx_tool_calls_turn ON tool_calls(turn_id);
            CREATE INDEX IF NOT EXISTS idx_spend_hour ON spend_tracking(window_hour);
            CREATE INDEX IF NOT EXISTS idx_spend_day ON spend_tracking(window_day);
            CREATE INDEX IF NOT EXISTS idx_opp_status ON opportunities(status);
        `);
    }

    // ─── Turns ─────────────────────────────────────────────────

    insertTurn(turn: TurnRow): void {
        this.raw.prepare(`
            INSERT INTO turns (id, timestamp, chat_id, input, thinking, input_tokens, output_tokens, cost_estimate)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(turn.id, turn.timestamp, turn.chatId, turn.input, turn.thinking,
            turn.inputTokens, turn.outputTokens, turn.costEstimate);
    }

    getTurnCount(): number {
        const row = this.raw.prepare('SELECT COUNT(*) as count FROM turns').get() as { count: number };
        return row.count;
    }

    getRecentTurns(limit: number = 20): TurnRow[] {
        return this.raw.prepare(
            'SELECT * FROM turns ORDER BY timestamp DESC LIMIT ?'
        ).all(limit) as TurnRow[];
    }

    // ─── Tool Calls ────────────────────────────────────────────

    insertToolCall(tc: ToolCallRow): void {
        this.raw.prepare(`
            INSERT INTO tool_calls (id, turn_id, name, args, result, error, duration_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(tc.id, tc.turnId, tc.name, tc.args, tc.result, tc.error, tc.durationMs);
    }

    // ─── Spend ─────────────────────────────────────────────────

    insertSpend(spend: SpendRow): void {
        this.raw.prepare(`
            INSERT INTO spend_tracking (id, tool_name, input_tokens, output_tokens, cost_estimate, window_hour, window_day)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(spend.id, spend.toolName, spend.inputTokens, spend.outputTokens,
            spend.costEstimate, spend.windowHour, spend.windowDay);
    }

    getHourlySpend(hour?: string): number {
        const h = hour || new Date().toISOString().slice(0, 13);
        const row = this.raw.prepare(
            'SELECT COALESCE(SUM(cost_estimate), 0) as total FROM spend_tracking WHERE window_hour = ?'
        ).get(h) as { total: number };
        return row.total;
    }

    getDailySpend(day?: string): number {
        const d = day || new Date().toISOString().slice(0, 10);
        const row = this.raw.prepare(
            'SELECT COALESCE(SUM(cost_estimate), 0) as total FROM spend_tracking WHERE window_day = ?'
        ).get(d) as { total: number };
        return row.total;
    }

    getTotalSpend(): number {
        const row = this.raw.prepare(
            'SELECT COALESCE(SUM(cost_estimate), 0) as total FROM spend_tracking'
        ).get() as { total: number };
        return row.total;
    }

    getTotalTokens(): { input: number; output: number } {
        const row = this.raw.prepare(
            'SELECT COALESCE(SUM(input_tokens), 0) as inp, COALESCE(SUM(output_tokens), 0) as out FROM spend_tracking'
        ).get() as { inp: number; out: number };
        return { input: row.inp, output: row.out };
    }

    // ─── KV Store ──────────────────────────────────────────────

    setKV(key: string, value: string): void {
        this.raw.prepare(`
            INSERT INTO kv_store (key, value, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
        `).run(key, value);
    }

    getKV(key: string): string | null {
        const row = this.raw.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as { value: string } | undefined;
        return row?.value ?? null;
    }

    // ─── Opportunities ─────────────────────────────────────────

    insertOpportunity(opp: OpportunityRow): void {
        this.raw.prepare(`
            INSERT OR IGNORE INTO opportunities (id, source, url, title, body, score, feasibility, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(opp.id, opp.source, opp.url, opp.title, opp.body, opp.score,
            opp.feasibility, opp.status, opp.createdAt, opp.createdAt);
    }

    updateOpportunityStatus(id: string, status: string): void {
        this.raw.prepare(`
            UPDATE opportunities SET status = ?, updated_at = datetime('now') WHERE id = ?
        `).run(status, id);
    }

    getOpportunitiesByStatus(status: string, limit: number = 50): OpportunityRow[] {
        return this.raw.prepare(
            'SELECT * FROM opportunities WHERE status = ? ORDER BY created_at DESC LIMIT ?'
        ).all(status, limit) as OpportunityRow[];
    }

    // ─── Income ────────────────────────────────────────────────

    getTotalIncome(): number {
        const v = this.getKV('total_income');
        return v ? parseFloat(v) : 0;
    }

    addIncome(amount: number, source: string): void {
        const current = this.getTotalIncome();
        this.setKV('total_income', (current + amount).toFixed(4));
        this.setKV(`income_last_${Date.now()}`, JSON.stringify({ amount, source, timestamp: new Date().toISOString() }));
    }

    // ─── Stats ─────────────────────────────────────────────────

    getFinancialSummary(): {
        totalSpend: number;
        todaySpend: number;
        totalIncome: number;
        turnCount: number;
        totalTokens: { input: number; output: number };
    } {
        return {
            totalSpend: this.getTotalSpend(),
            todaySpend: this.getDailySpend(),
            totalIncome: this.getTotalIncome(),
            turnCount: this.getTurnCount(),
            totalTokens: this.getTotalTokens(),
        };
    }

    close(): void {
        this.raw.close();
    }
}
