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
import { AntigravityAPI, MODELS, type ChatMessage, type SpendCallback } from './antigravity-api.js';
import { Conversation, type MemoryEntry } from './conversation.js';
import { ToolExecutor, parseToolCalls } from './tool-executor.js';
import { SkillLoader, type Skill } from './skill-loader.js';
import { MemoryManager } from './memory-manager.js';
import { loadSoul, saveSoul, evolveSoul, type SoulModel } from './soul.js';
import type { GoogleAuth } from '../auth/google-auth.js';

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
    private processing = new Set<string>();
    /** Messages that arrive while a task is being processed — checked mid-loop */
    private interruptQueue = new Map<string, string[]>(); // prevent overlapping cycles
    private debounceMs: number;
    private skills: Skill[] = [];
    private memory: MemoryManager;

    constructor(opts: {
        dataDir: string;
        sendFn: SendFn;
        auth: GoogleAuth;
        debounceMs?: number;
        onSpend?: SpendCallback;
    }) {
        this.dataDir = opts.dataDir;
        this.sendFn = opts.sendFn;
        this.debounceMs = opts.debounceMs ?? 3000;
        this.api = new AntigravityAPI(opts.auth, opts.onSpend);
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
        // If a task is currently being processed for this chat, add to interrupt queue
        if (this.processing.has(chatId)) {
            const queue = this.interruptQueue.get(chatId) ?? [];
            queue.push(text);
            this.interruptQueue.set(chatId, queue);
            console.log(`[INTERRUPT] 📨 Message queued for mid-task injection: "${text.slice(0, 50)}"`);
            return;
        }

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

    // ── Task Mode (Smart Life Cycle) ────────────────────────────
    //
    // THINK → ACT → VERIFY → (retry or REFLECT → EVOLVE)
    //
    // - ACT: LLM-controlled exit (no hardcoded iteration limit)
    // - VERIFY: real result checking via tools
    // - Retry: max 2 re-THINKs on failure
    // - Abort: on unrecoverable/unsafe situations
    // - Safety: anti-ban, anti-violation checks throughout

    private async _taskMode(chatId: string, text: string): Promise<string> {
        const soul = loadSoul(this.dataDir);
        soul.totalCycles += 1;
        const cycle = soul.totalCycles;
        const tools = new ToolExecutor();
        const taskPrompt = this._buildSystemPrompt('task');

        await this.sendFn(chatId, `⚡ #${cycle} (Soul v${soul.version}) | THINK → ACT → VERIFY → EVOLVE`);

        const history = this.conv.getRecent(chatId, 50);
        history.push({ role: 'user', text });

        const MAX_RETRIES = 2;
        const MAX_ACT_STEPS = 15;  // safety ceiling per attempt
        const MAX_TOOL_OUTPUT = 5000;
        const MAX_CONTEXT_CHARS = 30000;

        let finalResult = '';
        let verifyResult = '';
        let plan = '';
        let aborted = false;
        const allToolStats: Record<string, number> = {};

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            // ═══════════════════════════════════════════════════
            // ── THINK ──
            // ═══════════════════════════════════════════════════
            const thinkContext = attempt === 0
                ? '你现在处于 THINK 阶段。分析用户的任务，制定执行计划。'
                : `你现在处于 THINK 阶段（第 ${attempt + 1} 次尝试）。\n上次验证失败：\n${verifyResult}\n\n请分析失败原因，制定新的执行计划。如果问题不可解决，回复 [ABORT] 并说明原因。`;

            console.log(`[LIFECYCLE] THINK (cycle ${cycle}, attempt ${attempt + 1})`);

            const rawPlan = await this.api.chat(
                attempt === 0 ? history : [...history, { role: 'model', text: `上次结果：${finalResult}\n验证：${verifyResult}` }],
                taskPrompt + `\n\n${thinkContext}\n\n⚠️ 安全规则（必须遵守）：\n- 不要做任何可能导致账号被封的操作（频繁发帖、批量操作、异常行为）\n- 不要违反平台规则（X.com、小红书、Reddit 等）\n- 如果操作涉及发帖/互动，注意频率和内容合规\n- 如果发现异常（验证码、封号提示、限流），立即停止并报告\n\n⚠️ 输出规则：\n1. 只输出编号步骤列表，每步一行\n2. 不要输出 <tool_call> 标签\n3. 总长度不超过 300 字\n4. 如果任务不可完成，回复 [ABORT] 原因`,
                MODELS.taskPrimary,
                MODELS.taskFallback,
            );

            plan = rawPlan.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();

            // Check for ABORT in plan
            if (plan.includes('[ABORT]')) {
                console.log(`[LIFECYCLE] ABORT at THINK phase`);
                finalResult = `🛑 任务中止：${plan}`;
                aborted = true;
                break;
            }

            await this.sendFn(chatId, attempt === 0
                ? `🧠 ${plan}`
                : `🔄 重新规划 (尝试 ${attempt + 1})：\n${plan}`);

            // ═══════════════════════════════════════════════════
            // ── ACT ──
            // ═══════════════════════════════════════════════════
            console.log(`[LIFECYCLE] ACT (attempt ${attempt + 1})`);
            const actMessages: ChatMessage[] = [
                ...history,
                { role: 'model', text: plan },
                { role: 'user', text: `执行你的计划。使用 <tool_call> 调用工具。\n\n重要规则：\n- 每步执行后，判断状态：\n  · 如果还有下一步 → 继续调用工具\n  · 如果全部完成 → 不加 tool_call，只回复最终结果\n  · 如果遇到阻碍（错误、验证码、限流）→ 回复 [BLOCKED] 原因\n  · 如果遇到不可恢复的问题（封号、严重错误）→ 回复 [ABORT] 原因\n- 不要盲目重试失败的操作，先分析原因\n- 涉及平台操作注意频率，不要引起风控` },
            ];

            finalResult = '';
            let actStatus: 'done' | 'blocked' | 'abort' | 'exhausted' = 'exhausted';

            for (let step = 0; step < MAX_ACT_STEPS; step++) {
                console.log(`[ACT] Step ${step + 1} (attempt ${attempt + 1})`);

                // Check for user interrupts
                const interrupts = this.interruptQueue.get(chatId);
                if (interrupts && interrupts.length > 0) {
                    const userMsg = interrupts.join('\n');
                    this.interruptQueue.delete(chatId);
                    console.log(`[INTERRUPT] ⚡ "${userMsg.slice(0, 80)}"`);
                    await this.sendFn(chatId, `⚡ 收到消息，正在调整...`);
                    actMessages.push({
                        role: 'user',
                        text: `⚠️ 【用户中途消息】"${userMsg}"\n必须立刻遵从。如果用户要求停止，回复 [ABORT] 用户终止。`,
                    });
                }

                this._trimActContext(actMessages, MAX_CONTEXT_CHARS);

                const response = await this.api.chat(
                    actMessages,
                    taskPrompt + '\n\n' + ToolExecutor.getToolDescriptions(),
                    MODELS.taskPrimary,
                    MODELS.taskFallback,
                );

                // Check for status signals
                if (response.includes('[ABORT]')) {
                    finalResult = response.replace('[ABORT]', '').trim();
                    actStatus = 'abort';
                    console.log(`[ACT] ABORT: ${finalResult.slice(0, 100)}`);
                    break;
                }
                if (response.includes('[BLOCKED]')) {
                    finalResult = response.replace('[BLOCKED]', '').trim();
                    actStatus = 'blocked';
                    console.log(`[ACT] BLOCKED: ${finalResult.slice(0, 100)}`);
                    break;
                }

                const toolCalls = parseToolCalls(response);

                if (toolCalls.length === 0) {
                    finalResult = response;
                    actStatus = 'done';
                    console.log(`[ACT] Done after ${step + 1} step(s)`);
                    break;
                }

                // Execute tools
                const toolResults: string[] = [];
                const collectedImages: string[] = [];
                for (const call of toolCalls) {
                    console.log(`[TOOL] ${call.tool}: ${JSON.stringify(call.args).slice(0, 100)}`);
                    const result = await tools.execute(call);
                    const status = result.success ? '✅' : '❌';
                    const output = result.output.length > MAX_TOOL_OUTPUT
                        ? result.output.slice(0, MAX_TOOL_OUTPUT) + `\n... [截断]`
                        : result.output;
                    toolResults.push(`[${call.tool}] ${status}\n${output}`);
                    console.log(`[TOOL] ${status} ${result.output.slice(0, 100)}`);
                    if (result.images?.length) {
                        collectedImages.push(...result.images);
                    }
                    allToolStats[call.tool] = (allToolStats[call.tool] ?? 0) + 1;
                }

                // Progress update every 5 steps
                if (step > 0 && step % 5 === 0) {
                    const summary = Object.entries(allToolStats).map(([t, n]) => `${t}×${n}`).join(', ');
                    await this.sendFn(chatId, `⚙️ [${step}] ${summary}`);
                }

                actMessages.push({ role: 'model', text: response });
                actMessages.push({
                    role: 'user',
                    text: `工具结果：\n${toolResults.join('\n\n')}\n\n判断状态：继续下一步 / 回复最终结果 / [BLOCKED] / [ABORT]`,
                    images: collectedImages.length > 0 ? collectedImages : undefined,
                });
            }

            // ═══════════════════════════════════════════════════
            // ── Handle ACT outcome ──
            // ═══════════════════════════════════════════════════
            if (actStatus === 'abort') {
                aborted = true;
                await this.sendFn(chatId, `🛑 任务中止：${finalResult}`);
                break;
            }

            if (actStatus === 'exhausted') {
                const summary = Object.entries(allToolStats).map(([t, n]) => `${t}×${n}`).join(', ');
                finalResult = `达到安全步数上限 (${MAX_ACT_STEPS})。已执行: ${summary}。`;
            }

            // ═══════════════════════════════════════════════════
            // ── VERIFY ──
            // ═══════════════════════════════════════════════════
            console.log(`[LIFECYCLE] VERIFY (attempt ${attempt + 1})`);
            verifyResult = await this.api.chat(
                [...actMessages,
                { role: 'model', text: finalResult },
                { role: 'user', text: `验证任务完成情况。\n\n原始计划：\n${plan}\n\nACT 状态：${actStatus}\n\n逐项检查，用以下格式：\n✅ 步骤N: 完成描述\n❌ 步骤N: 未完成原因\n\n最后一行输出判定：\n- [PASS] 任务完成\n- [FAIL] 部分未完成（但可重试）\n- [FATAL] 不可恢复的问题（封号/严重错误/安全风险）\n\n⚠️ 安全检查：\n- 是否触发了平台风控？\n- 是否有异常限制？\n- 操作频率是否合理？` }],
                taskPrompt,
                MODELS.chatPrimary,
                MODELS.chatFallback,
            );
            console.log(`[VERIFY] ${verifyResult.slice(0, 200)}`);

            // Parse VERIFY judgment
            if (verifyResult.includes('[PASS]') || actStatus === 'done') {
                await this.sendFn(chatId, `✅ 验证通过\n${verifyResult}`);
                break; // Success — proceed to REFLECT
            }

            if (verifyResult.includes('[FATAL]')) {
                aborted = true;
                await this.sendFn(chatId, `🛑 严重问题，终止任务\n${verifyResult}`);
                break;
            }

            // [FAIL] or BLOCKED — retry if attempts remain
            if (attempt < MAX_RETRIES) {
                await this.sendFn(chatId, `⚠️ 验证未通过，准备重试 (${attempt + 1}/${MAX_RETRIES})\n${verifyResult}`);
                // Loop continues → re-THINK
            } else {
                await this.sendFn(chatId, `❌ 已达最大重试次数\n${verifyResult}`);
            }
        }

        // ═══════════════════════════════════════════════════
        // ── REFLECT ──
        // ═══════════════════════════════════════════════════
        console.log(`[LIFECYCLE] REFLECT`);
        const reflectResult = await this.api.chat(
            [{ role: 'user', text: `任务: ${text}\n结果: ${finalResult}\n验证: ${verifyResult}\n状态: ${aborted ? 'ABORTED' : 'COMPLETED'}\n\n反思：\n1) 一句话教训\n2) 策略调整？（一句话或 null）\n3) 新能力？（名称或 null）\n4) 安全评估：本次操作是否有风控风险？\n\nJSON: {"lesson":"...","strategy_update":"...","new_capability":"...","safety_note":"..."}` }],
            taskPrompt,
            MODELS.chatPrimary,
            MODELS.chatFallback,
        );

        // ═══════════════════════════════════════════════════
        // ── EVOLVE ──
        // ═══════════════════════════════════════════════════
        console.log(`[LIFECYCLE] EVOLVE`);
        let evolveInfo = '';
        try {
            const jsonMatch = reflectResult.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                const evolved = evolveSoul(soul, {
                    lesson: parsed.lesson || undefined,
                    strategyUpdate: parsed.strategy_update || undefined,
                    newCapability: parsed.new_capability || undefined,
                    alignmentDelta: aborted ? -0.005 : 0, // slight drift on abort
                });
                saveSoul(this.dataDir, evolved);
                evolveInfo = ` | Soul v${evolved.version}`;
            } else {
                const evolved = evolveSoul(soul, { lesson: reflectResult.slice(0, 150) });
                saveSoul(this.dataDir, evolved);
                evolveInfo = ` | Soul v${evolved.version}`;
            }
        } catch {
            const evolved = evolveSoul(soul, { lesson: reflectResult.slice(0, 150) });
            saveSoul(this.dataDir, evolved);
            evolveInfo = ` | Soul v${evolved.version}`;
        }

        // Write to memory
        this.memory.writeEntry({
            task: text,
            result: finalResult,
            reflection: reflectResult,
            cycle,
        });

        const emoji = aborted ? '🛑' : '✅';
        const finalMsg = `${emoji} #${cycle}${evolveInfo}\n${finalResult}\n📋 ${verifyResult}`;
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
        const soul = loadSoul(this.dataDir);
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
            parts.push(`你是 ${soul.name} ，一个自主 AI 智能体。`);
            parts.push(`使命: ${soul.coreMission}`, '');
        }

        // ── Constitution ──
        if (constitution.laws?.length) {
            parts.push(`## Constitution (不可违反的法则)`);
            parts.push(...constitution.laws.map((l: { id: string; text: string }) => `- [${l.id}] ${l.text}`), '');
        }

        // ── Soul Strategy ──
        if (soul.strategy) {
            parts.push(`## 当前策略`, soul.strategy, '');
        }

        // ── Soul Capabilities ──
        if (soul.capabilities.length > 0) {
            parts.push(`## 能力清单`, ...soul.capabilities.map((c: string) => `- ${c}`), '');
        }

        if (soul.lessons.length > 0) {
            parts.push(`## 教训 (最近 5 条)`, ...soul.lessons.slice(-5).map((l: string) => `- ${l}`), '');
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

    // ── Constitution IO ──────────────────────────────────────────

    private _loadConstitution(): ConstitutionData {
        try {
            return JSON.parse(fs.readFileSync(path.join(this.dataDir, 'constitution.json'), 'utf-8')) as ConstitutionData;
        } catch { return { laws: [] }; }
    }
}
