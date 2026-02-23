/**
 * BrowserTool — Playwright-based browser control for FishbigAgent
 *
 * Persistent session: browser stays open across multiple tool calls.
 * Agent can navigate, click, type, read content, and take screenshots.
 */
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import type { ToolResult } from './tool-executor.js';

const ACTION_TIMEOUT = 30_000;
const MAX_CONTENT = 6000;
const SCREENSHOT_DIR = '/tmp';

export class BrowserTool {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;

    /** Execute a browser action */
    async execute(args: Record<string, string>): Promise<ToolResult> {
        const action = args.action ?? '';

        try {
            switch (action) {
                case 'goto':
                    return await this._goto(args.url ?? '');
                case 'click':
                    return await this._click(args.selector ?? '');
                case 'type':
                    return await this._type(args.selector ?? '', args.text ?? '');
                case 'content':
                    return await this._content();
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
                    return { success: false, output: `Unknown browser action: ${action}. Use: goto, click, type, content, wait, select, scroll, close` };
            }
        } catch (err) {
            const msg = (err as Error).message ?? 'Unknown error';
            return { success: false, output: `Browser error: ${msg.slice(0, 500)}` };
        }
    }

    /** Ensure browser is launched */
    private async _ensureBrowser(): Promise<Page> {
        if (!this.browser || !this.browser.isConnected()) {
            console.log('[BROWSER] Launching Chromium...');
            this.browser = await chromium.launch({
                headless: false,
                args: ['--no-sandbox', '--window-size=1280,800'],
            });
            this.context = await this.browser.newContext({
                viewport: { width: 1280, height: 800 },
                userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            });
            this.page = await this.context.newPage();
            this.page.setDefaultTimeout(ACTION_TIMEOUT);
        }
        if (!this.page || this.page.isClosed()) {
            this.page = await this.context!.newPage();
        }
        return this.page;
    }

    /** Navigate to URL */
    private async _goto(url: string): Promise<ToolResult> {
        if (!url.startsWith('http')) {
            return { success: false, output: 'URL must start with http:// or https://' };
        }
        const page = await this._ensureBrowser();
        console.log(`[BROWSER] goto: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT });
        await page.waitForTimeout(1000); // let JS render
        return { success: true, output: await this._getPageInfo(page) };
    }

    /** Click an element */
    private async _click(selector: string): Promise<ToolResult> {
        const page = await this._ensureBrowser();
        console.log(`[BROWSER] click: ${selector}`);
        await page.click(selector, { timeout: ACTION_TIMEOUT });
        await page.waitForTimeout(500);
        return { success: true, output: `Clicked: ${selector}\n${await this._getPageInfo(page)}` };
    }

    /** Type text into an element */
    private async _type(selector: string, text: string): Promise<ToolResult> {
        const page = await this._ensureBrowser();
        console.log(`[BROWSER] type: ${selector} = "${text.slice(0, 30)}"`);
        await page.fill(selector, text, { timeout: ACTION_TIMEOUT });
        return { success: true, output: `Typed into ${selector}\n${await this._getPageInfo(page)}` };
    }

    /** Read page content as text */
    private async _content(): Promise<ToolResult> {
        const page = await this._ensureBrowser();
        return { success: true, output: await this._getPageInfo(page) };
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

    /** Scroll page */
    private async _scroll(direction: string): Promise<ToolResult> {
        const page = await this._ensureBrowser();
        const delta = direction === 'up' ? -500 : 500;
        await page.mouse.wheel(0, delta);
        await page.waitForTimeout(300);
        return { success: true, output: await this._getPageInfo(page) };
    }

    /** Close the browser */
    private async _close(): Promise<ToolResult> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.context = null;
            this.page = null;
            console.log('[BROWSER] Closed');
        }
        return { success: true, output: 'Browser closed' };
    }

    /** Take a real screenshot, save to file, return path + page info */
    private async _screenshot(selector?: string): Promise<ToolResult> {
        const page = await this._ensureBrowser();
        const ts = Date.now();
        const filePath = `${SCREENSHOT_DIR}/fishbig-screenshot-${ts}.png`;

        if (selector) {
            // Screenshot a specific element
            const el = await page.$(selector);
            if (el) {
                await el.screenshot({ path: filePath });
            } else {
                return { success: false, output: `Element not found: ${selector}` };
            }
        } else {
            // Full page screenshot
            await page.screenshot({ path: filePath, fullPage: false });
        }

        console.log(`[BROWSER] Screenshot saved: ${filePath}`);
        const pageInfo = await this._getPageInfo(page);
        return {
            success: true,
            output: `Screenshot saved: ${filePath}\n${pageInfo}`,
        };
    }

    /** Get page info: URL, title, and visible text content */
    private async _getPageInfo(page: Page): Promise<string> {
        const url = page.url();
        const title = await page.title();

        // Extract visible text content
        const text = await page.evaluate(() => {
            // Get all visible text
            const body = document.body;
            if (!body) return '';

            // Get all interactive elements for context
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

            // Get visible text (limited)
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

        const parts = [
            `URL: ${url}`,
            `Title: ${title}`,
            '',
            text.slice(0, MAX_CONTENT),
        ];

        return parts.join('\n');
    }

    /** Cleanup on shutdown */
    async destroy(): Promise<void> {
        await this._close();
    }
}
