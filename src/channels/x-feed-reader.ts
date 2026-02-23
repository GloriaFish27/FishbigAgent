/**
 * X.com Feed Reader — Fetch Following Timeline via GraphQL API
 *
 * Uses the same auth mechanism as baoyu-danger-x-to-markdown:
 * bearer token + auth_token + ct0 cookies → X GraphQL API
 *
 * Reads cookies from ~/.config/xcom/cookies.json (FishbigAgent format)
 * and falls back to ~/.baoyu-skills/.env (X_AUTH_TOKEN + X_CT0)
 */
import fs from 'fs';
import path from 'path';

// ─── Types ─────────────────────────────────────────────────────

export interface XTweet {
    id: string;
    author: string;
    handle: string;
    text: string;
    url: string;
    createdAt: string;
    likes: number;
    retweets: number;
    replies: number;
    views: number;
    mediaUrls: string[];
    isRetweet: boolean;
    quotedTweet?: { author: string; text: string };
}

// ─── Constants (same as baoyu-danger-x-to-markdown) ────────────

const BEARER_TOKEN =
    'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// HomeLatestTimeline query ID — resolved dynamically from X.com JS bundles
let cachedQueryId: string | null = null;

async function resolveHomeLatestQueryId(): Promise<string> {
    if (cachedQueryId) return cachedQueryId;

    const FALLBACK_ID = 'HJFjzBgCs16TqxewQOeLNg';  // may change over time

    try {
        // Step 1: Fetch x.com HTML to find main JS chunk hash
        const htmlRes = await fetch('https://x.com', {
            headers: { 'user-agent': USER_AGENT },
        });
        const html = await htmlRes.text();

        const mainHashMatch = html.match(
            /main\.([a-f0-9]+)a\.js/
        );
        if (!mainHashMatch) {
            console.log('[X-FEED] Could not find main chunk hash, using fallback query ID');
            cachedQueryId = FALLBACK_ID;
            return FALLBACK_ID;
        }

        // Step 2: Fetch the main JS chunk
        const chunkUrl = `https://abs.twimg.com/responsive-web/client-web/main.${mainHashMatch[1]}a.js`;
        const chunkRes = await fetch(chunkUrl, {
            headers: { 'user-agent': USER_AGENT },
        });
        const chunk = await chunkRes.text();

        // Step 3: Find HomeLatestTimeline query ID
        const queryMatch = chunk.match(
            /queryId:"([^"]+)",operationName:"HomeLatestTimeline"/
        );
        if (queryMatch) {
            cachedQueryId = queryMatch[1];
            console.log(`[X-FEED] Resolved HomeLatestTimeline queryId: ${cachedQueryId}`);
            return cachedQueryId;
        }

        // Also try alternative patterns
        const altMatch = chunk.match(
            /operationName:"HomeLatestTimeline"[^}]*?queryId:"([^"]+)"/
        );
        if (altMatch) {
            cachedQueryId = altMatch[1];
            console.log(`[X-FEED] Resolved HomeLatestTimeline queryId (alt): ${cachedQueryId}`);
            return cachedQueryId;
        }

        console.log('[X-FEED] Could not find HomeLatestTimeline in JS, using fallback');
        cachedQueryId = FALLBACK_ID;
        return FALLBACK_ID;
    } catch (e: any) {
        console.error('[X-FEED] Query ID resolution failed:', e.message);
        cachedQueryId = FALLBACK_ID;
        return FALLBACK_ID;
    }
}

const HOME_FEATURES: Record<string, boolean> = {
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_enhance_cards_enabled: false,
    premium_content_api_read_enabled: false,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    responsive_web_grok_share_attachment_enabled: true,
    responsive_web_grok_image_annotation_enabled: true,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_jetfuel_frame: false,
};

// ─── Cookie Loading ────────────────────────────────────────────

function loadCookies(): { auth_token: string; ct0: string } | null {
    // Priority 1: FishbigAgent's own cookies.json
    const fishbigPath = path.join(
        process.env.HOME || '~',
        '.config/xcom/cookies.json'
    );
    try {
        if (fs.existsSync(fishbigPath)) {
            const data = JSON.parse(fs.readFileSync(fishbigPath, 'utf-8'));
            if (data.auth_token && data.ct0) {
                return { auth_token: data.auth_token, ct0: data.ct0 };
            }
        }
    } catch { }

    // Priority 2: baoyu-skills .env
    const envPath = path.join(process.env.HOME || '~', '.baoyu-skills/.env');
    try {
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf-8');
            const auth = content.match(/X_AUTH_TOKEN=(.+)/)?.[1]?.trim();
            const ct0 = content.match(/X_CT0=(.+)/)?.[1]?.trim();
            if (auth && ct0) return { auth_token: auth, ct0 };
        }
    } catch { }

    // Priority 3: environment variables
    const envAuth = process.env.X_AUTH_TOKEN?.trim();
    const envCt0 = process.env.X_CT0?.trim();
    if (envAuth && envCt0) return { auth_token: envAuth, ct0: envCt0 };

    return null;
}

// ─── GraphQL Request ───────────────────────────────────────────

async function fetchHomeTimeline(count: number = 20): Promise<any> {
    const cookies = loadCookies();
    if (!cookies) throw new Error('No X.com cookies found');

    const queryId = await resolveHomeLatestQueryId();

    const variables = {
        count,
        includePromotedContent: false,
        latestControlAvailable: true,
        requestContext: 'launch',
    };

    const params = new URLSearchParams({
        variables: JSON.stringify(variables),
        features: JSON.stringify(HOME_FEATURES),
    });

    const url = `https://x.com/i/api/graphql/${queryId}/HomeLatestTimeline?${params}`;

    const headers: Record<string, string> = {
        authorization: BEARER_TOKEN,
        'user-agent': USER_AGENT,
        accept: 'application/json',
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-client-language': 'en',
        'x-csrf-token': cookies.ct0,
        cookie: `auth_token=${cookies.auth_token}; ct0=${cookies.ct0}`,
    };

    const res = await fetch(url, { headers });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`X API error ${res.status}: ${text.slice(0, 200)}`);
    }

    return res.json();
}

// ─── Response Parsing ──────────────────────────────────────────

function extractTweetsFromTimeline(data: any): XTweet[] {
    const tweets: XTweet[] = [];

    try {
        const instructions =
            data?.data?.home?.home_timeline_urt?.instructions ?? [];

        for (const instruction of instructions) {
            if (instruction.type !== 'TimelineAddEntries') continue;

            for (const entry of instruction.entries ?? []) {
                const content = entry.content;
                if (!content) continue;

                // Regular tweet entry
                if (content.entryType === 'TimelineTimelineItem') {
                    const tweet = extractTweetFromResult(
                        content.itemContent?.tweet_results?.result
                    );
                    if (tweet) tweets.push(tweet);
                }

                // Conversation module (thread)
                if (content.entryType === 'TimelineTimelineModule') {
                    for (const item of content.items ?? []) {
                        const tweet = extractTweetFromResult(
                            item.item?.itemContent?.tweet_results?.result
                        );
                        if (tweet) tweets.push(tweet);
                    }
                }
            }
        }
    } catch (e: any) {
        console.error('[X-FEED] Parse error:', e.message);
    }

    return tweets;
}

function extractTweetFromResult(result: any): XTweet | null {
    if (!result) return null;

    // Handle TweetWithVisibilityResults wrapper
    if (result.__typename === 'TweetWithVisibilityResults') {
        result = result.tweet;
    }

    const core = result?.core?.user_results?.result;
    const legacy = result?.legacy;
    if (!legacy || !core) return null;

    const user = core.legacy;
    const handle = user?.screen_name ?? '';
    const author = user?.name ?? handle;

    // Check if retweet
    const isRetweet = !!legacy.retweeted_status_result;
    let text = legacy.full_text ?? '';
    let actualAuthor = author;
    let actualHandle = handle;

    if (isRetweet && legacy.retweeted_status_result?.result) {
        const rt = legacy.retweeted_status_result.result;
        if (rt.__typename === 'TweetWithVisibilityResults') {
            const rtTweet = rt.tweet;
            const rtUser = rtTweet?.core?.user_results?.result?.legacy;
            text = rtTweet?.legacy?.full_text ?? text;
            actualAuthor = rtUser?.name ?? author;
            actualHandle = rtUser?.screen_name ?? handle;
        } else {
            const rtUser = rt.core?.user_results?.result?.legacy;
            text = rt.legacy?.full_text ?? text;
            actualAuthor = rtUser?.name ?? author;
            actualHandle = rtUser?.screen_name ?? handle;
        }
    }

    // Extract media URLs
    const mediaUrls: string[] = [];
    const entities = legacy.extended_entities ?? legacy.entities;
    if (entities?.media) {
        for (const m of entities.media) {
            if (m.media_url_https) mediaUrls.push(m.media_url_https);
        }
    }

    // Quoted tweet
    let quotedTweet: { author: string; text: string } | undefined;
    if (legacy.quoted_status_result?.result) {
        const q = legacy.quoted_status_result.result;
        const qResult = q.__typename === 'TweetWithVisibilityResults' ? q.tweet : q;
        const qUser = qResult?.core?.user_results?.result?.legacy;
        quotedTweet = {
            author: qUser?.screen_name ?? '?',
            text: (qResult?.legacy?.full_text ?? '').slice(0, 200),
        };
    }

    // Views
    const views = parseInt(result.views?.count ?? '0', 10) || 0;

    return {
        id: legacy.id_str ?? result.rest_id ?? '',
        author: isRetweet ? `${author} RT @${actualHandle}` : actualAuthor,
        handle: isRetweet ? actualHandle : handle,
        text: cleanTweetText(text),
        url: `https://x.com/${actualHandle}/status/${legacy.id_str ?? result.rest_id}`,
        createdAt: legacy.created_at ?? '',
        likes: legacy.favorite_count ?? 0,
        retweets: legacy.retweet_count ?? 0,
        replies: legacy.reply_count ?? 0,
        views,
        mediaUrls,
        isRetweet,
        quotedTweet,
    };
}

function cleanTweetText(text: string): string {
    // Remove t.co URLs at the end
    return text.replace(/\s*https:\/\/t\.co\/\w+$/g, '').trim();
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Fetch the "Following" timeline (reverse chronological).
 * Returns the most recent tweets from accounts the user follows.
 */
export async function fetchFollowingTimeline(
    count: number = 30
): Promise<XTweet[]> {
    console.log(`[X-FEED] Fetching following timeline (${count} tweets)...`);

    const data = await fetchHomeTimeline(count);
    const tweets = extractTweetsFromTimeline(data);

    // Deduplicate by ID (timeline can have dupes in threads)
    const seen = new Set<string>();
    const unique = tweets.filter((t) => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
    });

    console.log(
        `[X-FEED] Got ${unique.length} unique tweets from following timeline`
    );
    return unique;
}

/**
 * Fetch and format tweets for the daily briefing.
 * Returns BriefingSection-compatible items.
 */
export async function collectXcomData(): Promise<{
    title: string;
    items: Array<{
        title: string;
        summary: string;
        url: string;
        score?: number;
        source: string;
    }>;
}> {
    try {
        const tweets = await fetchFollowingTimeline(30);

        // Filter: skip pure retweets, keep original tweets + quoted
        const meaningful = tweets
            .filter((t) => !t.isRetweet || t.quotedTweet)
            .filter((t) => t.text.length > 20);

        // Sort by engagement (likes + retweets)
        meaningful.sort(
            (a, b) => b.likes + b.retweets - (a.likes + a.retweets)
        );

        const items = meaningful.slice(0, 15).map((t) => ({
            title: `@${t.handle}: ${t.text.slice(0, 80)}${t.text.length > 80 ? '...' : ''}`,
            summary: t.text.slice(0, 200),
            url: t.url,
            score: t.likes + t.retweets,
            source: `X @${t.handle}`,
        }));

        return {
            title: '🐦 X.com 关注动态',
            items:
                items.length > 0
                    ? items
                    : [
                        {
                            title: '暂无新推文',
                            summary:
                                'Follow 列表最近没有新内容',
                            url: 'https://x.com/home',
                            source: 'X.com',
                        },
                    ],
        };
    } catch (e: any) {
        console.error('[X-FEED] Failed to collect X.com data:', e.message);
        return {
            title: '🐦 X.com 关注动态',
            items: [
                {
                    title: '⚠️ X.com 数据抓取失败',
                    summary: e.message,
                    url: 'https://x.com/home',
                    source: 'X.com',
                },
            ],
        };
    }
}
