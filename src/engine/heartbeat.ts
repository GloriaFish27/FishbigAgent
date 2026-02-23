/**
 * Heartbeat — Proactive Timer
 *
 * Periodically pings the ReplyEngine with a heartbeat prompt.
 * The agent reads HEARTBEAT.md and decides whether to act or stay quiet.
 */
import fs from 'fs';
import path from 'path';
import { ReplyEngine } from './reply-engine.js';

export class Heartbeat {
    private timer: ReturnType<typeof setInterval> | null = null;
    private engine: ReplyEngine;
    private chatId: string;
    private intervalMs: number;
    private dataDir: string;
    private running = false;

    constructor(opts: {
        engine: ReplyEngine;
        chatId: string;
        dataDir: string;
        intervalMinutes?: number;
    }) {
        this.engine = opts.engine;
        this.chatId = opts.chatId;
        this.dataDir = opts.dataDir;
        this.intervalMs = (opts.intervalMinutes ?? 30) * 60 * 1000;
    }

    /** Start the heartbeat timer */
    start(): void {
        if (this.timer) return;
        console.log(`[HEARTBEAT] Starting — interval: ${this.intervalMs / 60000}min, chatId: ${this.chatId}`);

        this.timer = setInterval(() => {
            this._pulse();
        }, this.intervalMs);
    }

    /** Stop the heartbeat timer */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            console.log('[HEARTBEAT] Stopped');
        }
    }

    /** Send a heartbeat pulse to the engine */
    private _pulse(): void {
        if (this.running) {
            console.log('[HEARTBEAT] Skipped — previous pulse still running');
            return;
        }
        if (!this.engine.isReady) {
            console.log('[HEARTBEAT] Skipped — engine not ready');
            return;
        }

        // Check quiet hours (23:00 - 08:00)
        const hour = new Date().getHours();
        if (hour >= 23 || hour < 8) {
            console.log(`[HEARTBEAT] Skipped — quiet hours (${hour}:00)`);
            return;
        }

        this.running = true;
        console.log('[HEARTBEAT] 💓 Pulse');

        // Load heartbeat checklist
        const heartbeatPath = path.resolve(this.dataDir, '..', 'config', 'HEARTBEAT.md');
        let checklist = '';
        try {
            checklist = fs.readFileSync(heartbeatPath, 'utf-8');
        } catch {
            checklist = '没有找到 HEARTBEAT.md。检查系统状态，无事则回复 HEARTBEAT_OK。';
        }

        const prompt = [
            '💓 **心跳检查**',
            '',
            checklist,
            '',
            '如果一切正常且无需汇报，回复 HEARTBEAT_OK（不发消息）。',
            '如果有重要信息需要告知用户，直接回复内容。',
        ].join('\n');

        // Enqueue as a regular message — the engine handles the rest
        this.engine.enqueue(this.chatId, prompt);

        // Reset running flag after a generous timeout (5 min)
        setTimeout(() => { this.running = false; }, 5 * 60 * 1000);
    }
}
