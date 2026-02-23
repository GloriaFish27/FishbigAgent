/**
 * ToolExecutor — Real command execution for FishbigAgent
 *
 * Tools available to the LLM during task mode:
 *  - shell: execute bash commands
 *  - read_file: read file contents
 *  - write_file: write/create files
 *  - web_read: read any webpage as clean markdown (via Jina Reader)
 *  - web_search: search the web (via Jina Search)
 *  - github: access GitHub repos/issues/search (via gh CLI)
 *
 * Security: blocks obviously destructive commands, enforces timeouts.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BrowserTool } from './browser-tool.js';

const SHELL_TIMEOUT = 30_000; // 30s
const MAX_OUTPUT = 8000;      // truncate output to keep context manageable
const PROJECT_ROOT = path.resolve(import.meta.dirname ?? '.', '..', '..');

export interface ToolResult {
    success: boolean;
    output: string;
    /** Optional base64-encoded images (e.g. from browser screenshot) */
    images?: string[];
}

export interface ToolCall {
    tool: string;
    args: Record<string, string>;
}

/** Dangerous command patterns */
const BLOCKED_PATTERNS = [
    /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/(?!\S)/i,  // rm -rf /
    /mkfs/i,
    /dd\s+if=/i,
    />\s*\/dev\/sd/i,
    /sudo\s+rm/i,
    /chmod\s+777\s+\//i,
    /:(){ :\|:& };:/,  // fork bomb
];

export class ToolExecutor {
    private cwd: string;
    private browser: BrowserTool;

    constructor(cwd?: string) {
        this.cwd = cwd ?? PROJECT_ROOT;
        this.browser = new BrowserTool();
    }

    /** List of tools for the system prompt */
    static getToolDescriptions(): string {
        return [
            '## 可用工具',
            '',
            '你可以在回复中使用以下工具。用 <tool_call> 标签包裹 JSON：',
            '',
            '### shell — 执行 bash 命令',
            '```',
            '<tool_call>{"tool":"shell","args":{"cmd":"ls -la"}}</tool_call>',
            '```',
            '',
            '### read_file — 读取文件',
            '```',
            '<tool_call>{"tool":"read_file","args":{"path":"data/soul.json"}}</tool_call>',
            '```',
            '',
            '### write_file — 写入文件',
            '```',
            '<tool_call>{"tool":"write_file","args":{"path":"data/notes.md","content":"# Notes\\nHello"}}</tool_call>',
            '```',
            '',
            '### web_read — 读取网页（返回干净的 Markdown）',
            '```',
            '<tool_call>{"tool":"web_read","args":{"url":"https://example.com"}}</tool_call>',
            '```',
            '',
            '### web_search — 搜索网页',
            '```',
            '<tool_call>{"tool":"web_search","args":{"query":"OpenClaw AI agent framework"}}</tool_call>',
            '```',
            '',
            '### github — GitHub 操作 (仓库/issue/搜索)',
            '用法示例：',
            '```',
            '# 查看仓库 README',
            '<tool_call>{"tool":"github","args":{"action":"repo","repo":"nicekate/OpenClaw"}}</tool_call>',
            '',
            '# 搜索代码',
            '<tool_call>{"tool":"github","args":{"action":"search","query":"openclaw agent","type":"repositories"}}</tool_call>',
            '',
            '# 查看仓库文件列表',
            '<tool_call>{"tool":"github","args":{"action":"contents","repo":"nicekate/OpenClaw","path":"src"}}</tool_call>',
            '',
            '# 读取仓库文件',
            '<tool_call>{"tool":"github","args":{"action":"file","repo":"nicekate/OpenClaw","path":"README.md"}}</tool_call>',
            '',
            '# 查看 issues',
            '<tool_call>{"tool":"github","args":{"action":"issues","repo":"nicekate/OpenClaw"}}</tool_call>',
            '```',
            '',
            '### browser — 控制浏览器 (Playwright + Smart DOM)',
            '用法示例：',
            '```',
            '# 打开网页（自动分析 DOM，返回编号元素列表）',
            '<tool_call>{"tool":"browser","args":{"action":"goto","url":"https://example.com"}}</tool_call>',
            '',
            '# 分析页面 DOM（返回编号的交互元素列表）',
            '<tool_call>{"tool":"browser","args":{"action":"analyze"}}</tool_call>',
            '',
            '# 点击 — 三种方式：',
            '# 1. CSS 选择器',
            '<tool_call>{"tool":"browser","args":{"action":"click","selector":"button.submit"}}</tool_call>',
            '# 2. 元素编号（从 analyze 结果获取）',
            '<tool_call>{"tool":"browser","args":{"action":"click","elementId":"3"}}</tool_call>',
            '# 3. 自然语言描述',
            '<tool_call>{"tool":"browser","args":{"action":"click","target":"登录按钮"}}</tool_call>',
            '',
            '# 输入文字 — 同样支持 selector/elementId/target',
            '<tool_call>{"tool":"browser","args":{"action":"type","target":"邮箱输入框","text":"user@example.com"}}</tool_call>',
            '<tool_call>{"tool":"browser","args":{"action":"type","elementId":"5","text":"hello"}}</tool_call>',
            '',
            '# 截图（截图会自动传给你的视觉能力，你可以"看到"页面内容）',
            '<tool_call>{"tool":"browser","args":{"action":"screenshot"}}</tool_call>',
            '# 截图特定元素（如验证码）',
            '<tool_call>{"tool":"browser","args":{"action":"screenshot","selector":".captcha"}}</tool_call>',
            '',
            '# 其他: content, wait, select, scroll, close',
            '<tool_call>{"tool":"browser","args":{"action":"scroll","direction":"down"}}</tool_call>',
            '```',
            '',
            '**推荐工作流：** goto → analyze（查看元素列表）→ 用 elementId 或 target 操作',
            '',
            '**规则：**',
            '- 每次回复可以包含多个 tool_call',
            '- 工具执行后结果会返回给你，你可以继续使用工具',
            '- 当任务完成时，直接用文字回复最终结果（不要再加 tool_call）',
            '- shell 命令 30 秒超时',
            '- 禁止执行破坏性命令（rm -rf /, sudo rm 等）',
            `- 当前工作目录: ${PROJECT_ROOT}`,
        ].join('\n');
    }

    /** Execute a tool call */
    async execute(call: ToolCall): Promise<ToolResult> {
        switch (call.tool) {
            case 'shell':
                return this.shell(call.args.cmd ?? '');
            case 'read_file':
                return this.readFile(call.args.path ?? '');
            case 'write_file':
                return this.writeFile(call.args.path ?? '', call.args.content ?? '');
            case 'web_fetch':  // legacy alias
            case 'web_read':
                return this.webRead(call.args.url ?? '');
            case 'web_search':
                return this.webSearch(call.args.query ?? '');
            case 'github':
                return this.github(call.args);
            case 'browser':
                return this.browser.execute(call.args);
            default:
                return { success: false, output: `Unknown tool: ${call.tool}` };
        }
    }

    // ── Shell ──────────────────────────────────────────────────

    private shell(cmd: string): ToolResult {
        if (!cmd.trim()) return { success: false, output: 'Empty command' };

        for (const pattern of BLOCKED_PATTERNS) {
            if (pattern.test(cmd)) {
                return { success: false, output: `⛔ Blocked: dangerous command pattern detected` };
            }
        }

        try {
            const output = execSync(cmd, {
                encoding: 'utf-8',
                timeout: SHELL_TIMEOUT,
                cwd: this.cwd,
                maxBuffer: 1024 * 1024,
                env: { ...process.env, PAGER: 'cat' },
            });
            return { success: true, output: truncate(output, MAX_OUTPUT) };
        } catch (err) {
            const e = err as { stderr?: string; stdout?: string; message?: string };
            const combined = ((e.stdout ?? '') + '\n' + (e.stderr ?? '')).trim();
            return { success: false, output: truncate(combined || e.message || 'Command failed', MAX_OUTPUT) };
        }
    }

    // ── File I/O ──────────────────────────────────────────────

    private readFile(filePath: string): ToolResult {
        try {
            const resolved = path.resolve(this.cwd, filePath);
            const content = fs.readFileSync(resolved, 'utf-8');
            return { success: true, output: truncate(content, MAX_OUTPUT) };
        } catch (err) {
            return { success: false, output: `Failed to read: ${(err as Error).message}` };
        }
    }

    private writeFile(filePath: string, content: string): ToolResult {
        try {
            const resolved = path.resolve(this.cwd, filePath);
            const dir = path.dirname(resolved);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(resolved, content, 'utf-8');
            return { success: true, output: `Written ${content.length} bytes to ${filePath}` };
        } catch (err) {
            return { success: false, output: `Failed to write: ${(err as Error).message}` };
        }
    }

    // ── Web (Jina Reader) ─────────────────────────────────────

    /**
     * Read a web page as clean markdown via Jina Reader API
     * Much better than raw HTML scraping — handles JS rendering, anti-bot, etc.
     */
    private webRead(url: string): ToolResult {
        if (!url.startsWith('http')) {
            return { success: false, output: 'URL must start with http:// or https://' };
        }
        try {
            const output = execSync(
                `curl -sL --max-time 20 "https://r.jina.ai/${url}" -H "Accept: text/plain" -H "X-No-Cache: true"`,
                { encoding: 'utf-8', timeout: 25000, maxBuffer: 2 * 1024 * 1024 },
            );
            return { success: true, output: truncate(output, MAX_OUTPUT) };
        } catch (err) {
            return { success: false, output: `Web read failed: ${(err as Error).message?.slice(0, 200)}` };
        }
    }

    /**
     * Search the web via Jina Search API
     */
    private webSearch(query: string): ToolResult {
        if (!query.trim()) return { success: false, output: 'Empty query' };
        try {
            const encoded = encodeURIComponent(query);
            const output = execSync(
                `curl -sL --max-time 15 "https://s.jina.ai/${encoded}" -H "Accept: text/plain"`,
                { encoding: 'utf-8', timeout: 20000, maxBuffer: 2 * 1024 * 1024 },
            );
            return { success: true, output: truncate(output, MAX_OUTPUT) };
        } catch (err) {
            return { success: false, output: `Web search failed: ${(err as Error).message?.slice(0, 200)}` };
        }
    }

    // ── GitHub (gh CLI) ───────────────────────────────────────

    /**
     * GitHub operations via the gh CLI.
     * Supports: repo info, search, contents, file reading, issues.
     */
    private github(args: Record<string, string>): ToolResult {
        const action = args.action ?? 'repo';
        const repo = args.repo ?? '';

        try {
            let cmd: string;
            switch (action) {
                case 'repo':
                    // View repo info (README, description, etc.)
                    cmd = `gh repo view ${repo} 2>&1 || curl -sL "https://r.jina.ai/https://github.com/${repo}" -H "Accept: text/plain" --max-time 15`;
                    break;
                case 'search':
                    // Search repos/code/issues
                    cmd = `gh search ${args.type ?? 'repos'} "${args.query ?? ''}" -L ${args.limit ?? '10'} 2>&1`;
                    break;
                case 'contents':
                    // List files in a repo path
                    cmd = `gh api repos/${repo}/contents/${args.path ?? ''} --jq '.[].name' 2>&1 || curl -sL "https://api.github.com/repos/${repo}/contents/${args.path ?? ''}" --max-time 10 | jq -r '.[].name' 2>/dev/null`;
                    break;
                case 'file':
                    // Read a specific file from a repo
                    cmd = `curl -sL "https://raw.githubusercontent.com/${repo}/main/${args.path ?? 'README.md'}" --max-time 15 2>&1`;
                    if (!cmd.includes('HEAD') && !cmd.includes('master')) {
                        // Try main first, fall back to master
                        cmd += ` || curl -sL "https://raw.githubusercontent.com/${repo}/master/${args.path ?? 'README.md'}" --max-time 15`;
                    }
                    break;
                case 'issues':
                    cmd = `gh issue list --repo ${repo} --limit ${args.limit ?? '10'} 2>&1`;
                    break;
                default:
                    return { success: false, output: `Unknown github action: ${action}. Use: repo, search, contents, file, issues` };
            }

            const output = execSync(cmd, {
                encoding: 'utf-8',
                timeout: SHELL_TIMEOUT,
                maxBuffer: 2 * 1024 * 1024,
                env: { ...process.env, PAGER: 'cat', GH_PAGER: 'cat' },
            });
            return { success: true, output: truncate(output, MAX_OUTPUT) };
        } catch (err) {
            const e = err as { stderr?: string; stdout?: string; message?: string };
            const combined = ((e.stdout ?? '') + '\n' + (e.stderr ?? '')).trim();
            return { success: false, output: truncate(combined || e.message || 'GitHub command failed', MAX_OUTPUT) };
        }
    }
}

/** Parse tool_call tags from LLM output */
export function parseToolCalls(text: string): ToolCall[] {
    const calls: ToolCall[] = [];
    const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        try {
            const parsed = JSON.parse(match[1].trim()) as ToolCall;
            if (parsed.tool && parsed.args) {
                calls.push(parsed);
            }
        } catch {
            // Malformed JSON, skip
        }
    }
    return calls;
}

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max) + `\n... [truncated, ${text.length} total chars]`;
}
