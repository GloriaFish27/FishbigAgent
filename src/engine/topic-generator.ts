/**
 * Topic Generator — Daily Content Topic Library
 *
 * Takes daily briefing data → LLM (Gloria persona) → 5-8 topic cards
 * Output: 飞书文档 with topics for 小红书 (emotional) + 公众号 (deep)
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { AntigravityAPI, MODELS } from './antigravity-api.js';
import { GoogleAuth } from '../auth/google-auth.js';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../../config/config.json' with { type: 'json' };
import strategy from '../../config/content-strategy.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

// ─── Types ─────────────────────────────────────────────────────

interface TopicCard {
    id: string;
    pillar: string;
    priority: number;
    xiaohongshu: {
        title: string;
        hook: string;
        tags: string[];
        card_ideas: string[];
    };
    wechat: {
        title: string;
        structure: string;
        key_points: string[];
    };
    source_summary: string;
    gloria_angle: string;
}

interface TopicLibrary {
    date: string;
    topics: TopicCard[];
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
    if (!json.tenant_access_token) throw new Error('Failed to get Feishu token');
    return json.tenant_access_token;
}

// ─── LLM Topic Generation ─────────────────────────────────────

async function generateTopics(briefingData: string, date: string): Promise<TopicCard[]> {
    const auth = new GoogleAuth(DATA_DIR);
    auth.load();
    const api = new AntigravityAPI(auth);

    if (!api.ready) {
        console.error('[TOPICS] LLM API not ready');
        return [];
    }

    const prompt = `今天是 ${date}。以下是今日 AI/跨境/科技领域的信息摘要：

${briefingData}

---

你是「${strategy.persona.account_name}」的内容策略师。
人设：${strategy.persona.identity}
核心定位：${strategy.persona.positioning}
目标读者：${strategy.audience.description}

请基于以上数据，生成 5-8 个内容选题卡片。

要求：
1. 小红书标题：情绪化风格，用钩子词（后悔没早用/救命/绝了/亏了X万才悟出/必看），有数字，有价值点
2. 小红书 hook：1-2 句引入话术，让人想继续看
3. 小红书 card_ideas：6-8 张卡片图的内容大纲（每张 1 句话描述）
4. 公众号标题：深度分析型，有观点，有框架感
5. 公众号 structure：文章结构（3-5 个段落方向）
6. 公众号 key_points：3-5 个关键论点
7. 每个选题标注 gloria_angle（鱼大为什么有资格写这个）
8. priority 1-10 评分（时效性 × 读者价值 × 爆款潜力）
9. pillar 从这 5 个中选：ai_cross_border, money_method, ai_coding, trend_analysis, personal_growth

严格按以下 JSON 数组格式输出：

[
  {
    "pillar": "ai_cross_border",
    "priority": 9,
    "xiaohongshu": {
      "title": "情绪化标题",
      "hook": "1-2句开场钩子",
      "tags": ["#标签1", "#标签2"],
      "card_ideas": ["卡片1内容", "卡片2内容", "..."]
    },
    "wechat": {
      "title": "深度分析标题",
      "structure": "引入 → 拆解 → 方法论 → 思考",
      "key_points": ["论点1", "论点2", "论点3"]
    },
    "source_summary": "基于哪条今日数据",
    "gloria_angle": "鱼大为什么有资格写"
  }
]`;

    try {
        console.log(`[TOPICS] Generating topics from ${briefingData.length} chars of data...`);
        const response = await api.chat(
            [{ role: 'user', text: prompt }],
            '你是跨境电商+AI领域的内容策略专家。你服务的博主是一位实战派创业者，内容风格真实接地气。输出纯JSON数组，不要markdown代码块。',
            MODELS.taskPrimary,
            MODELS.taskFallback,
        );

        const topics = parseTopicsJson(response, date);
        console.log(`[TOPICS] Generated ${topics.length} topic cards`);
        return topics;
    } catch (e: any) {
        console.error('[TOPICS] LLM generation failed:', e.message);
        return [];
    }
}

function parseTopicsJson(response: string, date: string): TopicCard[] {
    let text = response.trim();
    text = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?\s*```\s*$/m, '');

    // Find array between [ and ]
    const firstBracket = text.indexOf('[');
    const lastBracket = text.lastIndexOf(']');
    if (firstBracket < 0 || lastBracket <= firstBracket) return [];

    let jsonStr = text.slice(firstBracket, lastBracket + 1);

    // Escape newlines in strings (same fix as daily-briefing)
    jsonStr = escapeNewlinesInStrings(jsonStr);
    jsonStr = jsonStr.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');

    try {
        const arr = JSON.parse(jsonStr) as any[];
        return arr.map((item, i) => ({
            id: `topic-${date}-${String(i + 1).padStart(3, '0')}`,
            pillar: item.pillar || 'trend_analysis',
            priority: item.priority || 5,
            xiaohongshu: {
                title: item.xiaohongshu?.title || '',
                hook: item.xiaohongshu?.hook || '',
                tags: item.xiaohongshu?.tags || [],
                card_ideas: item.xiaohongshu?.card_ideas || [],
            },
            wechat: {
                title: item.wechat?.title || '',
                structure: item.wechat?.structure || '',
                key_points: item.wechat?.key_points || [],
            },
            source_summary: item.source_summary || '',
            gloria_angle: item.gloria_angle || '',
        }));
    } catch (e: any) {
        console.error('[TOPICS] JSON parse failed:', e.message?.slice(0, 100));
        return [];
    }
}

function escapeNewlinesInStrings(input: string): string {
    const out: string[] = [];
    let inString = false;
    let escape = false;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (escape) { out.push(ch); escape = false; continue; }
        if (ch === '\\' && inString) { out.push(ch); escape = true; continue; }
        if (ch === '"') { inString = !inString; out.push(ch); continue; }
        if (inString) {
            if (ch === '\n') { out.push('\\n'); continue; }
            if (ch === '\r') { out.push('\\r'); continue; }
            if (ch === '\t') { out.push('\\t'); continue; }
        }
        out.push(ch);
    }
    return out.join('');
}

// ─── Feishu Document Output ────────────────────────────────────

async function createTopicDoc(library: TopicLibrary): Promise<string> {
    const client = getFeishuClient();
    const accessToken = await getFeishuToken();
    const MAX = 450;

    const createRes = await client.docx.document.create({
        data: { title: `📝 选题库 — ${library.date} | 鱼大跨境AI教练`, folder_token: '' },
    });
    const docId = createRes.data?.document?.document_id;
    if (!docId) throw new Error('Failed to create topic doc');

    const docBlock = await client.docx.documentBlock.list({
        path: { document_id: docId },
        params: { page_size: 1 },
    });
    const rootBlockId = docBlock.data?.items?.[0]?.block_id || docId;

    const blocks: any[] = [];

    const makeText = (c: string) => ({
        block_type: 2,
        text: { elements: [{ text_run: { content: c.slice(0, MAX) } }], style: {} },
    });
    const makeBold = (c: string) => ({
        block_type: 2,
        text: { elements: [{ text_run: { content: c.slice(0, MAX), text_element_style: { bold: true } } }], style: {} },
    });
    const makeDivider = () => makeText('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Header
    blocks.push(makeBold(`📝 每日选题库 — ${library.date}`));
    blocks.push(makeText(`共 ${library.topics.length} 个选题 | 鱼大跨境AI教练`));
    blocks.push(makeDivider());

    // Topics
    for (let i = 0; i < library.topics.length; i++) {
        const t = library.topics[i];
        const pillarName = strategy.pillars.find(p => p.id === t.pillar)?.name || t.pillar;

        // Topic header
        blocks.push(makeBold(`\n选题 ${i + 1} | ⭐${t.priority} | ${pillarName}`));

        // 小红书
        blocks.push(makeBold('🔴 小红书（情绪化）'));
        blocks.push(makeBold(`标题：${t.xiaohongshu.title}`));
        blocks.push(makeText(`钩子：${t.xiaohongshu.hook}`));
        if (t.xiaohongshu.tags.length > 0) {
            blocks.push(makeText(`标签：${t.xiaohongshu.tags.join(' ')}`));
        }
        if (t.xiaohongshu.card_ideas.length > 0) {
            blocks.push(makeText(`卡片图大纲：`));
            const cardText = t.xiaohongshu.card_ideas
                .map((c, j) => `  ${j + 1}. ${c}`)
                .join('\n')
                .slice(0, MAX);
            blocks.push(makeText(cardText));
        }

        // 公众号
        blocks.push(makeBold('📱 公众号（深度分析）'));
        blocks.push(makeBold(`标题：${t.wechat.title}`));
        blocks.push(makeText(`结构：${t.wechat.structure}`));
        if (t.wechat.key_points.length > 0) {
            const kpText = t.wechat.key_points
                .map((k, j) => `  ${j + 1}. ${k}`)
                .join('\n')
                .slice(0, MAX);
            blocks.push(makeText(`关键论点：\n${kpText}`));
        }

        // Meta
        blocks.push(makeText(`素材来源：${t.source_summary.slice(0, 200)}`));
        blocks.push(makeText(`鱼大角度：${t.gloria_angle.slice(0, 200)}`));
        blocks.push(makeDivider());
    }

    blocks.push(makeText(`\n— FishbigAgent 🐟 自动生成 | ${new Date().toISOString().slice(0, 16)}`));

    // Insert in batches of 20
    const BATCH = 20;
    let inserted = 0;
    for (let i = 0; i < blocks.length; i += BATCH) {
        const batch = blocks.slice(i, i + BATCH);
        const url = `https://open.larksuite.com/open-apis/docx/v1/documents/${docId}/blocks/${rootBlockId}/children`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ children: batch, index: -1 }),
        });
        const rj = await res.json() as { code?: number };
        if (rj.code === 0) inserted += batch.length;
    }

    console.log(`[TOPICS] ✅ Inserted ${inserted}/${blocks.length} blocks`);
    const docUrl = `https://bytedance.larkoffice.com/docx/${docId}`;
    console.log(`[TOPICS] Created: ${docUrl}`);
    return docUrl;
}

async function sendTopicLink(chatId: string, docUrl: string, date: string): Promise<void> {
    const client = getFeishuClient();
    await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: JSON.stringify({
                config: { wide_screen_mode: true },
                header: { title: { tag: 'plain_text', content: `📝 每日选题库 — ${date}` } },
                elements: [{
                    tag: 'action',
                    actions: [{
                        tag: 'button',
                        text: { tag: 'plain_text', content: '📝 打开选题库' },
                        url: docUrl,
                        type: 'primary',
                    }],
                }],
            }),
        },
    });
}

// ─── Main Entry ────────────────────────────────────────────────

/**
 * Generate daily topic library from briefing data.
 * Input: briefing summary text (from generateDailyBriefing phase 1+3)
 * Output: Feishu doc with topic cards
 */
interface RawItemRef {
    title: string;
    url: string;
    source: string;
}

interface MaterialMapping {
    url: string;
    pageId: string;
    title: string;
}

export async function generateTopicLibrary(
    chatId: string,
    briefingData: string,
    rawItems?: RawItemRef[],
    materialMappings?: MaterialMapping[],
): Promise<string> {
    const date = new Date().toISOString().slice(0, 10);
    console.log(`[TOPICS] 📝 Generating topic library for ${date}...`);

    const topics = await generateTopics(briefingData, date);
    if (topics.length === 0) {
        console.error('[TOPICS] No topics generated');
        return '';
    }

    // Sort by priority
    topics.sort((a, b) => b.priority - a.priority);

    const library: TopicLibrary = { date, topics };
    const docUrl = await createTopicDoc(library);

    await sendTopicLink(chatId, docUrl, date);
    console.log(`[TOPICS] ✅ Topic library sent to chat ${chatId}`);

    // Write topics to Notion with source links + material relations
    try {
        const { writeTopicsToNotion } = await import('../channels/notion-writer.js');

        // Build URL-to-pageId lookup from material mappings
        const urlToPageId = new Map<string, string>();
        if (materialMappings) {
            for (const m of materialMappings) {
                urlToPageId.set(m.url, m.pageId);
            }
        }

        await writeTopicsToNotion(topics.map(t => {
            // Build search text from topic (source_summary + title + hook)
            const topicText = `${t.source_summary} ${t.xiaohongshu.title} ${t.wechat.title}`.toLowerCase();
            const words = topicText
                .replace(/[#@\[\](){}]/g, ' ')
                .split(/[\s,.:;!?/|]+/)
                .filter(w => w.length >= 2)
                .filter(w => !['the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'has', 'have', '如何', '什么', '可以', '一个', '这个'].includes(w));

            // Score each raw item: count how many topic words appear in item text
            const scored = (rawItems || []).map(item => {
                const itemText = `${item.title} ${item.source}`.toLowerCase();
                const matchCount = words.filter(w => itemText.includes(w)).length;
                return { item, matchCount };
            }).filter(s => s.matchCount >= 2) // at least 2 word matches
                .sort((a, b) => b.matchCount - a.matchCount);

            // Take top 5 matches, or fallback to first 3 raw items if no matches
            const matchedItems = scored.length > 0
                ? scored.slice(0, 5).map(s => s.item)
                : (rawItems || []).slice(0, 3);

            // Collect source URLs and material page IDs
            const sourceUrls = matchedItems.map(i => i.url).filter(Boolean).slice(0, 5);
            const materialPageIds = matchedItems
                .map(i => urlToPageId.get(i.url))
                .filter((id): id is string => !!id)
                .slice(0, 5);

            return {
                xhsTitle: t.xiaohongshu.title,
                wechatTitle: t.wechat.title,
                pillar: t.pillar,
                priority: t.priority,
                date,
                hook: t.xiaohongshu.hook,
                gloriaAngle: t.gloria_angle,
                sourceSummary: t.source_summary,
                cardIdeas: t.xiaohongshu.card_ideas.map((c, i) => `${i + 1}. ${c}`).join('\n'),
                structure: t.wechat.structure,
                keyPoints: t.wechat.key_points,
                sourceUrls,
                materialPageIds,
            };
        }));
    } catch (e: any) {
        console.error('[TOPICS] Notion write failed:', e.message);
    }

    return docUrl;
}
