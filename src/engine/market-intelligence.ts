/**
 * Market Intelligence Engine
 *
 * Orchestrates all scanning channels (Reddit, Moltbook, X.com)
 * and uses LLM to evaluate opportunities.
 * Runs as a scheduled task via heartbeat/cron.
 */

import { scanAllSubreddits, formatScanReport, type RedditPost, type ScanResult } from '../channels/reddit-scanner.js';
import { MoltbookClient } from '../channels/moltbook-client.js';
import type { AgentDatabase, OpportunityRow } from '../state/database.js';

// ─── Types ─────────────────────────────────────────────────────

export interface Opportunity {
    id: string;
    source: 'reddit' | 'moltbook' | 'x.com' | 'manual';
    title: string;
    body: string;
    url: string;
    score: number;          // Platform score (upvotes etc)
    feasibility: number;    // LLM-assessed feasibility 0-1
    intent: 'help_request' | 'discussion' | 'complaint' | 'showcase' | 'unknown';
    matchedKeywords: string[];
    suggestedAction: string;
}

export interface IntelligenceReport {
    opportunities: Opportunity[];
    totalScanned: number;
    errors: string[];
    timestamp: string;
}

// ─── Engine ────────────────────────────────────────────────────

export class MarketIntelligenceEngine {
    private db: AgentDatabase;
    private moltbook?: MoltbookClient;

    constructor(db: AgentDatabase, moltbookApiKey?: string) {
        this.db = db;
        if (moltbookApiKey) {
            this.moltbook = new MoltbookClient(moltbookApiKey);
        }
    }

    /**
     * Run a full scan across all channels.
     */
    async runFullScan(): Promise<IntelligenceReport> {
        const opportunities: Opportunity[] = [];
        const errors: string[] = [];
        let totalScanned = 0;

        // ── Reddit Scan ──
        try {
            const redditResult = await scanAllSubreddits();
            totalScanned += redditResult.posts.length;
            errors.push(...redditResult.errors);

            for (const post of redditResult.posts) {
                const opp = this._redditToOpportunity(post);
                opportunities.push(opp);
                this._saveOpportunity(opp);
            }
        } catch (e: any) {
            errors.push(`Reddit scan failed: ${e.message}`);
        }

        // ── Moltbook Scan ──
        if (this.moltbook) {
            try {
                const moltResult = await this.moltbook.browseOpportunities();
                if (Array.isArray(moltResult)) {
                    totalScanned += moltResult.length;
                    for (const post of moltResult) {
                        opportunities.push({
                            id: `molt_${post.id || Date.now()}`,
                            source: 'moltbook',
                            title: post.title || '',
                            body: (post.content || '').slice(0, 500),
                            url: `https://moltbook.com/post/${post.id}`,
                            score: post.upvotes || 0,
                            feasibility: 0.5,
                            intent: 'unknown',
                            matchedKeywords: [],
                            suggestedAction: 'Evaluate and respond on Moltbook',
                        });
                    }
                }
            } catch (e: any) {
                errors.push(`Moltbook scan failed: ${e.message}`);
            }
        }

        // Sort by feasibility then score
        opportunities.sort((a, b) => (b.feasibility * 100 + b.score) - (a.feasibility * 100 + a.score));

        return {
            opportunities,
            totalScanned,
            errors,
            timestamp: new Date().toISOString(),
        };
    }

    /**
     * Generate a Feishu-friendly report.
     */
    formatReport(report: IntelligenceReport): string {
        if (report.opportunities.length === 0) {
            return `🔍 市场扫描完成 — 未发现新机会\n扫描帖子: ${report.totalScanned}`;
        }

        const lines: string[] = [
            `🔍 市场情报报告 — ${report.opportunities.length} 个机会发现`,
            `扫描: ${report.totalScanned} 帖子 | ${report.timestamp}`,
            '═'.repeat(30),
        ];

        // Top 5 opportunities
        for (const opp of report.opportunities.slice(0, 5)) {
            const icon = opp.source === 'reddit' ? '🔴' : opp.source === 'moltbook' ? '🟣' : '🔵';
            lines.push('');
            lines.push(`${icon} [${opp.source}] ${opp.title}`);
            lines.push(`   ⬆${opp.score} | 意图: ${opp.intent} | 可行性: ${Math.round(opp.feasibility * 100)}%`);
            if (opp.matchedKeywords.length > 0) {
                lines.push(`   关键词: ${opp.matchedKeywords.slice(0, 5).join(', ')}`);
            }
            lines.push(`   🔗 ${opp.url}`);
        }

        if (report.errors.length > 0) {
            lines.push('');
            lines.push(`⚠️ ${report.errors.length} 个错误`);
        }

        return lines.join('\n');
    }

    // ─── Private ───────────────────────────────────────────────

    private _redditToOpportunity(post: RedditPost): Opportunity {
        // Simple heuristic for intent classification
        const text = (post.title + ' ' + post.body).toLowerCase();
        let intent: Opportunity['intent'] = 'unknown';
        let feasibility = 0.3;

        if (/is there|anyone know|looking for|i need|help me|recommend/.test(text)) {
            intent = 'help_request';
            feasibility = 0.8;
        } else if (/what do you think|discuss|opinion|thoughts/.test(text)) {
            intent = 'discussion';
            feasibility = 0.4;
        } else if (/hate|frustrated|annoying|terrible|worst/.test(text)) {
            intent = 'complaint';
            feasibility = 0.6;
        } else if (/i built|i made|launched|show|my project/.test(text)) {
            intent = 'showcase';
            feasibility = 0.2;
        }

        return {
            id: `reddit_${post.id}`,
            source: 'reddit',
            title: post.title,
            body: post.body.slice(0, 500),
            url: post.url,
            score: post.score,
            feasibility,
            intent,
            matchedKeywords: post.keywordsMatched,
            suggestedAction: intent === 'help_request'
                ? '用户主动求助 — 适合提供解决方案'
                : intent === 'complaint'
                    ? '用户吐槽 — 适合共情后提供方案'
                    : '仅监控',
        };
    }

    private _saveOpportunity(opp: Opportunity): void {
        try {
            const row: OpportunityRow = {
                id: opp.id,
                source: opp.source,
                url: opp.url,
                title: opp.title,
                body: opp.body,
                score: opp.score,
                feasibility: opp.feasibility,
                status: 'discovered',
                createdAt: new Date().toISOString(),
            };
            this.db.insertOpportunity(row);
        } catch {
            // Ignore duplicate inserts
        }
    }
}
