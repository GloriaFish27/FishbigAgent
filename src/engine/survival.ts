/**
 * Survival System
 *
 * Monitors API spend and adjusts agent behavior based on
 * resource levels. When daily spend exceeds thresholds,
 * the agent enters low-compute or dead mode.
 */

import type { AgentDatabase } from '../state/database.js';

// ─── Types ─────────────────────────────────────────────────────

export type SurvivalTier = 'thriving' | 'surviving' | 'low_compute' | 'dead';

export interface ResourceStatus {
    tier: SurvivalTier;
    dailySpend: number;
    totalSpend: number;
    totalIncome: number;
    netProfit: number;
    dailyBudget: number;
    budgetUsedPct: number;
}

// ─── Config ────────────────────────────────────────────────────

const DEFAULT_DAILY_BUDGET = 5.00;  // $5/day max

const TIER_THRESHOLDS = {
    thriving: 0.50,  // < 50% of daily budget
    surviving: 0.80,  // 50-80%
    low_compute: 1.00,  // 80-100%
    dead: 1.00,  // > 100% — should stop
};

// ─── Functions ─────────────────────────────────────────────────

export function getSurvivalTier(dailySpend: number, dailyBudget: number = DEFAULT_DAILY_BUDGET): SurvivalTier {
    const ratio = dailySpend / dailyBudget;
    if (ratio > TIER_THRESHOLDS.low_compute) return 'dead';
    if (ratio > TIER_THRESHOLDS.surviving) return 'low_compute';
    if (ratio > TIER_THRESHOLDS.thriving) return 'surviving';
    return 'thriving';
}

export function checkResources(db: AgentDatabase): ResourceStatus {
    const dailySpend = db.getDailySpend();
    const totalSpend = db.getTotalSpend();
    const totalIncome = db.getTotalIncome();
    const dailyBudget = parseFloat(db.getKV('daily_budget') || String(DEFAULT_DAILY_BUDGET));
    const tier = getSurvivalTier(dailySpend, dailyBudget);

    return {
        tier,
        dailySpend,
        totalSpend,
        totalIncome,
        netProfit: totalIncome - totalSpend,
        dailyBudget,
        budgetUsedPct: Math.round((dailySpend / dailyBudget) * 100),
    };
}

export function formatResourceReport(status: ResourceStatus): string {
    const emoji = {
        thriving: '🟢',
        surviving: '🟡',
        low_compute: '🟠',
        dead: '🔴',
    };
    return [
        `═══ 生存状态 ═══`,
        `${emoji[status.tier]} 状态: ${status.tier.toUpperCase()}`,
        `💰 今日花费: $${status.dailySpend.toFixed(4)} / $${status.dailyBudget.toFixed(2)} (${status.budgetUsedPct}%)`,
        `📊 总支出: $${status.totalSpend.toFixed(4)}`,
        `💵 总收入: $${status.totalIncome.toFixed(4)}`,
        `📈 净利润: $${status.netProfit.toFixed(4)}`,
        `════════════════`,
    ].join('\n');
}

/**
 * Get system prompt modifier based on survival tier.
 * In low_compute mode, the agent should use shorter prompts.
 */
export function getPromptModifier(tier: SurvivalTier): string {
    switch (tier) {
        case 'dead':
            return '\n⚠️ [SURVIVAL: DEAD] 预算已耗尽。只保留心跳。不执行任何 LLM 调用直到明天。';
        case 'low_compute':
            return '\n⚠️ [SURVIVAL: LOW_COMPUTE] 预算已使用 >80%。请用最简洁的方式回答。避免不必要的工具调用。';
        case 'surviving':
            return '\n[SURVIVAL: SURVIVING] 预算使用中等。保持效率。';
        case 'thriving':
            return '';  // No modifier
    }
}
