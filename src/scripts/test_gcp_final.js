import fs from 'fs';
import https from 'https';
import os from 'os';

const decode = (s) => Buffer.from(s, 'base64').toString();
const AG_CLIENT_ID = decode('MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==');
const AG_CLIENT_SECRET = decode('R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=');
const AG_ENDPOINT = 'daily-cloudcode-pa.sandbox.googleapis.com';
const AG_PATH = '/v1internal:streamGenerateContent?alt=sse';

async function testAuth() {
    console.log("🐟 Extracting agent credentials from ~/.openclaw/agents/main/agent/auth-profiles.json");

    // Read the auth profile
    const authPath = `${os.homedir()}/.openclaw/agents/main/agent/auth-profiles.json`;
    let data;
    try {
        data = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    } catch (e) {
        console.error("❌ Could not read auth-profiles.json");
        return;
    }

    const profiles = data.profiles || {};
    const profileKey = Object.keys(profiles).find(k => k === 'google-antigravity:leokadiakusmierczuk711@gmail.com');
    if (!profileKey) {
        console.error("❌ No google-antigravity profile found for leokadiakusmierczuk711@gmail.com in auth-profiles.json.");
        console.error("Available profiles:", Object.keys(profiles).join(', '));
        return;
    }

    const profile = profiles[profileKey];
    console.log(`✅ Found profile for: ${profile.email}`);

    const refreshToken = profile.refresh;
    const projectId = profile.projectId || 'vital-landing-p27sp';

    console.log("🐟 Refreshing OAuth token...");

    const params = new URLSearchParams({
        client_id: AG_CLIENT_ID,
        client_secret: AG_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
    });

    const body = params.toString();
    const tokenReq = https.request({
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': String(Buffer.byteLength(body))
        },
    }, (res) => {
        let respData = '';
        res.on('data', c => (respData += c));
        res.on('end', () => {
            const json = JSON.parse(respData);
            if (!json.access_token) {
                console.error("❌ Token refresh failed:", respData.slice(0, 200));
                return;
            }
            console.log('✅ Token refreshed successfully!');

            // Now test the API
            console.log(`🐟 Sending prompt to ${AG_ENDPOINT}...`);
            const apiBody = JSON.stringify({
                project: projectId,
                model: 'claude-sonnet-4-6',
                requestType: 'agent',
                userAgent: 'antigravity',
                requestId: `agent-${Date.now()}`,
                request: {
                    contents: [{ role: 'user', parts: [{ text: "Hello, this is a test from FishbigAgent daemon. Do I have access?" }] }],
                    generationConfig: { maxOutputTokens: 100 }
                }
            });

            const apiReq = https.request({
                hostname: AG_ENDPOINT,
                path: AG_PATH,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${json.access_token}`,
                    'Content-Type': 'application/json',
                    'Content-Length': String(Buffer.byteLength(apiBody)),
                    'x-goog-api-client': 'google-cloud-sdk',
                    'x-goog-user-project': projectId,
                },
            }, (apiRes) => {
                let raw = '';
                apiRes.on('data', c => (raw += c));
                apiRes.on('end', () => {
                    if (apiRes.statusCode === 200) {
                        console.log("✅ API Request SUCCESS! The new account has permission to use the Cloud Code API.");
                    } else {
                        console.log(`❌ API Request FAILED with status ${apiRes.statusCode}`);
                        if (raw.includes('Request had insufficient authentication scopes') || raw.includes('403')) {
                            console.log("❌ The GCP API is still returning 403 Forbidden. User may need administrator approval for Cloud Code access.");
                        }
                        console.log("Response Snippet:", raw.substring(0, 300));
                    }
                });
            });
            apiReq.on('error', console.error);
            apiReq.write(apiBody);
            apiReq.end();
        });
    });
    tokenReq.on('error', console.error);
    tokenReq.write(body);
    tokenReq.end();
}

testAuth();
