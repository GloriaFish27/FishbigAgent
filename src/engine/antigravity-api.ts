/**
 * AntigravityAPI — Cloud Code Assist API client
 *
 * Uses GoogleAuth for independent token management.
 * Calls: daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent
 *
 * Critical: User-Agent MUST be "antigravity/VERSION darwin/arm64" to pass the API gateway.
 */
import https from 'https';
import type { GoogleAuth } from '../auth/google-auth.js';

const ENDPOINTS = [
    'daily-cloudcode-pa.sandbox.googleapis.com',
    'cloudcode-pa.googleapis.com',
];
const API_PATH = '/v1internal:streamGenerateContent?alt=sse';
const ANTIGRAVITY_VERSION = '1.15.8';

export interface ChatMessage {
    role: 'user' | 'model';
    text: string;
    /** Optional base64-encoded images for multimodal input */
    images?: string[];
}

/** Model routing table — verified available */
export const MODELS = {
    chatPrimary: 'claude-sonnet-4-6',
    chatFallback: 'gemini-3-flash',
    taskPrimary: 'claude-opus-4-6-thinking',
    taskFallback: 'gemini-3-flash',
    compact: 'gemini-3-flash',
} as const;

export type SpendCallback = (model: string, inputTokens: number, outputTokens: number) => void;

export class AntigravityAPI {
    private auth: GoogleAuth;
    private onSpend?: SpendCallback;

    constructor(auth: GoogleAuth, onSpend?: SpendCallback) {
        this.auth = auth;
        this.onSpend = onSpend;
    }

    get ready(): boolean {
        return this.auth.ready;
    }

    /**
     * Complete a chat with auto-fallback on rate limit.
     */
    async chat(
        messages: ChatMessage[],
        systemPrompt: string,
        primaryModel: string,
        fallbackModel: string,
    ): Promise<string> {
        try {
            return await this._call(messages, systemPrompt, primaryModel);
        } catch (err) {
            const msg = (err as Error).message ?? '';
            if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('rate') || msg.includes('503')) {
                console.log(`[AG-API] Rate limited on ${primaryModel}, falling back to ${fallbackModel}`);
                return this._call(messages, systemPrompt, fallbackModel);
            }
            throw err;
        }
    }

    /** Simple single-prompt completion */
    async complete(prompt: string, systemPrompt: string, model: string): Promise<string> {
        return this._call([{ role: 'user', text: prompt }], systemPrompt, model);
    }

    private async _call(messages: ChatMessage[], systemPrompt: string, model: string): Promise<string> {
        const token = await this.auth.getAccessToken();
        const project = this.auth.companionProject;
        if (!project) throw new Error('No companion project. Run: npm run login');

        const contents = messages.map(m => {
            const parts: Array<Record<string, unknown>> = [{ text: m.text }];
            // Add image parts for multimodal messages
            if (m.images?.length) {
                for (const img of m.images) {
                    parts.push({
                        inline_data: {
                            mime_type: 'image/png',
                            data: img,
                        },
                    });
                }
            }
            return {
                role: m.role === 'model' ? 'model' : 'user',
                parts,
            };
        });

        const innerRequest: Record<string, unknown> = {
            contents,
            generationConfig: { maxOutputTokens: 8192 },
        };
        if (systemPrompt) {
            innerRequest['systemInstruction'] = { role: 'user', parts: [{ text: systemPrompt }] };
        }

        const body: Record<string, unknown> = {
            project,
            model,
            request: innerRequest,
            requestType: 'agent',
            userAgent: 'antigravity',
            requestId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        };

        // Try endpoints in order (daily first, prod fallback)
        let lastResult: { status: number; body: string } = { status: 0, body: '' };
        for (const endpoint of ENDPOINTS) {
            lastResult = await this._post(token, endpoint, body);
            if (lastResult.status === 200) break;
            // 404 on first endpoint → try next (model might not be on daily)
            if (lastResult.status === 404) continue;
            break; // other errors → don't retry
        }

        // 401 → force token refresh and retry once
        if (lastResult.status === 401) {
            console.log('[AG-API] Token expired (401), refreshing...');
            const freshToken = await this.auth.getAccessToken();
            lastResult = await this._post(freshToken, ENDPOINTS[0], body);
        }

        const text = this._extractText(lastResult);

        // ── Token estimation + spend tracking ──
        if (this.onSpend) {
            const inputChars = messages.reduce((sum, m) => sum + m.text.length, 0) + systemPrompt.length;
            const outputChars = text.length;
            // Rough estimate: ~4 chars per token for mixed CJK/English
            const inputTokens = Math.ceil(inputChars / 3);
            const outputTokens = Math.ceil(outputChars / 3);
            try {
                this.onSpend(model, inputTokens, outputTokens);
            } catch { }
        }

        return text;
    }

    private _post(
        token: string,
        endpoint: string,
        body: Record<string, unknown>,
    ): Promise<{ status: number; body: string }> {
        const bodyStr = JSON.stringify(body);
        return new Promise((resolve) => {
            const req = https.request({
                hostname: endpoint,
                path: API_PATH,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    'Content-Length': String(Buffer.byteLength(bodyStr)),
                    // Critical: must match Antigravity IDE's User-Agent
                    'User-Agent': `antigravity/${ANTIGRAVITY_VERSION} darwin/arm64`,
                    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
                    'Client-Metadata': JSON.stringify({
                        ideType: 'IDE_UNSPECIFIED',
                        platform: 'PLATFORM_UNSPECIFIED',
                        pluginType: 'GEMINI',
                    }),
                },
            }, (res) => {
                let raw = '';
                res.on('data', c => (raw += c));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }));
            });
            req.on('error', (e) => resolve({ status: 0, body: e.message }));
            req.setTimeout(180000, () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
            req.write(bodyStr);
            req.end();
        });
    }

    private _extractText(result: { status: number; body: string }): string {
        if (result.status === 429 || result.body.includes('RESOURCE_EXHAUSTED')) {
            throw new Error(`429 rate limited`);
        }
        if (result.status === 503) {
            throw new Error(`503 no capacity`);
        }
        if (result.status === 404) {
            throw new Error(`404 model not found: ${result.body.slice(0, 200)}`);
        }
        if (result.status !== 200 && result.status !== 0) {
            throw new Error(`API error (${result.status}): ${result.body.slice(0, 300)}`);
        }

        const chunks = result.body.split('\n').filter(l => l.startsWith('data: '));
        const parts: string[] = [];
        for (const chunk of chunks) {
            try {
                const json = JSON.parse(chunk.slice(6)) as {
                    response?: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
                    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
                };
                const candidates = json.response?.candidates ?? json.candidates;
                const text = candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) parts.push(text);
            } catch { /* ignore */ }
        }
        const text = parts.join('').trim();
        if (!text) throw new Error(`AG empty response (${result.status}): ${result.body.slice(0, 200)}`);
        return text;
    }
}
