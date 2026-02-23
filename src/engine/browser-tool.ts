/**
 * BrowserTool — Playwright-based browser control for FishbigAgent
 *
 * Persistent session: browser stays open across multiple tool calls.
 * Agent can navigate, click, type, read content, take screenshots,
 * and analyze DOM structure with numbered interactive elements.
 *
 * P3: Smart DOM — analyze action returns structured DOM snapshot,
 * click/type support elementId and natural language target.
 */
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import type { ToolResult } from './tool-executor.js';
import fs from 'fs';
import path from 'path';

const ACTION_TIMEOUT = 30_000;
const MAX_CONTENT = 6000;
const SCREENSHOT_DIR = '/tmp';

/** Randomized User-Agent pool */
const USER_AGENTS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
];

/** Anti-bot stealth script injected into every page */
const STEALTH_SCRIPT = `
    // Override navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // Fake plugins array (real Chrome has >=3)
    Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5].map(() => ({ name: 'Plugin', filename: 'plugin.so' })),
    });

    // Fake languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'zh-CN'] });

    // Chrome runtime (missing in headless/automation)
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = { id: undefined };

    // Override permissions query
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
        window.navigator.permissions.query = (params) =>
            params.name === 'notifications'
                ? Promise.resolve({ state: 'prompt', onchange: null })
                : originalQuery.call(window.navigator.permissions, params);
    }

    // WebGL renderer spoofing
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return 'Intel Inc.';
        if (param === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter.call(this, param);
    };
`;

/** A single interactive element in the DOM snapshot */
interface DOMElement {
    id: number;
    tag: string;
    type?: string;
    text: string;
    selector: string;
    placeholder?: string;
    name?: string;
    href?: string;
    value?: string;
    ariaLabel?: string;
}

export class BrowserTool {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;

    /** Last DOM snapshot — used for elementId resolution */
    private lastSnapshot: DOMElement[] = [];

    /** Execute a browser action */
    async execute(args: Record<string, string>): Promise<ToolResult> {
        const action = args.action ?? '';

        try {
            switch (action) {
                case 'goto':
                    return await this._goto(args.url ?? '');
                case 'click':
                    return await this._click(args.selector, args.elementId, args.target);
                case 'type':
                    return await this._type(args.selector, args.text ?? '', args.elementId, args.target);
                case 'content':
                    return await this._content();
                case 'analyze':
                    return await this._analyze();
                case 'screenshot':
                    return await this._screenshot(args.selector);
                case 'wait':
                    return await this._wait(args.selector ?? '', parseInt(args.timeout ?? '10000'));
                case 'select':
                    return await this._select(args.selector ?? '', args.value ?? '');
                case 'scroll':
                    return await this._scroll(args.direction ?? 'down');
                case 'close':
                    return await this._close();
                default:
                    return { success: false, output: `Unknown browser action: ${action}. Use: goto, click, type, content, analyze, screenshot, wait, select, scroll, close` };
            }
        } catch (err) {
            const msg = (err as Error).message ?? 'Unknown error';
            return { success: false, output: `Browser error: ${msg.slice(0, 500)}` };
        }
    }

    /** Ensure browser is launched with stealth mode */
    private async _ensureBrowser(): Promise<Page> {
        if (!this.browser || !this.browser.isConnected()) {
            const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
            // Slight viewport randomization to avoid fingerprinting
            const w = 1280 + Math.floor(Math.random() * 40) - 20;
            const h = 800 + Math.floor(Math.random() * 30) - 15;

            console.log(`[BROWSER] 🥷 Launching stealth Chromium (${w}×${h})...`);
            this.browser = await chromium.launch({
                headless: false,
                args: [
                    '--no-sandbox',
                    `--window-size=${w},${h}`,
                    '--disable-blink-features=AutomationControlled',
                    '--disable-infobars',
                ],
            });
            this.context = await this.browser.newContext({
                viewport: { width: w, height: h },
                userAgent: ua,
                locale: 'en-US',
                timezoneId: 'America/New_York',
            });

            // Inject stealth scripts before any page loads
            await this.context.addInitScript(STEALTH_SCRIPT);

            // Auto-inject saved cookies (X.com, etc.)
            await this._loadSavedCookies(this.context);

            this.page = await this.context.newPage();
            this.page.setDefaultTimeout(ACTION_TIMEOUT);
            console.log(`[BROWSER] 🥷 Stealth active: webdriver=false, plugins=5, UA=${ua.slice(0, 50)}...`);
        }
        if (!this.page || this.page.isClosed()) {
            this.page = await this.context!.newPage();
        }
        return this.page;
    }

    /** Load saved cookies from ~/.config into the browser context */
    private async _loadSavedCookies(context: BrowserContext): Promise<void> {
        const homeDir = process.env.HOME || '~';

        // ── X.com cookies ──
        try {
            const xCookiePath = path.join(homeDir, '.config/xcom/cookies.json');
            const raw = fs.readFileSync(xCookiePath, 'utf-8');
            const data = JSON.parse(raw);
            if (data.auth_token && data.ct0) {
                const cookies = [
                    { name: 'auth_token', value: data.auth_token, domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' as const },
                    { name: 'ct0', value: data.ct0, domain: '.x.com', path: '/', httpOnly: false, secure: true, sameSite: 'Lax' as const },
                    { name: 'twid', value: `u=${data.user_id}`, domain: '.x.com', path: '/', httpOnly: false, secure: true, sameSite: 'None' as const },
                    { name: 'kdt', value: data.kdt, domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' as const },
                    { name: 'att', value: data.att, domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' as const },
                ];
                await context.addCookies(cookies);
                console.log(`[BROWSER] 🍪 X.com cookies loaded for @${data.username || 'unknown'}`);
            }
        } catch {
            // No X.com cookies — that's OK
        }

        // ── 小红书 cookies ──
        try {
            const xhsCookiePath = path.join(homeDir, '.config/xiaohongshu/cookies.json');
            const raw = fs.readFileSync(xhsCookiePath, 'utf-8');
            const data = JSON.parse(raw);
            if (data.a1 && data.web_session) {
                const domain = '.xiaohongshu.com';
                const cookies = [
                    { name: 'a1', value: data.a1, domain, path: '/', secure: true, sameSite: 'None' as const },
                    { name: 'web_session', value: data.web_session, domain, path: '/', secure: true, sameSite: 'None' as const },
                    { name: 'webId', value: data.webId, domain, path: '/', secure: true, sameSite: 'None' as const },
                    { name: 'gid', value: data.gid, domain, path: '/', secure: true, sameSite: 'None' as const },
                    { name: 'xsecappid', value: data.xsecappid, domain, path: '/', secure: true, sameSite: 'None' as const },
                    { name: 'acw_tc', value: data.acw_tc, domain, path: '/', secure: true, sameSite: 'None' as const },
                    { name: 'websectiga', value: data.websectiga, domain, path: '/', secure: true, sameSite: 'None' as const },
                    { name: 'sec_poison_id', value: data.sec_poison_id, domain, path: '/', secure: true, sameSite: 'None' as const },
                ];
                await context.addCookies(cookies);
                console.log('[BROWSER] 🍪 小红书 cookies loaded');
            }
        } catch {
            // No 小红书 cookies — that's OK
        }
    }

    // ── Resolve element: selector | elementId | target ────────

    /**
     * Resolve an element locator from selector, elementId, or natural language target.
     * Returns the CSS selector to use.
     */
    private _resolveSelector(selector?: string, elementId?: string, target?: string): string | null {
        // 1. Direct CSS selector
        if (selector) return selector;

        // 2. Element ID from last DOM snapshot
        if (elementId) {
            const id = parseInt(elementId);
            const el = this.lastSnapshot.find(e => e.id === id);
            if (el) {
                console.log(`[BROWSER] Resolved elementId #${id} → "${el.text}" (${el.selector})`);
                return el.selector;
            }
            return null;
        }

        // 3. Natural language target — fuzzy match against snapshot
        if (target) {
            const match = this._matchTarget(target);
            if (match) {
                console.log(`[BROWSER] Matched target "${target}" → #${match.id} "${match.text}" (${match.selector})`);
                return match.selector;
            }
            return null;
        }

        return null;
    }

    /** Fuzzy-match a natural language target against the DOM snapshot */
    private _matchTarget(target: string): DOMElement | null {
        if (this.lastSnapshot.length === 0) return null;

        const t = target.toLowerCase();

        // Score each element
        const scored = this.lastSnapshot.map(el => {
            let score = 0;
            const text = el.text.toLowerCase();
            const label = (el.ariaLabel ?? '').toLowerCase();
            const ph = (el.placeholder ?? '').toLowerCase();
            const name = (el.name ?? '').toLowerCase();

            // Exact text match (highest)
            if (text === t) score += 100;
            // Text contains target
            else if (text.includes(t)) score += 60;
            // Target contains text
            else if (t.includes(text) && text.length > 1) score += 40;

            // aria-label match
            if (label === t) score += 90;
            else if (label.includes(t)) score += 50;

            // placeholder match
            if (ph === t) score += 80;
            else if (ph.includes(t)) score += 45;

            // name match
            if (name === t) score += 70;
            else if (name.includes(t)) score += 35;

            // Tag bonus for relevant keywords
            if (t.includes('按钮') || t.includes('button')) {
                if (el.tag === 'button' || el.type === 'submit') score += 20;
            }
            if (t.includes('输入') || t.includes('input') || t.includes('搜索') || t.includes('search')) {
                if (el.tag === 'input' || el.tag === 'textarea') score += 20;
            }
            if (t.includes('链接') || t.includes('link')) {
                if (el.tag === 'a') score += 20;
            }
            if (t.includes('登录') || t.includes('login') || t.includes('sign in')) {
                if (text.includes('登录') || text.includes('login') || text.includes('sign in')) score += 30;
            }
            if (t.includes('注册') || t.includes('register') || t.includes('sign up')) {
                if (text.includes('注册') || text.includes('register') || text.includes('sign up')) score += 30;
            }

            return { el, score };
        });

        // Sort by score, take the best
        scored.sort((a, b) => b.score - a.score);
        if (scored[0]?.score > 0) return scored[0].el;
        return null;
    }

    // ── Actions ───────────────────────────────────────────────

    /** Navigate to URL */
    private async _goto(url: string): Promise<ToolResult> {
        if (!url.startsWith('http')) {
            return { success: false, output: 'URL must start with http:// or https://' };
        }
        const page = await this._ensureBrowser();
        console.log(`[BROWSER] goto: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT });
        await page.waitForTimeout(1000);

        // ── X.com cookie expiry detection ──
        const finalUrl = page.url();
        const isXcom = url.includes('x.com') || url.includes('twitter.com');
        const redirectedToLogin = finalUrl.includes('/login') || finalUrl.includes('/i/flow');
        if (isXcom && redirectedToLogin) {
            console.log('[BROWSER] ⚠️ X.com cookies expired — redirected to login');
            return {
                success: false,
                output: '⚠️ X.com COOKIE 已过期！被重定向到登录页。\n' +
                    '请通知用户：「X.com cookies 过期了，请帮我更新 cookies」\n' +
                    '用户更新后你就可以正常访问了。不要尝试手动登录。',
            };
        }

        // Auto-analyze after navigation
        const snapshot = await this._buildSnapshot(page);
        return { success: true, output: this._formatSnapshot(page, snapshot) };
    }

    /** Click an element with human-like mouse movement */
    private async _click(selector?: string, elementId?: string, target?: string): Promise<ToolResult> {
        const resolved = this._resolveSelector(selector, elementId, target);
        if (!resolved) {
            const hint = this.lastSnapshot.length > 0
                ? `\n\n可用元素:\n${this.lastSnapshot.slice(0, 15).map(e => `  #${e.id} [${e.tag}] ${e.text}`).join('\n')}`
                : '\n\n提示: 先用 analyze 获取页面元素列表';
            return { success: false, output: `无法定位元素。selector=${selector}, elementId=${elementId}, target=${target}${hint}` };
        }
        const page = await this._ensureBrowser();
        console.log(`[BROWSER] click: ${resolved}`);
        await this._humanClick(page, resolved);
        await page.waitForTimeout(300 + Math.random() * 400);
        return { success: true, output: `Clicked: ${resolved}\n${await this._getPageInfo(page)}` };
    }

    /** Type text with human-like keystroke delays */
    private async _type(selector?: string, text?: string, elementId?: string, target?: string): Promise<ToolResult> {
        const resolved = this._resolveSelector(selector, elementId, target);
        if (!resolved) {
            const hint = this.lastSnapshot.length > 0
                ? `\n\n可用输入框:\n${this.lastSnapshot.filter(e => e.tag === 'input' || e.tag === 'textarea').map(e => `  #${e.id} [${e.tag}] ${e.placeholder || e.name || e.type}`).join('\n')}`
                : '\n\n提示: 先用 analyze 获取页面元素列表';
            return { success: false, output: `无法定位输入框。selector=${selector}, elementId=${elementId}, target=${target}${hint}` };
        }
        const page = await this._ensureBrowser();
        console.log(`[BROWSER] type: ${resolved} = "${(text ?? '').slice(0, 30)}"`);
        await this._humanType(page, resolved, text ?? '');
        return { success: true, output: `Typed into ${resolved}\n${await this._getPageInfo(page)}` };
    }

    /** Read page content as text */
    private async _content(): Promise<ToolResult> {
        const page = await this._ensureBrowser();
        return { success: true, output: await this._getPageInfo(page) };
    }

    /** Analyze DOM — structured snapshot with numbered elements */
    private async _analyze(): Promise<ToolResult> {
        const page = await this._ensureBrowser();
        const snapshot = await this._buildSnapshot(page);
        return { success: true, output: this._formatSnapshot(page, snapshot) };
    }

    /** Wait for a selector */
    private async _wait(selector: string, timeout: number): Promise<ToolResult> {
        const page = await this._ensureBrowser();
        console.log(`[BROWSER] wait: ${selector}`);
        await page.waitForSelector(selector, { timeout: timeout || 10000 });
        return { success: true, output: `Found: ${selector}\n${await this._getPageInfo(page)}` };
    }

    /** Select option from dropdown */
    private async _select(selector: string, value: string): Promise<ToolResult> {
        const page = await this._ensureBrowser();
        console.log(`[BROWSER] select: ${selector} = ${value}`);
        await page.selectOption(selector, value, { timeout: ACTION_TIMEOUT });
        return { success: true, output: `Selected: ${value}\n${await this._getPageInfo(page)}` };
    }

    /** Scroll page with human-like irregular pattern */
    private async _scroll(direction: string): Promise<ToolResult> {
        const page = await this._ensureBrowser();
        const baseAmount = direction === 'up' ? -400 : 400;
        // Add random variation (±150px)
        const delta = baseAmount + Math.floor(Math.random() * 300) - 150;
        // Scroll in 2-3 small steps
        const steps = 2 + Math.floor(Math.random() * 2);
        for (let i = 0; i < steps; i++) {
            await page.mouse.wheel(0, Math.round(delta / steps));
            await page.waitForTimeout(80 + Math.random() * 120);
        }
        await page.waitForTimeout(200 + Math.random() * 200);
        return { success: true, output: await this._getPageInfo(page) };
    }

    /** Close the browser */
    private async _close(): Promise<ToolResult> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.context = null;
            this.page = null;
            this.lastSnapshot = [];
            console.log('[BROWSER] Closed');
        }
        return { success: true, output: 'Browser closed' };
    }

    /** Take a real screenshot, save to file, return path + base64 + page info */
    private async _screenshot(selector?: string): Promise<ToolResult> {
        const page = await this._ensureBrowser();
        const ts = Date.now();
        const filePath = `${SCREENSHOT_DIR}/fishbig-screenshot-${ts}.png`;

        if (selector) {
            const el = await page.$(selector);
            if (el) {
                await el.screenshot({ path: filePath });
            } else {
                return { success: false, output: `Element not found: ${selector}` };
            }
        } else {
            await page.screenshot({ path: filePath, fullPage: false });
        }

        // Read screenshot as base64 for Vision API
        const fs = await import('fs');
        const base64 = fs.default.readFileSync(filePath).toString('base64');

        console.log(`[BROWSER] Screenshot saved: ${filePath} (${Math.round(base64.length / 1024)}KB base64)`);
        const pageInfo = await this._getPageInfo(page);
        return {
            success: true,
            output: `Screenshot saved: ${filePath}\n${pageInfo}`,
            images: [base64],
        };
    }

    // ── DOM Snapshot ──────────────────────────────────────────

    /** Build a structured DOM snapshot with numbered interactive elements */
    private async _buildSnapshot(page: Page): Promise<DOMElement[]> {
        const elements = await page.evaluate(() => {
            const selectors = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [onclick]';
            const els = Array.from(document.querySelectorAll(selectors));
            const results: Array<{
                tag: string; type?: string; text: string;
                placeholder?: string; name?: string; href?: string;
                value?: string; ariaLabel?: string;
                // For building unique selector
                id?: string; classes?: string; tagIndex: number;
            }> = [];

            // Track tag counts for nth-of-type selectors
            const tagCounts = new Map<string, number>();

            for (const el of els) {
                const htmlEl = el as HTMLElement;
                // Skip hidden elements
                const style = window.getComputedStyle(htmlEl);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
                if (htmlEl.offsetWidth === 0 && htmlEl.offsetHeight === 0) continue;

                const tag = el.tagName.toLowerCase();
                const count = (tagCounts.get(tag) ?? 0) + 1;
                tagCounts.set(tag, count);

                const text = (htmlEl.textContent?.trim() ?? '').slice(0, 80).replace(/\s+/g, ' ');
                const type = el.getAttribute('type') ?? undefined;
                const placeholder = el.getAttribute('placeholder') ?? undefined;
                const name = el.getAttribute('name') ?? undefined;
                const href = tag === 'a' ? (el as HTMLAnchorElement).href?.slice(0, 100) : undefined;
                const value = (el as HTMLInputElement).value?.slice(0, 50) ?? undefined;
                const ariaLabel = el.getAttribute('aria-label') ?? undefined;
                const id = el.id || undefined;
                const classes = el.className?.toString()?.slice(0, 60) || undefined;

                results.push({
                    tag, type, text, placeholder, name, href, value, ariaLabel,
                    id, classes, tagIndex: count,
                });
            }
            return results;
        });

        // Build CSS selectors and assign IDs
        this.lastSnapshot = elements.map((el, i) => {
            let selector: string;
            if (el.id) {
                // Simple CSS ID escaping (replace special chars with backslash-escaped)
                const escapedId = el.id.replace(/([^\w-])/g, '\\\\$1');
                selector = `#${escapedId}`;
            } else if (el.name) {
                selector = `${el.tag}[name="${el.name}"]`;
            } else if (el.placeholder) {
                selector = `${el.tag}[placeholder="${el.placeholder}"]`;
            } else if (el.ariaLabel) {
                selector = `${el.tag}[aria-label="${el.ariaLabel}"]`;
            } else if (el.type && (el.tag === 'input' || el.tag === 'button')) {
                selector = `${el.tag}[type="${el.type}"]:nth-of-type(${el.tagIndex})`;
            } else if (el.text && el.text.length > 0 && el.text.length < 30) {
                // Use text selector for short, unique text
                selector = `${el.tag}:text("${el.text.slice(0, 30)}")`;
            } else {
                selector = `${el.tag}:nth-of-type(${el.tagIndex})`;
            }

            return {
                id: i + 1,
                tag: el.tag,
                type: el.type,
                text: el.text,
                selector,
                placeholder: el.placeholder,
                name: el.name,
                href: el.href,
                value: el.value,
                ariaLabel: el.ariaLabel,
            };
        });

        console.log(`[BROWSER] DOM snapshot: ${this.lastSnapshot.length} interactive elements`);
        return this.lastSnapshot;
    }

    /** Format DOM snapshot as readable text for LLM */
    private _formatSnapshot(page: Page, elements: DOMElement[]): string {
        const url = page.url();

        const lines: string[] = [
            `URL: ${url}`,
            `交互元素: ${elements.length} 个`,
            '',
            '你可以用 elementId 或 target 来操作元素:',
            '  click: {"action":"click","elementId":"3"} 或 {"action":"click","target":"登录按钮"}',
            '  type: {"action":"type","elementId":"5","text":"hello"}',
            '',
        ];

        for (const el of elements.slice(0, 50)) {
            const parts = [`#${el.id}`];

            // Tag + type
            if (el.type) parts.push(`[${el.tag}:${el.type}]`);
            else parts.push(`[${el.tag}]`);

            // Descriptive text
            if (el.text) parts.push(`"${el.text}"`);
            if (el.placeholder) parts.push(`(${el.placeholder})`);
            if (el.name) parts.push(`name=${el.name}`);
            if (el.value) parts.push(`val="${el.value}"`);
            if (el.href) parts.push(`→ ${el.href.slice(0, 50)}`);
            if (el.ariaLabel) parts.push(`[${el.ariaLabel}]`);

            lines.push(parts.join(' '));
        }

        if (elements.length > 50) {
            lines.push(`... 还有 ${elements.length - 50} 个元素`);
        }

        return lines.join('\n');
    }

    /** Get page info: URL, title, and visible text content (legacy, used by non-analyze actions) */
    private async _getPageInfo(page: Page): Promise<string> {
        const url = page.url();
        const title = await page.title();

        // Extract visible text content
        const text = await page.evaluate(() => {
            const body = document.body;
            if (!body) return '';

            const inputs = Array.from(document.querySelectorAll('input, textarea, select, button, a[href]'));
            const elements: string[] = [];

            for (const el of inputs) {
                const tag = el.tagName.toLowerCase();
                const type = el.getAttribute('type') ?? '';
                const name = el.getAttribute('name') ?? '';
                const placeholder = el.getAttribute('placeholder') ?? '';
                const text = el.textContent?.trim()?.slice(0, 50) ?? '';
                const value = (el as HTMLInputElement).value ?? '';
                const href = el.getAttribute('href') ?? '';

                if (tag === 'button' || type === 'submit') {
                    elements.push(`[button] ${text || value || name}`);
                } else if (tag === 'a') {
                    elements.push(`[link] ${text} → ${href.slice(0, 60)}`);
                } else if (tag === 'input' || tag === 'textarea') {
                    const label = placeholder || name || type;
                    elements.push(`[${type || tag}] ${label}${value ? ` = "${value.slice(0, 30)}"` : ''}`);
                } else if (tag === 'select') {
                    elements.push(`[select] ${name}`);
                }
            }

            const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
            const textParts: string[] = [];
            let node;
            while ((node = walker.nextNode())) {
                const t = node.textContent?.trim();
                if (t && t.length > 1) {
                    const parent = node.parentElement;
                    if (parent) {
                        const style = window.getComputedStyle(parent);
                        if (style.display !== 'none' && style.visibility !== 'hidden') {
                            textParts.push(t);
                        }
                    }
                }
            }

            const visibleText = textParts.join(' ').slice(0, 3000);
            const elementList = elements.slice(0, 30).join('\n');

            return `--- Visible Text ---\n${visibleText}\n\n--- Interactive Elements ---\n${elementList}`;
        });

        return [`URL: ${url}`, `Title: ${title}`, '', text.slice(0, MAX_CONTENT)].join('\n');
    }

    // ── Human-like Interaction (P4 Stealth) ────────────────────

    /** Click with human-like mouse movement to element */
    private async _humanClick(page: Page, selector: string): Promise<void> {
        const el = await page.waitForSelector(selector, { timeout: ACTION_TIMEOUT });
        if (!el) throw new Error(`Element not found: ${selector}`);

        const box = await el.boundingBox();
        if (!box) {
            // Fallback to regular click if no bounding box
            await page.click(selector, { timeout: ACTION_TIMEOUT });
            return;
        }

        // Random position within element (not dead center)
        const x = box.x + box.width * (0.3 + Math.random() * 0.4);
        const y = box.y + box.height * (0.3 + Math.random() * 0.4);

        // Move mouse with slight curve (2-4 intermediate steps)
        const steps = 2 + Math.floor(Math.random() * 3);
        await page.mouse.move(x, y, { steps });
        await page.waitForTimeout(30 + Math.random() * 70);
        await page.mouse.click(x, y);
    }

    /** Type with human-like per-character delays */
    private async _humanType(page: Page, selector: string, text: string): Promise<void> {
        const el = await page.waitForSelector(selector, { timeout: ACTION_TIMEOUT });
        if (!el) throw new Error(`Element not found: ${selector}`);

        // Click to focus first (human-like)
        await this._humanClick(page, selector);
        await page.waitForTimeout(100 + Math.random() * 100);

        // Clear existing content
        await page.keyboard.press('Meta+a');
        await page.waitForTimeout(30);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(50 + Math.random() * 50);

        // Type character by character with random delays
        for (const char of text) {
            await page.keyboard.type(char, { delay: 0 });
            // 50-180ms between keystrokes, occasionally longer pauses
            const pause = Math.random() < 0.1
                ? 200 + Math.random() * 300  // 10% chance of longer pause
                : 50 + Math.random() * 130;
            await page.waitForTimeout(pause);
        }
    }

    /** Cleanup on shutdown */
    async destroy(): Promise<void> {
        await this._close();
    }
}
