/**
 * fishbig login — Standalone OAuth PKCE login for FishbigAgent
 *
 * Usage: npm run login
 *
 * Opens browser → Google sign-in → stores refresh token in data/auth.json
 * Zero dependency on OpenClaw or Antigravity IDE.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleAuth, CLIENT_ID, CLIENT_SECRET, TOKEN_URL } from './google-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

const REDIRECT_URI = 'http://localhost:51121/oauth-callback';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

const SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
];

// ── PKCE helpers ──────────────────────────────────────────

function generatePkce(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString('hex');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

// ── OAuth callback server ─────────────────────────────────

async function waitForCallback(timeoutMs = 5 * 60 * 1000): Promise<{ code: string; state: string }> {
    return new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
            if (!req.url) {
                res.writeHead(400);
                res.end('Missing URL');
                return;
            }

            const url = new URL(req.url, 'http://localhost:51121');
            if (url.pathname !== '/oauth-callback') {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!DOCTYPE html><html><body>
                <h1>✅ Login successful!</h1>
                <p>You can close this tab and return to the terminal.</p>
            </body></html>`);

            server.close();
            clearTimeout(timer);

            if (code && state) {
                resolve({ code, state });
            } else {
                reject(new Error('Missing code or state in callback'));
            }
        });

        const timer = setTimeout(() => {
            server.close();
            reject(new Error('Login timed out (5 minutes). Try again.'));
        }, timeoutMs);

        server.listen(51121, '127.0.0.1', () => {
            // ready
        });

        server.on('error', (err) => {
            clearTimeout(timer);
            reject(new Error(`Could not start callback server: ${err.message}`));
        });
    });
}

// ── Token exchange ────────────────────────────────────────

async function exchangeCode(code: string, verifier: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
}> {
    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Token exchange failed: ${text}`);
    }

    const data = await response.json() as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
    };

    if (!data.access_token) throw new Error('No access_token in response');
    if (!data.refresh_token) throw new Error('No refresh_token in response');

    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in ?? 3600,
    };
}

// ── Fetch user email ──────────────────────────────────────

async function fetchEmail(accessToken: string): Promise<string> {
    const response = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return 'unknown';
    const data = await response.json() as { email?: string };
    return data.email ?? 'unknown';
}

// ── Main login flow ───────────────────────────────────────

async function main(): Promise<void> {
    console.log('');
    console.log('🐟 FishbigAgent Login');
    console.log('═══════════════════════════════════════');
    console.log('');

    // Generate PKCE
    const { verifier, challenge } = generatePkce();
    const state = randomBytes(16).toString('hex');

    // Build auth URL
    const authUrl = new URL(AUTH_URL);
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('scope', SCOPES.join(' '));
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    // Start callback server BEFORE opening browser
    const callbackPromise = waitForCallback();

    // Open browser
    console.log('📂 Opening browser for Google sign-in...');
    console.log('');
    try {
        execSync(`open "${authUrl.toString()}"`, { stdio: 'ignore' });
    } catch {
        console.log('⚠️  Could not open browser. Open this URL manually:');
        console.log('');
        console.log(authUrl.toString());
        console.log('');
    }

    console.log('⏳ Waiting for sign-in callback...');

    // Wait for OAuth callback
    const callback = await callbackPromise;

    if (callback.state !== state) {
        throw new Error('OAuth state mismatch! Try again.');
    }

    console.log('✅ Received auth code');

    // Exchange code for tokens
    console.log('🔄 Exchanging code for tokens...');
    const tokens = await exchangeCode(callback.code, verifier);

    // Fetch user email
    console.log('📧 Fetching user info...');
    const email = await fetchEmail(tokens.access_token);

    // Fetch companion project
    console.log('🏗️  Fetching companion project...');
    const auth = new GoogleAuth(DATA_DIR);
    const companionProject = await auth.fetchCompanionProject(tokens.access_token);

    // Save credentials
    auth.save({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        email,
        companionProject,
    });

    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('🎉 Login successful!');
    console.log('');
    console.log(`   Account:   ${email}`);
    console.log(`   Project:   ${companionProject}`);
    console.log(`   Saved to:  data/auth.json`);
    console.log('');
    console.log('You can now start the daemon: npm run dev');
    console.log('');
}

main().catch((err) => {
    console.error(`\n❌ Login failed: ${(err as Error).message}\n`);
    process.exit(1);
});
