import { chromium } from 'playwright-extra';
// @ts-ignore
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as path from 'path';

chromium.use(stealthPlugin());
const XHS_DIR = path.join(process.cwd(), 'data', '.xhs-auth');

async function test() {
    const context = await chromium.launchPersistentContext(XHS_DIR, {
        headless: false,
    });
    const page = context.pages()[0] || await context.newPage();
    const keyword = encodeURIComponent('跨境电商 temu AI');
    await page.goto(`https://www.xiaohongshu.com/search_result/?keyword=${keyword}&source=web_search_result_notes&type=51`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    const links = await page.$$eval('a[href*="/explore/"]', (anchors) =>
        anchors.map(a => {
            return { href: (a as any).href, text: (a as any).textContent?.trim() };
        })
    );
    console.log("Found links:", links.slice(0, 3));

    const handles = await page.$$('a[href*="/explore/"]');
    if (handles.length > 0) {
        console.log("Clicking the first post...");
        const [newPage] = await Promise.all([
            context.waitForEvent('page'),
            handles[0].click()
        ]);
        await newPage.waitForLoadState('domcontentloaded');
        console.log("New page url:", newPage.url());
        const title = await newPage.$eval('#detail-title', el => el.textContent?.trim()).catch(() => 'No title');
        console.log("Title on new page:", title);
        await newPage.waitForTimeout(2000);
        await newPage.close();
    }
    await context.close();
}
test().catch(console.error);
