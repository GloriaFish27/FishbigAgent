/**
 * FishbigBridge + Brain  — Entry Point
 *
 * Bridge: Feishu ↔ file IPC
 * Brain:  inbox watcher → ReplyEngine (Cloud Code API) → outbox → Feishu
 */
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { IPC } from './bridge/ipc.js';
// History is now managed solely by ReplyEngine's Conversation module
import { FeishuBridge } from './channels/feishu.js';
import { ReplyEngine } from './engine/reply-engine.js';
import { Heartbeat } from './engine/heartbeat.js';
import { GoogleAuth } from './auth/google-auth.js';
import config from '../config/config.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

// ── Auth ──────────────────────────────────────────────────
const auth = new GoogleAuth(DATA_DIR);
const hasCredentials = auth.load();

// ── Core modules ──────────────────────────────────────────
const ipc = new IPC(DATA_DIR);
const feishu = new FeishuBridge(config.feishu, ipc);

// ── Brain (ReplyEngine) ───────────────────────────────────
const replyEngine = new ReplyEngine({
    dataDir: DATA_DIR,
    auth,
    sendFn: async (chatId: string, text: string) => {
        // Write to outbox → Bridge picks up and sends to Feishu
        ipc.writeOutbox({ chatId, text });
    },
});

// ── Soul summary ──────────────────────────────────────────
function logSoulSummary(): void {
    try {
        const soul = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'soul.json'), 'utf-8')) as {
            name?: string; cycle?: number; goals?: string[];
        };
        console.log(`[SOUL] ${soul.name} | Cycle ${soul.cycle}`);
    } catch { /* ignore */ }
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
const MAIN_CHAT_ID = 'oc_6baf1768f0cbdaf841027e2b547851f8';
const heartbeat = new Heartbeat({
    engine: replyEngine,
    chatId: MAIN_CHAT_ID,
    dataDir: DATA_DIR,
    intervalMinutes: 30,
});
heartbeat.start();

console.log('');
console.log('🐟 FishbigBridge + Brain is running!');
console.log(`   💓 Heartbeat: every 30min → ${MAIN_CHAT_ID}`);
console.log('');
