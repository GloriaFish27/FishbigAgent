/**
 * FishbigBridge + Brain  — Entry Point
 *
 * Bridge: Feishu ↔ file IPC
 * Brain:  inbox watcher → ReplyEngine (Cloud Code API) → outbox → Feishu
 * Eyes:   Market Intelligence (Reddit + Moltbook + X.com)
 * Wallet: SpendTracker + Survival monitoring
 */
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import cron from 'node-cron';
import { IPC } from './bridge/ipc.js';
import { FeishuBridge } from './channels/feishu.js';
import { ReplyEngine } from './engine/reply-engine.js';
import { Heartbeat } from './engine/heartbeat.js';
import { GoogleAuth } from './auth/google-auth.js';
import { AgentDatabase } from './state/database.js';
import { MarketIntelligenceEngine } from './engine/market-intelligence.js';
import { checkResources, formatResourceReport } from './engine/survival.js';
import { loadSoul } from './engine/soul.js';
import config from '../config/config.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

// ── Database + Soul ──────────────────────────────────────────
const db = new AgentDatabase(DATA_DIR);
const soul = loadSoul(DATA_DIR);

// ── Moltbook API Key ─────────────────────────────────────────
const MOLTBOOK_API_KEY = (() => {
    try {
        const creds = JSON.parse(fs.readFileSync(
            path.join(process.env.HOME || '~', '.config/moltbook/credentials.json'), 'utf-8'
        ));
        return creds.api_key || '';
    } catch { return ''; }
})();

// ── Auth ──────────────────────────────────────────────────
const auth = new GoogleAuth(DATA_DIR);
const hasCredentials = auth.load();

// ── Core modules ──────────────────────────────────────────
const ipc = new IPC(DATA_DIR);
const feishu = new FeishuBridge(config.feishu, ipc, DATA_DIR);

// ── Brain (ReplyEngine) ───────────────────────────────────
const replyEngine = new ReplyEngine({
    dataDir: DATA_DIR,
    auth,
    sendFn: async (chatId: string, text: string) => {
        // Write to outbox → Bridge picks up and sends to Feishu
        ipc.writeOutbox({ chatId, text });
    },
});

// ── Market Intelligence Engine ────────────────────────────
const marketEngine = new MarketIntelligenceEngine(db, MOLTBOOK_API_KEY || undefined);

// ── Soul summary ──────────────────────────────────────────
function logSoulSummary(): void {
    console.log(`[SOUL] ${soul.name} | Purpose: ${soul.corePurpose.slice(0, 60)}`);
    const status = checkResources(db);
    console.log(`[SURVIVAL] ${formatResourceReport(status).split('\n').slice(1, 3).join(' | ')}`);
}

// ── Inbox Watcher (Brain Daemon) ──────────────────────────
let inboxPollTimer: ReturnType<typeof setInterval>;

function startInboxWatcher(): void {
    if (!replyEngine.isReady) {
        console.log('[BRAIN] ⚠️  Not logged in. Run: npm run login');
        return;
    }
    console.log('[BRAIN] 🧠 Brain daemon active — watching inbox for new messages...');

    // Poll inbox every 2 seconds
    inboxPollTimer = setInterval(() => {
        const messages = ipc.readInbox();
        for (const msg of messages) {
            if (msg.processed) continue;
            console.log(`[BRAIN] Processing: "${msg.text.slice(0, 60)}" from ${msg.chatId}`);
            ipc.markProcessed(msg.id);
            replyEngine.enqueue(msg.chatId, msg.text);
        }
    }, 2000);
}

// ── Graceful Shutdown ──────────────────────────────────────
process.on('SIGINT', () => {
    console.log('\n🐟 Shutting down...');
    if (inboxPollTimer) clearInterval(inboxPollTimer);
    heartbeat.stop();
    feishu.disconnect();
    db.close();
    process.exit(0);
});

// ── Start ──────────────────────────────────────────────────
console.log('');
console.log('🐟 FishbigBridge + Brain starting...');
console.log(`   Data: ${DATA_DIR}`);
console.log(`   Feishu: ${config.feishu.appId}`);
console.log(`   Auth: ${hasCredentials ? `✅ ${auth.email} (project: ${auth.companionProject})` : '❌ Not logged in → npm run login'}`);
logSoulSummary();
console.log('');
console.log('   📥 Feishu messages → data/inbox/ + data/history/');
console.log('   🧠 Brain reads inbox → Cloud Code API → data/outbox/');
console.log('   📤 Bridge watches outbox → sends to Feishu');
console.log('   📝 History auto-compacts at 100 turns → data/compaction/');
console.log('');

await feishu.connect();
startInboxWatcher();

// ── Heartbeat (proactive timer) ──────────────────────────
const MAIN_CHAT_ID = process.env.FEISHU_CHAT_ID || '';
const heartbeat = new Heartbeat({
    engine: replyEngine,
    chatId: MAIN_CHAT_ID,
    dataDir: DATA_DIR,
    intervalMinutes: 30,
});
heartbeat.start();

// ── Daily AI Briefing Cron (every morning 08:00 Asia/Bangkok) ──
cron.schedule('0 8 * * *', async () => {
    console.log('[BRIEFING] 📰 Running daily AI/Agent briefing...');
    try {
        const { generateDailyBriefing } = await import('./engine/daily-briefing.js');
        const docUrl = await generateDailyBriefing(MAIN_CHAT_ID);
        console.log(`[BRIEFING] ✅ Sent: ${docUrl}`);
    } catch (e: any) {
        console.error('[BRIEFING] Error:', e.message);
        ipc.writeOutbox({ chatId: MAIN_CHAT_ID, text: `❌ 每日简报生成失败: ${e.message}` });
    }
}, { timezone: 'Asia/Bangkok' });

console.log('');
console.log('🐟 FishbigAgent is running!');
console.log(`   🧠 Brain: ReplyEngine + SOUL`);
console.log(`   💓 Heartbeat: every 30min`);
console.log(`   📰 Daily briefing: 08:00 → AI/Agent/OpenClaw → 飞书文档`);
console.log(`   🦞 Moltbook: ${MOLTBOOK_API_KEY ? '✅ Connected' : '❌ No API key'}`);
console.log(`   💰 Survival: ${checkResources(db).tier.toUpperCase()}`);
console.log('');

