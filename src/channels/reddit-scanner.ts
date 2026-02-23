/**
 * Reddit Public Scanner
 *
 * Uses Reddit's public JSON endpoints to discover opportunities.
 * No API key, no login, no ban risk.
 *
 * Endpoints:
 *   https://www.reddit.com/r/{subreddit}/new.json?limit=25
 *   https://www.reddit.com/r/{subreddit}/search.json?q={query}&sort=new
 */

// ─── Types ─────────────────────────────────────────────────────

export interface RedditPost {
    id: string;
    title: string;
    body: string;
    author: string;
    subreddit: string;
    url: string;
    score: number;
    numComments: number;
    createdUtc: number;
    ageHours: number;
    flair: string;
    keywordsMatched: string[];
}

export interface ScanResult {
    posts: RedditPost[];
    errors: string[];
    scannedAt: string;
    subredditsScanned: string[];
}

// ─── Config ────────────────────────────────────────────────────

import sourcesConfig from '../../config/sources.json' with { type: 'json' };

const DEFAULT_SUBS = sourcesConfig.reddit.core_subreddits;
const SCAN_MODES = sourcesConfig.reddit.scan_mode as Record<string, string>;

// Flatten all keyword groups from sources.json
const PAIN_KEYWORDS = [
    ...sourcesConfig.keywords.en.core,
    ...sourcesConfig.keywords.en.products,
    ...sourcesConfig.keywords.en.business,
    ...sourcesConfig.keywords.en.ecommerce,
    ...sourcesConfig.keywords.en.engineering,
    ...sourcesConfig.keywords.cn.core,
    ...sourcesConfig.keywords.cn.products,
    ...sourcesConfig.keywords.cn.ecommerce,
    ...sourcesConfig.keywords.cn.engineering,
];

const USER_AGENT = 'FishbigAgent-MarketResearch/1.0';

// ─── Scanner ───────────────────────────────────────────────────

async function fetchRedditJSON(url: string): Promise<any> {
    const res = await fetch(url, {
        headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'application/json',
        },
    });
    if (!res.ok) {
        throw new Error(`Reddit API error: ${res.status} ${res.statusText}`);
    }
    return res.json();
}

function parsePost(data: any): RedditPost {
    const d = data.data;
    return {
        id: d.id,
        title: d.title || '',
        body: (d.selftext || '').slice(0, 1000),
        author: d.author || '',
        subreddit: d.subreddit || '',
        url: `https://reddit.com${d.permalink}`,
        score: d.score || 0,
        numComments: d.num_comments || 0,
        createdUtc: d.created_utc || 0,
        ageHours: Math.round((Date.now() / 1000 - (d.created_utc || 0)) / 3600 * 10) / 10,
        flair: d.link_flair_text || '',
        keywordsMatched: [],
    };
}

export async function scanSubreddit(
    subreddit: string,
    limit: number = 25,
    keywords?: string[],
    sort: string = 'new',
): Promise<RedditPost[]> {
    const url = `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${limit}`;
    const json = await fetchRedditJSON(url);

    if (!json?.data?.children) return [];

    const kws = keywords || PAIN_KEYWORDS;
    const posts: RedditPost[] = [];

    for (const child of json.data.children) {
        const post = parsePost(child);
        const text = (post.title + ' ' + post.body).toLowerCase();
        post.keywordsMatched = kws.filter(kw => text.includes(kw.toLowerCase()));
        if (post.keywordsMatched.length > 0) {
            posts.push(post);
        }
    }

    return posts;
}

export async function scanAllSubreddits(
    subreddits?: string[],
    limitPerSub: number = 25,
    keywords?: string[],
): Promise<ScanResult> {
    const subs = subreddits || DEFAULT_SUBS;
    const allPosts: RedditPost[] = [];
    const errors: string[] = [];

    for (const sub of subs) {
        try {
            const sort = SCAN_MODES[sub] || 'new';
            const posts = await scanSubreddit(sub, limitPerSub, keywords, sort);
            allPosts.push(...posts);
            // Rate limit: 1 second between requests
            await new Promise(r => setTimeout(r, 1000));
        } catch (e: any) {
            errors.push(`r/${sub}: ${e.message}`);
        }
    }

    // Sort by recency
    allPosts.sort((a, b) => b.createdUtc - a.createdUtc);

    // Deduplicate by id
    const seen = new Set<string>();
    const unique = allPosts.filter(p => {
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
    });

    return {
        posts: unique,
        errors,
        scannedAt: new Date().toISOString(),
        subredditsScanned: subs,
    };
}

export async function searchReddit(
    query: string,
    subreddit?: string,
    limit: number = 25,
): Promise<RedditPost[]> {
    const sub = subreddit || 'all';
    const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(query)}&sort=new&limit=${limit}&restrict_sr=on`;
    const json = await fetchRedditJSON(url);

    if (!json?.data?.children) return [];

    return json.data.children.map((child: any) => parsePost(child));
}

/**
 * Format scan results as a readable report for Feishu.
 */
export function formatScanReport(result: ScanResult): string {
    if (result.posts.length === 0) {
        return `📊 Reddit 扫描完成 (${result.subredditsScanned.join(', ')})\n未发现匹配的痛点帖子。`;
    }

    const lines: string[] = [
        `📊 Reddit 痛点扫描 — ${result.posts.length} 条发现`,
        `扫描: ${result.subredditsScanned.join(', ')}`,
        `时间: ${result.scannedAt}`,
        '─'.repeat(30),
    ];

    for (const post of result.posts.slice(0, 10)) {
        lines.push('');
        lines.push(`📌 ${post.title}`);
        lines.push(`   r/${post.subreddit} | ⬆${post.score} | 💬${post.numComments} | ${post.ageHours}h ago`);
        lines.push(`   关键词: ${post.keywordsMatched.join(', ')}`);
        lines.push(`   🔗 ${post.url}`);
        if (post.body) {
            lines.push(`   > ${post.body.slice(0, 200)}...`);
        }
    }

    if (result.errors.length > 0) {
        lines.push('');
        lines.push(`⚠️ 错误: ${result.errors.join('; ')}`);
    }

    return lines.join('\n');
}
