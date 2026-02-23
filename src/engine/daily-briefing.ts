/**
 * Daily Briefing Engine v2 — Deep Analysis Blog
 *
 * Pipeline:
 * Phase 1: Collect raw data (Reddit + X.com)
 * Phase 2: Fetch full article content (Jina Reader)
 * Phase 3: LLM deep analysis (Claude Opus → translate + analyze + blog)
 * Phase 4: Generate beautiful 飞书文档 with blog format
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { scanAllSubreddits, searchReddit } from '../channels/reddit-scanner.js';
import { fetchFollowingTimeline } from '../channels/x-feed-reader.js';
import { fetchArticlesBatch, type ArticleContent } from '../utils/article-fetcher.js';
import { generateTopicLibrary } from './topic-generator.js';
import { AntigravityAPI, MODELS } from './antigravity-api.js';
import { GoogleAuth } from '../auth/google-auth.js';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../../config/config.json' with { type: 'json' };
import sourcesConfig from '../../config/sources.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

// ─── Types ─────────────────────────────────────────────────────

interface RawItem {
    title: string;
    summary: string;
    url: string;
    score: number;
    source: string;
    fullContent?: string;
    imageUrls?: string[];
}

interface BlogSection {
    heading: string;
    analysis: string;
    sources: Array<{ title: string; url: string }>;
    image_url?: string;
}

interface BlogBriefing {
    title: string;
    date: string;
    intro: string;
    sections: BlogSection[];
    conclusion: string;
    key_insights: string[];
}

// ─── Feishu Helpers ────────────────────────────────────────────

function getFeishuClient(): lark.Client {
    return new lark.Client({
        appId: config.feishu.appId,
        appSecret: config.feishu.appSecret,
    });
}

async function getFeishuToken(): Promise<string> {
    const res = await fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: config.feishu.appId, app_secret: config.feishu.appSecret }),
    });
    const json = await res.json() as { tenant_access_token?: string };
    if (!json.tenant_access_token) throw new Error('Failed to get Feishu access token');
    return json.tenant_access_token;
}

// ─── Phase 1: Data Collection ──────────────────────────────────

async function collectAllData(): Promise<RawItem[]> {
    const items: RawItem[] = [];

    // --- Reddit: Priority 1 — scan core subreddits (config-driven) ---
    try {
        const scanResult = await scanAllSubreddits(undefined, 20);
        for (const p of scanResult.posts.slice(0, 15)) {
            items.push({
                title: p.title,
                summary: p.body.slice(0, 200),
                url: p.url,
                score: p.score,
                source: `Reddit r/${p.subreddit}`,
            });
        }
        console.log(`[BRIEFING] Reddit scan: ${scanResult.posts.length} matches from ${scanResult.subredditsScanned.join(', ')}`);
    } catch (e: any) {
        console.error('[BRIEFING] Reddit scan failed:', e.message);
    }

    // --- Reddit: Priority 3 — keyword search across r/all ---
    const searchQueries = [
        // EN core queries
        'ai agent OR agentic ai OR autonomous agent',
        'openclaw OR langchain OR crewai OR autogen',
        'ai saas OR ai startup OR vibe coding',
        'ai ecommerce OR shopify ai OR temu ai',
        // CN queries
        'AI智能体 OR 大模型 OR 跨境电商',
    ];
    for (const query of searchQueries) {
        try {
            const posts = await searchReddit(query, 'all', 10);
            for (const p of posts.slice(0, 5)) {
                items.push({
                    title: p.title,
                    summary: p.body.slice(0, 200),
                    url: p.url,
                    score: p.score,
                    source: `Reddit r/${p.subreddit}`,
                });
            }
            // Rate limit
            await new Promise(r => setTimeout(r, 500));
        } catch (e: any) {
            console.error(`[BRIEFING] Reddit search "${query.slice(0, 30)}" failed:`, e.message);
        }
    }

    // --- X.com: Priority 2 — following timeline (includes focus accounts) ---
    try {
        const tweets = await fetchFollowingTimeline(40);
        const meaningful = tweets
            .filter(t => !t.isRetweet || t.quotedTweet)
            .filter(t => t.text.length > 20);
        meaningful.sort((a, b) => (b.likes + b.retweets) - (a.likes + a.retweets));

        for (const t of meaningful.slice(0, 15)) {
            items.push({
                title: `@${t.handle}: ${t.text.slice(0, 80)}`,
                summary: t.text.slice(0, 300),
                url: t.url,
                score: t.likes + t.retweets,
                source: `X.com @${t.handle}`,
                imageUrls: t.mediaUrls,
            });
        }
    } catch (e: any) {
        console.error('[BRIEFING] X.com feed failed:', e.message);
    }

    // Deduplicate by URL
    const seen = new Set<string>();
    const unique = items.filter(i => {
        if (seen.has(i.url)) return false;
        seen.add(i.url);
        return true;
    });

    console.log(`[BRIEFING] Phase 1: Collected ${unique.length} unique items (${items.length} raw)`);
    return unique;
}

// ─── Phase 2: Full Article Fetch ───────────────────────────────

async function enrichWithFullContent(items: RawItem[]): Promise<RawItem[]> {
    // Sort by score and pick top 10 for full-text fetch
    const sorted = [...items].sort((a, b) => b.score - a.score);
    const topItems = sorted.slice(0, 10);

    // Extract URLs that are actual articles (not Reddit self-posts)
    const articleUrls = topItems
        .map(item => item.url)
        .filter(url => url && !url.includes('reddit.com/r/') && !url.includes('x.com'));

    if (articleUrls.length > 0) {
        const articles = await fetchArticlesBatch(articleUrls, 5);
        const articleMap = new Map<string, ArticleContent>();
        for (const a of articles) {
            if (a.content.length > 100) articleMap.set(a.url, a);
        }

        // Enrich items with full content
        for (const item of items) {
            const article = articleMap.get(item.url);
            if (article) {
                item.fullContent = article.content;
                if (article.imageUrls.length > 0) {
                    item.imageUrls = [...(item.imageUrls || []), ...article.imageUrls];
                }
            }
        }
    }

    const enriched = items.filter(i => i.fullContent).length;
    console.log(`[BRIEFING] Phase 2: Enriched ${enriched}/${items.length} items with full content`);
    return items;
}

// ─── Phase 3: LLM Deep Analysis ───────────────────────────────

async function generateBlogAnalysis(items: RawItem[], date: string): Promise<BlogBriefing> {
    const auth = new GoogleAuth(DATA_DIR);
    auth.load();
    const api = new AntigravityAPI(auth);

    if (!api.ready) {
        console.error('[BRIEFING] LLM API not ready, generating basic briefing');
        return generateFallbackBriefing(items, date);
    }

    // Build context for LLM
    const context = items.map((item, i) => {
        let entry = `[${i + 1}] ${item.title}\n来源: ${item.source} | 评分: ${item.score}\nURL: ${item.url}\n摘要: ${item.summary}`;
        if (item.fullContent) {
            entry += `\n\n全文内容:\n${item.fullContent}`;
        }
        return entry;
    }).join('\n\n---\n\n');

    const prompt = `以下是今天 (${date}) 从 Reddit 和 X.com 收集的 ${items.length} 条 AI/Agent 领域内容。

请你作为专业科技博客作者，写一篇深度分析文章：

1. **翻译**：所有英文内容翻译为流畅的中文
2. **分组**：按主题归类（3-5 个今日核心主题），不要按来源分组
3. **深度分析**：每个主题写 200-400 字的深度分析，有自己的观点
4. **引用原文**：引用关键内容时标注来源
5. **保留链接**：每条内容保留原始 URL
6. **图片**：如果原始内容有图片URL，标注出来

严格按以下 JSON 格式输出（不要输出其他内容）：

{
  "title": "吸引眼球的中文标题",
  "intro": "100-150字引言，概括今日主要动态",
  "sections": [
    {
      "heading": "主题名称（中文）",
      "analysis": "深度分析正文（中文，200-400字，可以包含引用和链接）",
      "sources": [{"title": "来源标题", "url": "https://..."}],
      "image_url": "图片URL（如有）"
    }
  ],
  "conclusion": "100-150字总结",
  "key_insights": ["洞察1", "洞察2", "洞察3"]
}

原始内容：

${context}`;

    try {
        console.log(`[BRIEFING] Phase 3: Sending ${context.length} chars to LLM for analysis...`);
        const response = await api.chat(
            [{ role: 'user', text: prompt }],
            '你是顶级科技博客作者，擅长 AI/Agent 领域深度分析。输出必须是纯 JSON，不要加 markdown 代码块。',
            MODELS.taskPrimary,
            MODELS.taskFallback,
        );

        // Parse JSON from response — robust extraction
        const blog = extractBlogJson(response, date);
        if (blog) {
            console.log(`[BRIEFING] Phase 3: Generated blog with ${blog.sections?.length ?? 0} sections`);
            return blog;
        }

        console.error('[BRIEFING] Could not parse LLM response, using fallback');
        return generateFallbackBriefing(items, date);
    } catch (e: any) {
        console.error('[BRIEFING] LLM analysis failed:', e.message);
        return generateFallbackBriefing(items, date);
    }
}

/** Robust JSON extraction from LLM response */
function extractBlogJson(response: string, date: string): BlogBriefing | null {
    let text = response.trim();

    // Strip markdown code fence
    text = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?\s*```\s*$/m, '');

    // Try direct parse
    try { const r = JSON.parse(text); r.date = date; return r; } catch { }

    // Extract JSON between first { and last }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) {
        return extractBlogFromMarkdown(text, date);
    }

    const jsonCandidate = text.slice(firstBrace, lastBrace + 1);

    // Try raw candidate
    try { const r = JSON.parse(jsonCandidate); r.date = date; return r; } catch { }

    // KEY FIX: Escape literal newlines/tabs inside JSON string values
    // The LLM outputs actual \n chars inside "analysis" strings → invalid JSON
    const escaped = escapeNewlinesInJsonStrings(jsonCandidate);
    try { const r = JSON.parse(escaped); r.date = date; return r; } catch { }

    // Extra repair: trailing commas, control chars
    const cleaned = escaped
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']');
    try { const r = JSON.parse(cleaned); r.date = date; return r; } catch (e: any) {
        console.error('[BRIEFING] JSON repair still failed:', e.message?.slice(0, 100));
    }

    // Last resort: markdown parser
    return extractBlogFromMarkdown(text, date);
}

/**
 * Escape literal newlines/tabs inside JSON string values.
 * Walks character-by-character tracking whether we're inside a string.
 */
function escapeNewlinesInJsonStrings(input: string): string {
    const out: string[] = [];
    let inString = false;
    let escape = false;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];

        if (escape) {
            out.push(ch);
            escape = false;
            continue;
        }

        if (ch === '\\' && inString) {
            out.push(ch);
            escape = true;
            continue;
        }

        if (ch === '"') {
            inString = !inString;
            out.push(ch);
            continue;
        }

        if (inString) {
            // Replace literal newlines/tabs/CRs inside strings with escape sequences
            if (ch === '\n') { out.push('\\n'); continue; }
            if (ch === '\r') { out.push('\\r'); continue; }
            if (ch === '\t') { out.push('\\t'); continue; }
        }

        out.push(ch);
    }

    return out.join('');
}

/** Parse a markdown-formatted blog response (when LLM ignores JSON format) */
function extractBlogFromMarkdown(text: string, date: string): BlogBriefing | null {
    if (!text || text.length < 100) return null;

    const lines = text.split('\n');
    const sections: BlogSection[] = [];
    let currentSection: BlogSection | null = null;
    let title = '';
    let intro = '';
    const insights: string[] = [];

    for (const line of lines) {
        // Extract title from H1
        if (line.startsWith('# ') && !title) {
            title = line.slice(2).trim();
            continue;
        }
        // Section headings (H2)
        if (line.startsWith('## ')) {
            if (currentSection) sections.push(currentSection);
            currentSection = {
                heading: line.slice(3).trim(),
                analysis: '',
                sources: [],
            };
            continue;
        }
        // Collect content into current section
        if (currentSection) {
            // Extract URLs as sources
            const urlMatch = line.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
            if (urlMatch) {
                currentSection.sources.push({ title: urlMatch[1], url: urlMatch[2] });
            }
            currentSection.analysis += line + '\n';
        } else if (!intro && line.trim()) {
            intro += line + ' ';
        }
    }
    if (currentSection) sections.push(currentSection);

    if (sections.length === 0) {
        // Treat entire text as one section
        sections.push({
            heading: '今日 AI/Agent 动态分析',
            analysis: text.slice(0, 3000),
            sources: [],
        });
    }

    return {
        title: title || `AI/Agent 深度分析 — ${date}`,
        date,
        intro: intro.trim().slice(0, 200) || `今日 AI/Agent 领域深度分析报告。`,
        sections,
        conclusion: '以上为今日 AI/Agent 领域核心动态的深度分析。',
        key_insights: insights.length > 0 ? insights : ['详见正文分析'],
    };
}

function generateFallbackBriefing(items: RawItem[], date: string): BlogBriefing {
    return {
        title: `AI/Agent 每日简报 — ${date}`,
        date,
        intro: `今日收集了 ${items.length} 条 AI/Agent 领域动态。`,
        sections: [{
            heading: '📊 今日动态汇总',
            analysis: items.slice(0, 15).map(i =>
                `• **${i.title}** (${i.source}, ⬆${i.score})\n  ${i.summary}\n  ${i.url}`
            ).join('\n\n'),
            sources: items.slice(0, 15).map(i => ({ title: i.title, url: i.url })),
        }],
        conclusion: '由于 LLM 分析不可用，以上为原始数据汇总。',
        key_insights: ['LLM 分析暂不可用，请检查 API 接入'],
    };
}

// ─── Phase 4: Beautiful Feishu Document ────────────────────────

async function createBlogDoc(blog: BlogBriefing): Promise<string> {
    const client = getFeishuClient();
    const accessToken = await getFeishuToken();

    // 1. Create document
    const createRes = await client.docx.document.create({
        data: { title: `📰 ${blog.title}`, folder_token: '' },
    });
    const docId = createRes.data?.document?.document_id;
    if (!docId) throw new Error('Failed to create Feishu document');

    // 2. Get root block
    const docBlock = await client.docx.documentBlock.list({
        path: { document_id: docId },
        params: { page_size: 1 },
    });
    const rootBlockId = docBlock.data?.items?.[0]?.block_id || docId;

    // 3. Build blocks with safe char limits
    const blocks: any[] = [];
    const MAX_TEXT_RUN = 450;  // Feishu text_run limit is ~500 chars

    // Helper: safe text block (auto-splits if too long)
    const makeText = (content: string) => ({
        block_type: 2,
        text: {
            elements: [{ text_run: { content: content.slice(0, MAX_TEXT_RUN) } }],
            style: {},
        },
    });

    // Helper: bold text block
    const makeBold = (content: string) => ({
        block_type: 2,
        text: {
            elements: [{ text_run: { content: content.slice(0, MAX_TEXT_RUN), text_element_style: { bold: true } } }],
            style: {},
        },
    });

    // Helper: heading-style
    const makeHeading = (content: string) => ({
        block_type: 2,
        text: {
            elements: [{
                text_run: {
                    content: `▎${content}`.slice(0, MAX_TEXT_RUN),
                    text_element_style: { bold: true },
                },
            }],
            style: {},
        },
    });

    // Helper: quote-like block
    const makeQuote = (content: string) => ({
        block_type: 2,
        text: {
            elements: [{
                text_run: {
                    content: `│ ${content}`.slice(0, MAX_TEXT_RUN),
                    text_element_style: { italic: true },
                },
            }],
            style: {},
        },
    });

    // Helper: divider
    const makeDivider = () => ({
        block_type: 2,
        text: {
            elements: [{ text_run: { content: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━' } }],
            style: {},
        },
    });

    // Helper: link
    const makeLink = (text: string, url: string) => ({
        block_type: 2,
        text: {
            elements: [{
                text_run: {
                    content: `🔗 ${text}`.slice(0, MAX_TEXT_RUN),
                    text_element_style: {
                        link: { url },
                    },
                },
            }],
            style: {},
        },
    });

    // Helper: split long text into multiple blocks
    const pushLongText = (text: string) => {
        // Split by sentences (Chinese period, English period, newlines)
        const chunks: string[] = [];
        let current = '';
        const sentences = text.split(/(?<=[。！？.!?\n])/g);
        for (const s of sentences) {
            if ((current + s).length > MAX_TEXT_RUN && current.length > 0) {
                chunks.push(current.trim());
                current = s;
            } else {
                current += s;
            }
        }
        if (current.trim()) chunks.push(current.trim());

        for (const chunk of chunks) {
            if (chunk.startsWith('>') || chunk.startsWith('> ')) {
                blocks.push(makeQuote(chunk.replace(/^>\s*/, '')));
            } else {
                blocks.push(makeText(chunk));
            }
        }
    };

    // ── Build Document Structure ──

    // Date line
    blocks.push(makeText(`📅 ${blog.date}`));

    // Intro
    blocks.push(makeBold('📌 导读'));
    pushLongText(blog.intro);
    blocks.push(makeDivider());

    // Sections
    for (const section of blog.sections ?? []) {
        blocks.push(makeHeading(section.heading));

        // Split analysis into paragraphs for readability
        const paragraphs = section.analysis.split('\n\n').filter(Boolean);
        for (const para of paragraphs) {
            pushLongText(para);
        }

        // Source links
        if (section.sources?.length > 0) {
            blocks.push(makeText('📎 参考来源:'));
            for (const src of section.sources.slice(0, 5)) {
                if (src.url) {
                    blocks.push(makeLink(src.title.slice(0, 55), src.url));
                }
            }
        }

        blocks.push(makeDivider());
    }

    // Key Insights
    if (blog.key_insights?.length > 0) {
        blocks.push(makeHeading('💡 今日核心洞察'));
        for (let i = 0; i < blog.key_insights.length; i++) {
            blocks.push(makeBold(`${i + 1}. ${blog.key_insights[i]}`));
        }
        blocks.push(makeDivider());
    }

    // Conclusion
    blocks.push(makeHeading('📝 总结'));
    blocks.push(makeText(blog.conclusion));
    blocks.push(makeText(`\n— FishbigAgent 🐟 自动生成`));

    // 4. Insert blocks in batches of 20 (Feishu limit)
    const BATCH_SIZE = 20;
    let totalInserted = 0;
    for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
        const batch = blocks.slice(i, i + BATCH_SIZE);
        const url = `https://open.larksuite.com/open-apis/docx/v1/documents/${docId}/blocks/${rootBlockId}/children`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ children: batch, index: -1 }),
        });
        const resJson = await res.json() as { code?: number; msg?: string };
        if (resJson.code !== 0) {
            console.error(`[BRIEFING] Block batch ${Math.floor(i / BATCH_SIZE) + 1} error:`, resJson.code, resJson.msg);
            // Try inserting blocks one by one to find the bad one
            for (let j = 0; j < batch.length; j++) {
                const singleRes = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ children: [batch[j]], index: -1 }),
                });
                const singleJson = await singleRes.json() as { code?: number; msg?: string };
                if (singleJson.code === 0) {
                    totalInserted++;
                } else {
                    console.error(`[BRIEFING] Block ${i + j} failed:`, JSON.stringify(batch[j]).slice(0, 200));
                }
            }
        } else {
            totalInserted += batch.length;
        }
    }
    console.log(`[BRIEFING] ✅ Inserted ${totalInserted}/${blocks.length} blocks into blog document`);

    const docUrl = `https://bytedance.larkoffice.com/docx/${docId}`;
    console.log(`[BRIEFING] Created blog: ${docUrl}`);
    return docUrl;
}

// ─── Send Doc Link ─────────────────────────────────────────────

async function sendDocLink(chatId: string, docUrl: string, title: string): Promise<void> {
    const client = getFeishuClient();
    await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: JSON.stringify({
                config: { wide_screen_mode: true },
                header: { title: { tag: 'plain_text', content: title } },
                elements: [
                    {
                        tag: 'action',
                        actions: [{
                            tag: 'button',
                            text: { tag: 'plain_text', content: '📄 打开深度分析' },
                            url: docUrl,
                            type: 'primary',
                        }],
                    },
                ],
            }),
        },
    });
}

// ─── Main Entry ────────────────────────────────────────────────

/**
 * Generate the daily deep analysis briefing.
 * Pipeline: Collect → Fetch → Analyze → Document
 */
export async function generateDailyBriefing(chatId: string): Promise<string> {
    const date = new Date().toISOString().slice(0, 10);
    console.log(`[BRIEFING] 📰 Generating deep analysis briefing for ${date}...`);

    // Phase 1: Collect raw data
    const items = await collectAllData();
    if (items.length === 0) {
        console.error('[BRIEFING] No data collected');
        return '';
    }

    // Phase 2: Fetch full articles
    const enrichedItems = await enrichWithFullContent(items);

    // Phase 3: LLM deep analysis
    const blog = await generateBlogAnalysis(enrichedItems, date);

    // Phase 4: Create beautiful Feishu document
    const docUrl = await createBlogDoc(blog);

    // Send briefing to chat
    await sendDocLink(chatId, docUrl, `📰 ${blog.title}`);
    console.log(`[BRIEFING] ✅ Deep analysis sent to chat ${chatId}`);

    // Phase 5: Write materials to Notion FIRST (to get page IDs for linking)
    let materialMappings: { url: string; pageId: string; title: string }[] = [];
    try {
        const { writeMaterialsToNotion } = await import('../channels/notion-writer.js');
        materialMappings = await writeMaterialsToNotion(enrichedItems.map(i => ({
            title: i.title,
            source: i.source,
            url: i.url,
            summary: (i.summary || '').slice(0, 2000),
            score: i.score,
            date,
        })));
    } catch (e: any) {
        console.error('[BRIEFING] Notion materials write failed:', e.message);
    }

    // Phase 6: Generate content topic library (with material page IDs)
    try {
        const briefingText = enrichedItems.map(i =>
            `[${i.source}] ${i.title}\n${i.summary || ''}\n${i.fullContent ? i.fullContent.slice(0, 300) : ''}`
        ).join('\n---\n');
        await generateTopicLibrary(chatId, briefingText, enrichedItems, materialMappings);
    } catch (e: any) {
        console.error('[BRIEFING] Topic generation failed:', e.message);
    }

    // Phase 7: Write briefing to Notion
    try {
        const { writeBriefingToNotion } = await import('../channels/notion-writer.js');
        await writeBriefingToNotion({
            title: blog.title,
            date,
            sectionCount: blog.sections?.length ?? 0,
            feishuUrl: docUrl,
            sections: (blog.sections ?? []).map(s => ({
                heading: s.heading,
                analysis: s.analysis,
            })),
        });
    } catch (e: any) {
        console.error('[BRIEFING] Notion briefing write failed:', e.message);
    }

    return docUrl;
}
