import { chromium } from 'playwright-extra';
// @ts-ignore
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';

// Apply stealth plugin
chromium.use(stealthPlugin());

const XHS_DIR = path.join(process.cwd(), 'data', '.xhs-auth');
const OUT_FILE = path.join(process.cwd(), 'data', 'temu-xhs-data.json');

async function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function scrapeXHS() {
    console.log('🐟 [XHS Scraper] Launching browser...');

    // Use persistent context to save login state locally across runs
    const context = await chromium.launchPersistentContext(XHS_DIR, {
        headless: false, // Must be false to show UI for QR code scan
        viewport: { width: 1280, height: 800 },
    });

    const page = context.pages()[0] || await context.newPage();

    console.log('🐟 [XHS Scraper] Opening Xiaohongshu...');
    await page.goto('https://www.xiaohongshu.com');

    console.log('----------------------------------------------------');
    console.log('🚨 ACTION REQUIRED 🚨');
    console.log('Please check the opened browser. IF YOU ARE NOT LOGGED IN,');
    console.log('PLEASE SCAN THE QR CODE ON SCREEN NOW!');
    console.log('You have 60 seconds to scan. After that, the script will proceed.');
    console.log('----------------------------------------------------');

    // Wait 60s for manual login / QR code scan
    await delay(60000);

    console.log('🐟 [XHS Scraper] Proceeding to search...');

    // Search for "跨境电商 temu AI"
    const keyword = encodeURIComponent('跨境电商 temu AI');
    // Using default sorting (which is highly relevant), it's more stable than clicking UI filters
    const searchUrl = `https://www.xiaohongshu.com/search_result/?keyword=${keyword}&source=web_search_result_notes&type=51`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });

    // Give time for search results to load
    await delay(5000);

    const targetPostCount = 30; // 100 might trigger severe rate limiting quickly. 30 is a safe batch for high-quality insights.
    const postLinks = new Set<string>();

    console.log(`🐟 [XHS Scraper] Scrolling to collect ${targetPostCount} highly relevant posts...`);

    let scrollAttempts = 0;
    while (scrollAttempts < 10) {
        scrollAttempts++;
        // Scroll down to load more
        await page.evaluate(() => (globalThis as any).window.scrollBy(0, 1500));
        await delay(3000); // Wait for waterfall load
        const currentCount = await page.$$eval('a.title', els => els.length);
        if (currentCount >= targetPostCount) break;
    }

    // Grab the actual element handles
    const postHandles = await page.$$('a.title');
    const maxToExtract = Math.min(targetPostCount, postHandles.length);
    console.log(`🐟 [XHS Scraper] Collected ${postHandles.length} posts. Starting extraction...`);

    const results = [];

    for (let i = 0; i < maxToExtract; i++) {
        console.log(`[${i + 1}/${maxToExtract}] Extracting post...`);

        let postPage = null;
        try {
            // Natively click the element to trigger React router/new tab correctly
            const [newPage] = await Promise.all([
                context.waitForEvent('page', { timeout: 15000 }),
                postHandles[i].click() // XHS feed cards already have target="_blank"
            ]);
            postPage = newPage;

            await postPage.waitForLoadState('domcontentloaded', { timeout: 30000 });
            await delay(4000); // let content render, XHS delays content rendering

            // Extract title
            const title = await postPage.$eval('#detail-title', el => el.textContent?.trim()).catch(() => 'No Title');

            // Extract content
            const content = await postPage.$eval('#detail-desc', el => el.textContent?.trim()).catch(() => 'No Content');

            // Extract comments (get first few comments)
            const comments = await postPage.$$eval('.comment-item .content', els =>
                els.map(el => el.textContent?.trim()).filter(text => text && text.length > 2)
            );

            // Get URL just for records
            const url = postPage.url();

            results.push({
                url,
                title,
                content,
                topComments: comments.slice(0, 5) // top 5 comments
            });

            console.log(`  -> Success: ${title ? title.substring(0, 20) + '...' : 'Untitled'} (${comments.length} comments)`);

        } catch (err: any) {
            console.log(`  -> Failed to open/extract post: ${err.message}`);
        } finally {
            if (postPage) {
                await postPage.close().catch(() => { });
            }
        }

        // Delay between views to avoid IP ban (randomized 3-6 seconds)
        await delay(3000 + Math.random() * 3000);
    }

    console.log(`🐟 [XHS Scraper] Extracted ${results.length} posts successfully.`);
    fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`🐟 [XHS Scraper] Data saved to ${OUT_FILE}`);

    await context.close();
    console.log('🐟 [XHS Scraper] Done!');
}

scrapeXHS().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
