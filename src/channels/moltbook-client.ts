/**
 * Moltbook API Client
 *
 * Moltbook — the social network for AI agents.
 * FishbigAgent registers, posts to m/agentcommerce,
 * and discovers collaboration opportunities.
 *
 * API Docs: https://moltbook.com/skill.md
 * Auth: Bearer token from /api/v1/agents/register
 */

// ─── Types ─────────────────────────────────────────────────────

export interface MoltbookAgent {
    apiKey: string;
    agentId: string;
    name: string;
}

export interface MoltbookPost {
    id?: string;
    submolt: string;
    title: string;
    content: string;
}

// ─── Client ────────────────────────────────────────────────────

const BASE_URL = 'https://www.moltbook.com';

export class MoltbookClient {
    private apiKey: string;
    private agentName: string;

    constructor(apiKey: string, agentName: string = 'FishbigAgent') {
        this.apiKey = apiKey;
        this.agentName = agentName;
    }

    private async _request(method: string, path: string, body?: any): Promise<any> {
        const url = `${BASE_URL}${path}`;
        const headers: Record<string, string> = {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': `FishbigAgent/1.0 (${this.agentName})`,
        };

        const res = await fetch(url, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Moltbook API ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
        }

        return res.json();
    }

    /**
     * Register a new agent on Moltbook.
     * Returns API key for future requests.
     */
    static async register(name: string, description: string): Promise<MoltbookAgent> {
        const res = await fetch(`${BASE_URL}/api/v1/agents/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description }),
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Moltbook register failed: ${res.status} ${text.slice(0, 200)}`);
        }

        const data = await res.json();
        return {
            apiKey: data.api_key || data.apiKey || '',
            agentId: data.agent_id || data.agentId || data.id || '',
            name,
        };
    }

    /**
     * Create a post in a submolt (community).
     */
    async createPost(submolt: string, title: string, content: string): Promise<any> {
        return this._request('POST', '/api/v1/posts', {
            submolt_name: submolt,
            title,
            content,
        });
    }

    /**
     * Post to m/agentcommerce — the marketplace for AI agents.
     */
    async postToAgentCommerce(title: string, content: string): Promise<any> {
        return this.createPost('agentcommerce', title, content);
    }

    /**
     * Get posts from a submolt.
     */
    async getPosts(submolt: string, limit: number = 25): Promise<any> {
        return this._request('GET', `/api/v1/submolts/${submolt}/posts?limit=${limit}`);
    }

    /**
     * Browse agentcommerce for opportunities.
     */
    async browseOpportunities(): Promise<any> {
        return this.getPosts('agentcommerce', 50);
    }
}

/**
 * Register FishbigAgent on Moltbook and save the API key.
 */
export async function registerFishbigAgent(): Promise<MoltbookAgent> {
    return MoltbookClient.register(
        'FishbigAgent 鱼大Agent',
        'Autonomous AI agent with browser automation, vision, and multi-language capabilities. ' +
        'Specializes in: competitive research, data collection, content creation, and market intelligence. ' +
        'Powered by Playwright + Stealth + Vision API. Available for hire on browser-based tasks.',
    );
}
