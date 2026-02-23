/**
 * Article Fetcher — Fetch full article content via Jina Reader
 *
 * Uses https://r.jina.ai/<url> to get clean markdown of any webpage.
 * Includes timeout, retry, and content length limiting.
 */

const JINA_PREFIX = 'https://r.jina.ai/';
const FETCH_TIMEOUT = 12_000;  // 12s per article
const MAX_CONTENT_LENGTH = 3000;  // chars per article (avoid LLM context overflow)

export interface ArticleContent {
    url: string;
    title: string;
    content: string;  // markdown
    imageUrls: string[];  // extracted image URLs
    fetchedAt: string;
    error?: string;
}

/**
 * Fetch full article content from a URL using Jina Reader.
 */
export async function fetchArticleContent(url: string): Promise<ArticleContent> {
    const result: ArticleContent = {
        url,
        title: '',
        content: '',
        imageUrls: [],
        fetchedAt: new Date().toISOString(),
    };

    // Skip non-article URLs
    if (!url || url.includes('x.com') || url.includes('twitter.com') || url.includes('reddit.com/r/')) {
        return result;
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

        const res = await fetch(`${JINA_PREFIX}${url}`, {
            headers: {
                'Accept': 'text/markdown',
                'X-Return-Format': 'markdown',
            },
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
            result.error = `HTTP ${res.status}`;
            return result;
        }

        const markdown = await res.text();

        // Extract title from first H1
        const titleMatch = markdown.match(/^#\s+(.+)$/m);
        result.title = titleMatch?.[1]?.trim() ?? '';

        // Extract image URLs
        const imgMatches = markdown.matchAll(/!\[.*?\]\((https?:\/\/[^)]+)\)/g);
        for (const m of imgMatches) {
            if (m[1] && !m[1].includes('avatar') && !m[1].includes('icon')) {
                result.imageUrls.push(m[1]);
            }
        }

        // Truncate content
        result.content = markdown.slice(0, MAX_CONTENT_LENGTH);
        if (markdown.length > MAX_CONTENT_LENGTH) {
            result.content += '\n\n[... 内容截断，完整文章见原链接]';
        }

        return result;
    } catch (e: any) {
        result.error = e.name === 'AbortError' ? 'timeout' : e.message;
        return result;
    }
}

/**
 * Batch fetch multiple articles in parallel (with concurrency limit).
 */
export async function fetchArticlesBatch(
    urls: string[],
    maxConcurrent: number = 5
): Promise<ArticleContent[]> {
    const results: ArticleContent[] = [];
    const dedupedUrls = [...new Set(urls)].filter(Boolean);

    console.log(`[FETCHER] Fetching ${dedupedUrls.length} articles (max ${maxConcurrent} concurrent)...`);

    // Process in batches
    for (let i = 0; i < dedupedUrls.length; i += maxConcurrent) {
        const batch = dedupedUrls.slice(i, i + maxConcurrent);
        const batchResults = await Promise.all(
            batch.map(url => fetchArticleContent(url))
        );
        results.push(...batchResults);

        const ok = batchResults.filter(r => r.content.length > 100).length;
        console.log(`[FETCHER] Batch ${Math.floor(i / maxConcurrent) + 1}: ${ok}/${batch.length} articles fetched`);
    }

    const successful = results.filter(r => r.content.length > 100);
    console.log(`[FETCHER] Total: ${successful.length}/${dedupedUrls.length} articles with content`);

    return results;
}
