/**
 * ReplyEngine — the brain router
 *
 * Handles:
 *  1. Debounce (3s) — batch consecutive messages
 *  2. Intent classification (Chat vs Task)
 *  3. Chat mode: quick reply with Claude Sonnet / Gemini Flash
 *  4. Task mode: 6-phase Life Cycle with Claude Opus / Gemini Pro
 *  5. Conversation history management + memory compaction
 */
import fs from 'fs';
import path from 'path';
import { AntigravityAPI, MODELS, type ChatMessage } from './antigravity-api.js';
import { Conversation, type MemoryEntry } from './conversation.js';
import { ToolExecutor, parseToolCalls } from './tool-executor.js';
import { SkillLoader, type Skill } from './skill-loader.js';
import { MemoryManager } from './memory-manager.js';
import type { GoogleAuth } from '../auth/google-auth.js';

interface SoulData {
    name?: string;
    purpose?: string;
    cycle?: number;
    lessons?: string[];
    goals?: string[];
    knowledge?: Record<string, unknown>;
    evolution_log?: Array<{ event: string }>;
}

interface ConstitutionData {
    laws?: Array<{ id: string; text: string }>;
}

type SendFn = (chatId: string, text: string) => Promise<void>;

/** Pending batch of messages for debounce */
interface PendingBatch {
    chatId: string;
    texts: string[];
    timer: ReturnType<typeof setTimeout>;
}

export class ReplyEngine {
    private api: AntigravityAPI;
    private conv: Conversation;
    private dataDir: string;
    private sendFn: SendFn;
    private pending = new Map<string, PendingBatch>();
    private processing = new Set<string>(); // prevent overlapping cycles
    private debounceMs: number;
    private skills: Skill[] = [];
    private memory: MemoryManager;

    constructor(opts: {
        dataDir: string;
        sendFn: SendFn;
        auth: GoogleAuth;
        debounceMs?: number;
    }) {
        this.dataDir = opts.dataDir;
        this.sendFn = opts.sendFn;
        this.debounceMs = opts.debounceMs ?? 3000;
        this.api = new AntigravityAPI(opts.auth);
        this.conv = new Conversation(opts.dataDir, this.api);

        // Load skills from skills/ directory
        const projectRoot = path.resolve(opts.dataDir, '..');
        const loader = new SkillLoader(projectRoot);
        this.skills = loader.loadAll();

        // Initialize memory manager
        this.memory = new MemoryManager(opts.dataDir);
    }

    get isReady(): boolean { return this.api.ready; }

    /**
     * Enqueue a message from Feishu. Debounced per chatId.
     */
    enqueue(chatId: string, text: string): void {
        const existing = this.pending.get(chatId);
        if (existing) {
            existing.texts.push(text);
            clearTimeout(existing.timer);
            existing.timer = setTimeout(() => this._process(chatId), this.debounceMs);
        } else {
            this.pending.set(chatId, {
                chatId,
                texts: [text],
                timer: setTimeout(() => this._process(chatId), this.debounceMs),
            });
        }
    }

    private async _process(chatId: string): Promise<void> {
        const batch = this.pending.get(chatId);
        if (!batch) return;
        this.pending.delete(chatId);

        // Prevent overlapping processing for the same chat
        if (this.processing.has(chatId)) {
            // Re-enqueue
            for (const t of batch.texts) this.enqueue(chatId, t);
            return;
        }
        this.processing.add(chatId);

        const combinedText = batch.texts.join('\n');
        console.log(`[REPLY] Processing: "${combinedText.slice(0, 80)}" (${batch.texts.length} msg(s))`);

        try {
            // Save user message to history
            this.conv.append(chatId, 'user', combinedText);

            // Classify intent (LLM-assisted)
            const intent = await this._classify(combinedText);
            console.log(`[REPLY] Intent: ${intent}`);

            let reply: string;
            if (intent === 'task') {
                reply = await this._taskMode(chatId, combinedText);
            } else {
                reply = await this._chatMode(chatId, combinedText);
            }

            // Save assistant reply to history
            this.conv.append(chatId, 'assistant', reply);

            // HEARTBEAT_OK = silent, don't send to Feishu
            // Task replies are sent during _taskMode, so skip here
            if (reply.includes('HEARTBEAT_OK')) {
                console.log(`[REPLY] Heartbeat OK — staying quiet`);
            } else if (intent !== 'task') {
                await this.sendFn(chatId, reply);
            }

            // Check if compaction is needed (async, don't block reply)
            this.conv.maybeCompact(chatId).catch(err =>
                console.warn(`[REPLY] Compaction error: ${(err as Error).message?.slice(0, 80)}`)
            );
        } catch (err) {
            const errMsg = (err as Error).message?.slice(0, 150) ?? 'Unknown error';
            console.error(`[REPLY] Error: ${errMsg}`);
            await this.sendFn(chatId, `❌ 处理出错: ${errMsg}`);
        } finally {
            this.processing.delete(chatId);
        }
    }

    private async _classify(text: string): Promise<'chat' | 'task'> {
        // Fast-path: slash commands
        if (text.startsWith('/task ') || text.startsWith('/task\n')) return 'task';
        if (text.startsWith('/chat ') || text.startsWith('/chat\n')) return 'chat';

        // Fast-path: very short greetings → chat
        if (text.length < 5) return 'chat';

        // LLM classification using gemini-3-flash (fast + cheap)
        try {
            const result = await this.api.complete(
                text,
                [
                    '你是一个 intent 分类器。判断用户消息是「日常聊天 chat」还是「需要执行的任务 task」。',
                    '',
                    'task 的特征：',
                    '- 需要创建、修改、删除、部署、运行某个东西',
                    '- 需要分析数据、调试问题、写代码、写文档',
                    '- 需要多步骤完成的工作',
                    '- 涉及具体的项目、文件、服务、系统操作',
                    '- 用户用了"帮我"、"请"、"做一个"等指令性语言',
                    '',
                    'chat 的特征：',
                    '- 打招呼、闲聊、问候',
                    '- 问你是谁、你能做什么',
                    '- 简单的知识问答、解释概念',
                    '- 反馈确认（好的、收到、OK）',
                    '- 表达情感或观点',
                    '',
                    '只回答一个词: chat 或 task',
                ].join('\n'),
                MODELS.compact,  // gemini-3-flash
            );

            const answer = result.trim().toLowerCase();
            if (answer.includes('task')) return 'task';
            if (answer.includes('chat')) return 'chat';
            // Unparseable → default chat
            console.log(`[CLASSIFY] LLM returned ambiguous: "${answer}", defaulting to chat`);
            return 'chat';
        } catch (err) {
            console.warn(`[CLASSIFY] LLM classification failed: ${(err as Error).message?.slice(0, 80)}, falling back to regex`);
            return this._classifyFallback(text);
        }
    }

    /** Regex-based fallback if LLM classification fails */
    private _classifyFallback(text: string): 'chat' | 'task' {
        const taskPatterns = [
            /^(帮我|请帮|麻烦).*(写|创建|修改|删除|部署|运行|搭建|开发|实现|生成|制作)/,
            /^(分析|调试|Debug|排查|检查|优化|重构|迁移|升级)/i,
            /^(创建|新建|写一个|开发一个|搭建一个|实现一个)/,
            /(脚本|代码|文件|项目|服务|接口|数据库|配置).*(写|改|建|做)/,
        ];
        if (taskPatterns.some(p => p.test(text))) return 'task';
        return 'chat';
    }

    // ── Chat Mode ──────────────────────────────────────────────

    private async _chatMode(chatId: string, text: string): Promise<string> {
        const systemPrompt = this._buildSystemPrompt('chat');
        const history = this.conv.getRecent(chatId, 50);
        // Add current message at the end
        history.push({ role: 'user', text });

        return this.api.chat(history, systemPrompt, MODELS.chatPrimary, MODELS.chatFallback);
    }

    // ── Task Mode (6-Phase Life Cycle) ─────────────────────────

    private async _taskMode(chatId: string, text: string): Promise<string> {
        const soul = this._loadSoul();
        soul.cycle = (soul.cycle ?? 0) + 1;
        const tools = new ToolExecutor();

        await this.sendFn(chatId, `⚡ Life Cycle #${soul.cycle} | THINK → ACT → REFLECT`);

        const history = this.conv.getRecent(chatId, 50);
        history.push({ role: 'user', text });

        // ── THINK ──
        console.log(`[LIFECYCLE] Phase: THINK (cycle ${soul.cycle})`);
        const taskPrompt = this._buildSystemPrompt('task');

        const rawPlan = await this.api.chat(
            history,
            taskPrompt + '\n\n你现在处于 THINK 阶段。分析用户的任务，制定执行计划。\n⚠️ 输出规则：\n1. 只输出编号步骤列表，每步一行，说明要用什么工具\n2. 不要输出 <tool_call> 标签\n3. 不要写"让我试试""好的"等过渡性文字\n4. 总长度不超过 300 字',
            MODELS.taskPrimary,
            MODELS.taskFallback,
        );
        // Strip any accidental tool_call tags from THINK output
        const plan = rawPlan.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
        await this.sendFn(chatId, `🧠 ${plan}`);

        // ── ACT (tool-calling loop) ──
        console.log(`[LIFECYCLE] Phase: ACT`);
        const MAX_ITERATIONS = 25;
        const MAX_TOOL_OUTPUT = 5000;   // per-tool output limit
        const MAX_CONTEXT_CHARS = 30000; // total context size limit
        const toolStats: Record<string, number> = {}; // track tool usage
        const actMessages: ChatMessage[] = [
            ...history,
            { role: 'model', text: plan },
            { role: 'user', text: '现在执行你的计划。使用工具来完成任务。每一步用 <tool_call> 调用工具。当任务完成时，直接用文字回复最终结果（不要再加 tool_call）。' },
        ];

        let finalResult = '';
        for (let i = 0; i < MAX_ITERATIONS; i++) {
            console.log(`[ACT] Iteration ${i + 1}/${MAX_ITERATIONS}`);

            // Trim context if too large — compress older tool iterations
            this._trimActContext(actMessages, MAX_CONTEXT_CHARS);

            const response = await this.api.chat(
                actMessages,
                taskPrompt + '\n\n' + ToolExecutor.getToolDescriptions(),
                MODELS.taskPrimary,
                MODELS.taskFallback,
            );

            const toolCalls = parseToolCalls(response);

            if (toolCalls.length === 0) {
                finalResult = response;
                console.log(`[ACT] Complete after ${i + 1} iteration(s)`);
                break;
            }

            // Execute each tool call, truncate individual results
            const toolResults: string[] = [];
            for (const call of toolCalls) {
                console.log(`[TOOL] ${call.tool}: ${JSON.stringify(call.args).slice(0, 100)}`);
                const result = await tools.execute(call);
                const status = result.success ? '✅' : '❌';
                const output = result.output.length > MAX_TOOL_OUTPUT
                    ? result.output.slice(0, MAX_TOOL_OUTPUT) + `\n... [截断, 共 ${result.output.length} 字符]`
                    : result.output;
                toolResults.push(`[${call.tool}] ${status}\n${output}`);
                console.log(`[TOOL] ${status} ${result.output.slice(0, 100)}`);
            }

            // Track tool usage for progress
            for (const call of toolCalls) {
                toolStats[call.tool] = (toolStats[call.tool] ?? 0) + 1;
            }

            // Progress update every 5 iterations with tool summary
            if (i > 0 && i % 5 === 0) {
                const summary = Object.entries(toolStats).map(([t, n]) => `${t}×${n}`).join(', ');
                await this.sendFn(chatId, `⚙️ [${i}/${MAX_ITERATIONS}] ${summary}`);
            }

            // Feed results back to LLM
            actMessages.push({ role: 'model', text: response });
            actMessages.push({
                role: 'user',
                text: `工具执行结果：\n\n${toolResults.join('\n\n')}\n\n继续执行下一步，或者如果任务完成了就直接回复最终结果。`,
            });
        }

        if (!finalResult) {
            // Summarize what was done instead of a generic failure
            const summary = Object.entries(toolStats).map(([t, n]) => `${t}×${n}`).join(', ');
            finalResult = `任务在 ${MAX_ITERATIONS} 步后未完全完成。已执行: ${summary || '无'}。可能需要拆分任务或补充信息。`;
        }

        // ── REFLECT ──
        console.log(`[LIFECYCLE] Phase: REFLECT`);
        const reflectResult = await this.api.chat(
            [...actMessages, { role: 'model', text: finalResult },
            { role: 'user', text: '反思这次任务：1) 有哪些教训？2) 有哪些关键信息需要记住？简洁回答，两三句话。' }],
            taskPrompt,
            MODELS.chatPrimary,
            MODELS.chatFallback,
        );

        // ── EVOLVE ──
        console.log(`[LIFECYCLE] Phase: EVOLVE`);
        if (soul.lessons && reflectResult.length > 10) {
            soul.lessons.push(reflectResult.slice(0, 200));
            if (soul.lessons.length > 20) soul.lessons = soul.lessons.slice(-20);
        }
        this._saveSoul(soul);

        // Write to daily memory log (local file, no size limit concern)
        this.memory.writeEntry({
            task: text,
            result: finalResult,
            reflection: reflectResult,
            cycle: soul.cycle,
        });

        const finalMsg = `✅ #${soul.cycle} 完成\n${finalResult}\n📝 ${reflectResult}`;
        await this.sendFn(chatId, finalMsg);
        return finalMsg;
    }

    /**
     * Trim context window for ACT phase — collapse older tool iterations
     * to keep total text size manageable and avoid LLM timeouts.
     */
    private _trimActContext(messages: ChatMessage[], maxChars: number): void {
        const totalChars = messages.reduce((sum, m) => sum + m.text.length, 0);
        if (totalChars <= maxChars) return;

        console.log(`[CONTEXT] Trimming: ${totalChars} chars → target ${maxChars}`);

        // Find tool iteration pairs (model response with tool_calls + user tool results)
        // Keep the first few messages (history + plan + instruction) and last 2 iterations
        const KEEP_TAIL = 4; // last 2 model+user pairs
        let trimmed = 0;

        for (let i = 0; i < messages.length - KEEP_TAIL; i++) {
            const msg = messages[i];
            // Only compress large messages that look like tool results
            if (msg.text.length > 500 && (msg.text.includes('工具执行结果') || msg.text.includes('<tool_call>'))) {
                const originalLen = msg.text.length;
                // Extract key info: tool names and success/fail status
                const summary = msg.text
                    .split('\n')
                    .filter(line => line.match(/^\[[\w_]+\]\s*[✅❌]/))
                    .map(line => line.slice(0, 60))
                    .join('; ');
                messages[i] = { role: msg.role, text: `[已执行] ${summary || '(工具调用)'}` };
                trimmed += originalLen - messages[i].text.length;
            }
        }

        if (trimmed > 0) {
            const newTotal = messages.reduce((sum, m) => sum + m.text.length, 0);
            console.log(`[CONTEXT] Trimmed ${trimmed} chars → now ${newTotal}`);
        }
    }

    // ── System Prompt Builder ──────────────────────────────────

    private _buildSystemPrompt(mode: 'chat' | 'task'): string {
        const soul = this._loadSoul();
        const constitution = this._loadConstitution();

        const parts: string[] = [];

        // ── Bootstrap files (OpenClaw-style) ──
        const identity = this._readBootstrapFile('config/IDENTITY.md');
        const agents = this._readBootstrapFile('config/AGENTS.md');
        const user = this._readBootstrapFile('config/USER.md');

        if (identity) parts.push(identity, '');
        if (agents) parts.push(agents, '');
        if (user) parts.push(user, '');

        // ── Soul overrides ──
        if (!identity) {
            parts.push(`你是 ${soul.name ?? 'FishbigAgent'} 🐟，一个自主 AI 智能体。`);
            parts.push(`目标: ${soul.purpose ?? '帮助用户完成任务'}`, '');
        }

        // ── Constitution ──
        if (constitution.laws?.length) {
            parts.push(`## Constitution (不可违反的法则)`);
            parts.push(...constitution.laws.map(l => `- [${l.id}] ${l.text}`), '');
        }

        // ── Knowledge from soul ──
        if (soul.knowledge) {
            parts.push(`## 内置知识`);
            for (const [key, val] of Object.entries(soul.knowledge)) {
                parts.push(`- **${key}**: ${JSON.stringify(val)}`);
            }
            parts.push('');
        }

        if (soul.lessons?.length) {
            parts.push(`## 教训 (最近 5 条)`, ...soul.lessons.slice(-5).map(l => `- ${l}`), '');
        }

        // ── Memory: Tiered Loading (P0 + P1) ──
        const p0Prompt = this.memory.buildP0Prompt();
        if (p0Prompt) parts.push(p0Prompt, '');

        const p1Prompt = this.memory.buildP1Prompt(7);
        if (p1Prompt) parts.push(p1Prompt, '');

        // ── Shared Memory ──
        const sharedPrompt = this.memory.buildSharedPrompt();
        if (sharedPrompt) parts.push(sharedPrompt, '');

        // ── MEMORY.md (curated long-term) ──
        const longTermMemory = this._readBootstrapFile('data/MEMORY.md');
        if (longTermMemory) {
            parts.push(`## 长期记忆`, longTermMemory.slice(0, 2000), '');
        }

        // ── Conversation memory ──
        const convMemory = this.conv.getMemory();
        if (convMemory.length > 0) {
            parts.push(`## 对话记忆`, ...convMemory.slice(-10).map(m => `- [${m.type}] ${m.content}`), '');
        }

        // ── Skills ──
        const skillsPrompt = SkillLoader.buildPrompt(this.skills);
        if (skillsPrompt) parts.push(skillsPrompt);

        // ── Mode ──
        if (mode === 'chat') {
            parts.push(
                `## 模式: 日常交流`,
                `简洁、自然地回答。如果请求需要执行工具才能完成，自动切换到任务模式。`,
            );
        } else {
            parts.push(
                `## 模式: 任务执行`,
                `你有真实的工具可以使用。用工具执行任务，完成后写入记忆。`,
                '',
                `## 自我进化`,
                `你可以修改自己的配置来进化：`,
                `- 用 write_file 更新 data/MEMORY.md (长期记忆)`,
                `- 用 write_file 更新 config/HEARTBEAT.md (心跳检查清单)`,
                `- 用 write_file 创建新的 skills/<name>/SKILL.md (新技能)`,
                `- 每次任务完成后反思并记录有价值的信息`,
            );
        }

        return parts.join('\n');
    }

    /** Read a bootstrap file relative to project root */
    private _readBootstrapFile(relativePath: string): string | null {
        try {
            const projectRoot = path.resolve(this.dataDir, '..');
            return fs.readFileSync(path.join(projectRoot, relativePath), 'utf-8');
        } catch { return null; }
    }

    /** Read daily memory log (offset: 0=today, -1=yesterday) */
    private _readDailyMemory(dayOffset: number): string | null {
        try {
            const d = new Date();
            d.setDate(d.getDate() + dayOffset);
            const dateStr = d.toISOString().slice(0, 10); // YYYY-MM-DD
            const filePath = path.join(this.dataDir, 'memory', `${dateStr}.md`);
            return fs.readFileSync(filePath, 'utf-8');
        } catch { return null; }
    }

    /** Write to today's daily memory log (append) */
    private _writeDailyMemory(content: string): void {
        try {
            const dateStr = new Date().toISOString().slice(0, 10);
            const memDir = path.join(this.dataDir, 'memory');
            if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
            const filePath = path.join(memDir, `${dateStr}.md`);
            const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
            const entry = `\n## ${timestamp}\n${content}\n`;
            fs.appendFileSync(filePath, entry, 'utf-8');
            console.log(`[MEMORY] Written to ${dateStr}.md`);
        } catch (err) {
            console.error(`[MEMORY] Write failed:`, err);
        }
    }

    // ── Soul / Constitution IO ─────────────────────────────────

    private _loadSoul(): SoulData {
        try {
            return JSON.parse(fs.readFileSync(path.join(this.dataDir, 'soul.json'), 'utf-8')) as SoulData;
        } catch { return { name: 'FishbigAgent', cycle: 0, lessons: [], goals: [] }; }
    }

    private _saveSoul(soul: SoulData): void {
        fs.writeFileSync(path.join(this.dataDir, 'soul.json'), JSON.stringify(soul, null, 2));
    }

    private _loadConstitution(): ConstitutionData {
        try {
            return JSON.parse(fs.readFileSync(path.join(this.dataDir, 'constitution.json'), 'utf-8')) as ConstitutionData;
        } catch { return { laws: [] }; }
    }
}
