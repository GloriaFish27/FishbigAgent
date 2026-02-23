import path from 'path';
import fs from 'fs';
import nodeCron from 'node-cron';
import { IPC } from './ipc.js';

interface CronJob {
    id: string;
    schedule: string;
    description: string;
    triggerText: string;
    chatId: string;
}

/**
 * BridgeCron — the Heartbeat of FishbigBridge.
 * Writes scheduled trigger messages to the inbox so Antigravity
 * processes them as part of its Life Cycle.
 */
export class BridgeCron {
    private ipc: IPC;
    private jobs: Map<string, nodeCron.ScheduledTask> = new Map();
    private config: CronJob[] = [];
    private configPath: string;

    constructor(ipc: IPC, configPath: string) {
        this.ipc = ipc;
        this.configPath = configPath;
        this._loadConfig();
    }

    private _loadConfig(): void {
        // Default chat ID — can be overridden by first user message
        const defaultChatId = this._getDefaultChatId();
        this.config = [
            {
                id: 'morning-briefing',
                schedule: '0 8 * * *',
                description: '每日早报',
                triggerText: '请给我一个今日简报：今天的日期、待完成目标、最近记忆摘要，以及下一步计划。',
                chatId: defaultChatId,
            },
            {
                id: 'heartbeat',
                schedule: '0 */2 * * *',
                description: '心跳检查',
                triggerText: '心跳检查：请简要确认你的状态和当前目标。',
                chatId: defaultChatId,
            },
        ];
    }

    private _getDefaultChatId(): string {
        try {
            const statePath = path.join(path.dirname(this.configPath), 'data', 'state.json');
            if (fs.existsSync(statePath)) {
                const s = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as { lastChatId?: string };
                return s.lastChatId ?? '';
            }
        } catch { /* ignore */ }
        return '';
    }

    startAll(): void {
        for (const job of this.config) {
            const task = nodeCron.schedule(job.schedule, () => {
                if (!job.chatId) {
                    console.log(`[CRON] ${job.id}: no chatId yet, skipping`);
                    return;
                }
                console.log(`[CRON] Triggering "${job.description}" → inbox`);
                this.ipc.writeInbox({
                    chatId: job.chatId,
                    text: job.triggerText,
                    type: 'cron_trigger',
                });
            });
            this.jobs.set(job.id, task);
            console.log(`[CRON] Registered "${job.id}" (${job.schedule}): ${job.description}`);
        }
    }

    /** Update the chatId for all cron jobs (called when first message arrives) */
    setChatId(chatId: string): void {
        for (const job of this.config) {
            job.chatId = chatId;
        }
        // Persist chatId
        try {
            const statePath = path.join(path.dirname(this.configPath), 'data', 'state.json');
            let state: Record<string, unknown> = {};
            if (fs.existsSync(statePath)) state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
            state['lastChatId'] = chatId;
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
        } catch { /* ignore */ }
    }

    stopAll(): void {
        for (const task of this.jobs.values()) task.stop();
        this.jobs.clear();
    }

    listJobs(): Array<{ id: string; schedule: string; description: string }> {
        return this.config.map(j => ({ id: j.id, schedule: j.schedule, description: j.description }));
    }
}
