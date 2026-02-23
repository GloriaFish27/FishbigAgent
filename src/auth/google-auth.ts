/**
 * GoogleAuth — Independent OAuth token management for Cloud Code Assist API
 *
 * Handles:
 *  - Loading/saving credentials from data/auth.json
 *  - Auto-refreshing access tokens via oauth2.googleapis.com
 *  - Fetching the companion project via loadCodeAssist
 *
 * Zero dependency on OpenClaw or Antigravity IDE.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';

// Same OAuth client as Antigravity IDE / OpenClaw
const CLIENT_ID = Buffer.from(
    'MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==',
    'base64',
).toString();
const CLIENT_SECRET = Buffer.from(
    'R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=',
    'base64',
).toString();

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CODE_ASSIST_ENDPOINTS = [
    'https://cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
];

export interface StoredCredentials {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;        // epoch ms
    email: string;
    companionProject: string; // from loadCodeAssist
}

export class GoogleAuth {
    private creds: StoredCredentials | null = null;
    private credPath: string;
    private refreshing: Promise<void> | null = null;

    constructor(dataDir: string) {
        this.credPath = path.join(dataDir, 'auth.json');
    }

    /** Whether we have stored credentials */
    get ready(): boolean {
        return this.creds !== null && !!this.creds.refreshToken;
    }

    get email(): string {
        return this.creds?.email ?? 'unknown';
    }

    get companionProject(): string {
        return this.creds?.companionProject ?? '';
    }

    /** Load credentials from data/auth.json */
    load(): boolean {
        try {
            const raw = fs.readFileSync(this.credPath, 'utf-8');
            this.creds = JSON.parse(raw) as StoredCredentials;
            console.log(`[AUTH] Credentials loaded ✓ (${this.creds.email})`);
            return true;
        } catch {
            console.log('[AUTH] No credentials found. Run: npm run login');
            return false;
        }
    }

    /** Save credentials to data/auth.json */
    save(creds: StoredCredentials): void {
        this.creds = creds;
        const dir = path.dirname(this.credPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.credPath, JSON.stringify(creds, null, 2));
        console.log(`[AUTH] Credentials saved ✓ (${creds.email})`);
    }

    /**
     * Get a valid access token. Auto-refreshes if expired.
     * @throws Error if no credentials or refresh fails
     */
    async getAccessToken(): Promise<string> {
        if (!this.creds) throw new Error('Not logged in. Run: npm run login');

        // Check if token is still valid (with 5-min buffer)
        if (Date.now() < this.creds.expiresAt - 5 * 60 * 1000) {
            return this.creds.accessToken;
        }

        // Coalesce concurrent refresh calls
        if (this.refreshing) {
            await this.refreshing;
            return this.creds!.accessToken;
        }

        this.refreshing = this._refreshToken();
        try {
            await this.refreshing;
        } finally {
            this.refreshing = null;
        }
        return this.creds!.accessToken;
    }

    /** Refresh the access token using the stored refresh token */
    private async _refreshToken(): Promise<void> {
        if (!this.creds?.refreshToken) {
            throw new Error('No refresh token. Run: npm run login');
        }

        console.log('[AUTH] Refreshing access token...');

        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: this.creds.refreshToken,
            grant_type: 'refresh_token',
        });

        const result = await this._httpsPost('oauth2.googleapis.com', '/token', params.toString(), {
            'Content-Type': 'application/x-www-form-urlencoded',
        });

        const data = JSON.parse(result) as {
            access_token?: string;
            expires_in?: number;
            error?: string;
            error_description?: string;
        };

        if (!data.access_token) {
            throw new Error(`Token refresh failed: ${data.error_description ?? data.error ?? 'unknown'}`);
        }

        this.creds.accessToken = data.access_token;
        this.creds.expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
        this.save(this.creds);

        console.log('[AUTH] Token refreshed ✓');
    }

    /**
     * Fetch the companion project ID from loadCodeAssist.
     * The companion project is a Google-managed project that has
     * the Cloud Code Private API enabled.
     */
    async fetchCompanionProject(accessToken: string): Promise<string> {
        const body = JSON.stringify({
            metadata: {
                ideType: 'IDE_UNSPECIFIED',
                platform: 'PLATFORM_UNSPECIFIED',
                pluginType: 'GEMINI',
            },
        });

        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity/1.15.8 darwin/arm64',
            'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
        };

        for (const endpoint of CODE_ASSIST_ENDPOINTS) {
            try {
                const url = new URL(`${endpoint}/v1internal:loadCodeAssist`);
                const result = await this._httpsPost(url.hostname, url.pathname, body, headers);
                const data = JSON.parse(result) as {
                    cloudaicompanionProject?: string | { id?: string };
                };

                if (typeof data.cloudaicompanionProject === 'string') {
                    return data.cloudaicompanionProject;
                }
                if (data.cloudaicompanionProject?.id) {
                    return data.cloudaicompanionProject.id;
                }
            } catch {
                // try next endpoint
            }
        }

        throw new Error('Could not fetch companion project from any endpoint');
    }

    /** Simple HTTPS POST helper */
    private _httpsPost(
        hostname: string,
        path: string,
        body: string,
        headers: Record<string, string>,
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const req = https.request(
                {
                    hostname,
                    path,
                    method: 'POST',
                    headers: {
                        ...headers,
                        'Content-Length': String(Buffer.byteLength(body)),
                    },
                },
                (res) => {
                    let data = '';
                    res.on('data', (c) => (data += c));
                    res.on('end', () => {
                        if (res.statusCode && res.statusCode >= 400) {
                            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
                        } else {
                            resolve(data);
                        }
                    });
                },
            );
            req.on('error', reject);
            req.setTimeout(15000, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            req.write(body);
            req.end();
        });
    }
}

// Re-export constants for login script
export { CLIENT_ID, CLIENT_SECRET, TOKEN_URL };
