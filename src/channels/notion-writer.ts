/**
 * Notion Writer — Writes briefings, topics, and materials to Notion databases
 * Uses raw fetch with Notion-Version: 2022-06-28 for compatibility
 */

import config from '../../config/config.json' with { type: 'json' };

const NOTION_API = 'https://api.notion.com/v1';
const HEADERS = {
    'Authorization': `Bearer ${config.notion.token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
};

// ─── Types ─────────────────────────────────────────────────────

interface BriefingEntry {
    title: string;
    date: string;
    sectionCount: number;
    feishuUrl: string;
    sections: { heading: string; analysis: string }[];
}

interface TopicEntry {
    xhsTitle: string;
    wechatTitle: string;
    pillar: string;
    priority: number;
    date: string;
    hook: string;
    gloriaAngle: string;
    sourceSummary: string;
    cardIdeas: string;
    structure: string;
    keyPoints: string[];
    sourceUrls: string[];         // original URLs from raw data
    materialPageIds: string[];    // Notion page IDs of related materials
}

interface MaterialEntry {
    title: string;
    source: string;
    url: string;
    summary: string;
    score: number;
    date: string;
}

/** Returned from writeMaterialsToNotion for linking */
export interface MaterialPageMapping {
    url: string;
    pageId: string;
    title: string;
}

// ─── Pillar mapping ────────────────────────────────────────────

const PILLAR_MAP: Record<string, string> = {
    'ai_cross_border': 'AI×跨境实战',
    'money_method': '赚钱方法论',
    'ai_coding': 'AI Coding教学',
    'trend_analysis': '趋势解读',
    'personal_growth': '个人成长',
};

// ─── Notion Block helpers ──────────────────────────────────────

async function notionPost(path: string, body: any): Promise<any> {
    const res = await fetch(`${NOTION_API}${path}`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
    });
    return res.json();
}

function textBlock(content: string) {
    return {
        object: 'block', type: 'paragraph',
        paragraph: {
            rich_text: [{ type: 'text', text: { content: content.slice(0, 2000) } }],
        },
    };
}

function h2Block(content: string) {
    return {
        object: 'block', type: 'heading_2',
        heading_2: {
            rich_text: [{ type: 'text', text: { content: content.slice(0, 200) } }],
        },
    };
}

function h3Block(content: string) {
    return {
        object: 'block', type: 'heading_3',
        heading_3: {
            rich_text: [{ type: 'text', text: { content: content.slice(0, 200) } }],
        },
    };
}

function dividerBlock() {
    return { object: 'block', type: 'divider', divider: {} };
}

function bookmarkBlock(url: string) {
    return {
        object: 'block', type: 'bookmark',
        bookmark: { url },
    };
}

function linkText(label: string, url: string) {
    return {
        object: 'block', type: 'paragraph',
        paragraph: {
            rich_text: [{
                type: 'text',
                text: { content: label.slice(0, 200), link: { url } },
            }],
        },
    };
}

function bulletBlock(content: string) {
    return {
        object: 'block', type: 'bulleted_list_item',
        bulleted_list_item: {
            rich_text: [{ type: 'text', text: { content: content.slice(0, 2000) } }],
        },
    };
}

function calloutBlock(content: string, emoji: string = '💡') {
    return {
        object: 'block', type: 'callout',
        callout: {
            rich_text: [{ type: 'text', text: { content: content.slice(0, 2000) } }],
            icon: { type: 'emoji', emoji },
        },
    };
}

// ─── Write Briefing ────────────────────────────────────────────

export async function writeBriefingToNotion(entry: BriefingEntry): Promise<string> {
    if (!config.notion.briefingDbId) return '';

    try {
        // Build rich content blocks for the full briefing page
        const children: any[] = [];

        // Header callout
        children.push(calloutBlock(
            `📊 ${entry.date} 每日深度分析 | ${entry.sectionCount} 个主题 | 鱼大跨境AI教练`,
            '📰'
        ));
        children.push(dividerBlock());

        // Each section with proper formatting
        for (const section of entry.sections) {
            children.push(h2Block(section.heading));

            // Split analysis into paragraphs
            const paras = section.analysis.split('\n\n').filter(Boolean);
            for (const p of paras) {
                // Check if it looks like a bullet point
                if (p.startsWith('- ') || p.startsWith('• ')) {
                    const lines = p.split('\n').filter(Boolean);
                    for (const line of lines) {
                        const clean = line.replace(/^[-•]\s*/, '');
                        children.push(bulletBlock(clean));
                    }
                } else {
                    children.push(textBlock(p));
                }
            }
            children.push(dividerBlock());
        }

        // Footer with Feishu link
        if (entry.feishuUrl) {
            children.push(h3Block('📎 相关链接'));
            children.push(linkText('📄 飞书版简报', entry.feishuUrl));
        }

        children.push(textBlock(`— FishbigAgent 🐟 自动生成 | ${new Date().toISOString().slice(0, 16)}`));

        const result = await notionPost('/pages', {
            parent: { type: 'database_id', database_id: config.notion.briefingDbId },
            properties: {
                '标题': { title: [{ text: { content: entry.title.slice(0, 200) } }] },
                '日期': { date: { start: entry.date } },
                '主题数': { number: entry.sectionCount },
                '飞书链接': { url: entry.feishuUrl || null },
                '状态': { select: { name: '已生成' } },
            },
            children: children.slice(0, 100),
        });

        if (result.id) {
            console.log(`[NOTION] ✅ Briefing page written: ${result.id}`);
            return result.id;
        } else {
            console.error(`[NOTION] Briefing failed: ${result.message?.slice(0, 100)}`);
            return '';
        }
    } catch (e: any) {
        console.error('[NOTION] Briefing write failed:', e.message?.slice(0, 150));
        return '';
    }
}

// ─── Write Materials (returns page ID mapping) ─────────────────

export async function writeMaterialsToNotion(
    materials: MaterialEntry[]
): Promise<MaterialPageMapping[]> {
    if (!config.notion.materialDbId) return [];

    const mappings: MaterialPageMapping[] = [];
    let written = 0;

    for (const mat of materials) {
        try {
            const result = await notionPost('/pages', {
                parent: { type: 'database_id', database_id: config.notion.materialDbId },
                properties: {
                    '标题': { title: [{ text: { content: mat.title.slice(0, 200) } }] },
                    '来源': { select: { name: mat.source.startsWith('X') ? 'X.com' : 'Reddit' } },
                    'URL': { url: mat.url || null },
                    '摘要': { rich_text: [{ text: { content: mat.summary.slice(0, 2000) } }] },
                    '热度': { number: mat.score },
                    '日期': { date: { start: mat.date } },
                    '已用': { checkbox: false },
                },
            });

            if (result.id) {
                written++;
                mappings.push({
                    url: mat.url,
                    pageId: result.id,
                    title: mat.title,
                });
            }
        } catch (e: any) {
            console.error(`[NOTION] Material write failed: ${e.message?.slice(0, 80)}`);
        }
    }

    console.log(`[NOTION] ✅ ${written}/${materials.length} materials written`);
    return mappings;
}

// ─── Write Topics (with source links + material relations) ─────

export async function writeTopicsToNotion(topics: TopicEntry[]): Promise<number> {
    if (!config.notion.topicDbId) return 0;

    let written = 0;
    for (const topic of topics) {
        try {
            const pillarName = PILLAR_MAP[topic.pillar] || topic.pillar;

            // Build rich page content
            const children: any[] = [];

            // ── 小红书 section ──
            children.push(h2Block('🔴 小红书（情绪化风格）'));
            children.push(calloutBlock(topic.hook, '🎣'));

            children.push(h3Block('📸 卡片图大纲'));
            const ideas = topic.cardIdeas.split('\n').filter(Boolean);
            for (const idea of ideas) {
                children.push(bulletBlock(idea.replace(/^\d+\.\s*/, '')));
            }

            children.push(dividerBlock());

            // ── 公众号 section ──
            children.push(h2Block('📱 公众号（深度分析）'));
            children.push(textBlock(`结构：${topic.structure}`));

            children.push(h3Block('💡 关键论点'));
            for (const kp of topic.keyPoints) {
                children.push(bulletBlock(kp));
            }

            children.push(dividerBlock());

            // ── 鱼大角度 ──
            children.push(calloutBlock(`鱼大角度：${topic.gloriaAngle}`, '🐟'));

            children.push(dividerBlock());

            // ── Source links ──
            children.push(h3Block('🔗 原始来源'));
            if (topic.sourceUrls.length > 0) {
                for (const url of topic.sourceUrls) {
                    children.push(bookmarkBlock(url));
                }
            } else {
                children.push(textBlock(topic.sourceSummary));
            }

            // ── Material page links ──
            if (topic.materialPageIds.length > 0) {
                children.push(h3Block('📦 关联素材'));
                for (const pageId of topic.materialPageIds) {
                    // Mention/link to the material page
                    const notionUrl = `https://www.notion.so/${pageId.replace(/-/g, '')}`;
                    children.push(linkText('📦 查看素材详情', notionUrl));
                }
            }

            // Build properties
            const properties: any = {
                '选题': { title: [{ text: { content: topic.xhsTitle.slice(0, 200) } }] },
                '公众号标题': { rich_text: [{ text: { content: topic.wechatTitle.slice(0, 200) } }] },
                '支柱': { select: { name: pillarName } },
                '平台': { multi_select: [{ name: '小红书' }, { name: '公众号' }] },
                '优先级': { number: topic.priority },
                '状态': { select: { name: '待选' } },
                '日期': { date: { start: topic.date } },
                '钩子': { rich_text: [{ text: { content: topic.hook.slice(0, 200) } }] },
                '鱼大角度': { rich_text: [{ text: { content: topic.gloriaAngle.slice(0, 200) } }] },
                '素材来源': { rich_text: [{ text: { content: topic.sourceSummary.slice(0, 200) } }] },
                '卡片图大纲': { rich_text: [{ text: { content: topic.cardIdeas.slice(0, 200) } }] },
                '文章结构': { rich_text: [{ text: { content: topic.structure.slice(0, 200) } }] },
            };

            // Add relation to material pages
            if (topic.materialPageIds.length > 0) {
                properties['关联素材'] = {
                    relation: topic.materialPageIds.map(id => ({ id })),
                };
            }

            const result = await notionPost('/pages', {
                parent: { type: 'database_id', database_id: config.notion.topicDbId },
                properties,
                children: children.slice(0, 100),
            });

            if (result.id) written++;
            else console.error(`[NOTION] Topic failed: ${result.message?.slice(0, 80)}`);
        } catch (e: any) {
            console.error(`[NOTION] Topic write failed: ${e.message?.slice(0, 100)}`);
        }
    }

    console.log(`[NOTION] ✅ ${written}/${topics.length} topics written`);
    return written;
}
