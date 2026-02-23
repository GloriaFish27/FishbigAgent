/**
 * Spend Tracker
 *
 * Records every LLM call's token usage and estimated cost.
 * Provides hourly/daily aggregation for survival monitoring.
 */

import type { AgentDatabase, SpendRow } from '../state/database.js';

// ─── Cost Estimation ───────────────────────────────────────────

// Gemini 2.0 Flash pricing (approximate)
const COST_PER_INPUT_TOKEN = 0.000001;   // $0.001 / 1K tokens
const COST_PER_OUTPUT_TOKEN = 0.000004;  // $0.004 / 1K tokens

export function estimateCost(inputTokens: number, outputTokens: number): number {
    return (inputTokens * COST_PER_INPUT_TOKEN) + (outputTokens * COST_PER_OUTPUT_TOKEN);
}

// ─── Spend Tracker ─────────────────────────────────────────────

let _idCounter = 0;

function genId(): string {
    return `sp_${Date.now()}_${++_idCounter}`;
}

export class SpendTracker {
    private db: AgentDatabase;

    constructor(db: AgentDatabase) {
        this.db = db;
    }

    /**
     * Record a spend event (called after every LLM call).
     */
    recordSpend(toolName: string, inputTokens: number, outputTokens: number): void {
        const now = new Date();
        const spend: SpendRow = {
            id: genId(),
            toolName,
            inputTokens,
            outputTokens,
            costEstimate: estimateCost(inputTokens, outputTokens),
            windowHour: now.toISOString().slice(0, 13),
            windowDay: now.toISOString().slice(0, 10),
        };
        this.db.insertSpend(spend);
    }

    getHourlySpend(): number {
        return this.db.getHourlySpend();
    }

    getDailySpend(): number {
        return this.db.getDailySpend();
    }

    getTotalSpend(): number {
        return this.db.getTotalSpend();
    }

    getSummary(): string {
        const tokens = this.db.getTotalTokens();
        return [
            `今日花费: $${this.getDailySpend().toFixed(4)}`,
            `总花费: $${this.getTotalSpend().toFixed(4)}`,
            `总 Token: ${tokens.input.toLocaleString()} in / ${tokens.output.toLocaleString()} out`,
        ].join(' | ');
    }
}
