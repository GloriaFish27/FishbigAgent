import fs from 'fs';
import https from 'https';
import os from 'os';

const decode = (s) => Buffer.from(s, 'base64').toString();
const AG_CLIENT_ID = decode('MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==');
const AG_CLIENT_SECRET = decode('R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=');
const AG_ENDPOINT = 'daily-cloudcode-pa.sandbox.googleapis.com';
const AG_PATH = '/v1internal:streamGenerateContent?alt=sse';

async function testAuth() {
    console.log("🐟 === FishbigAgent Cloud Code API Test ===");
    console.log(`🐟 Time: ${new Date().toISOString()}`);
    
    const authPath = `${os.homedir()}/.openclaw/agents/main/agent/auth-profiles.json`;
    let data;
    try {
        data = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    } catch (e) {
        console.error("❌ Could not read auth-profiles.json:", e.message);
        return;
    }

    const profiles = data.profiles || {};
    // Use whatever google-antigravity profile is available
    const profileKey = Object.keys(profiles).find(k => k.startsWith('google-antigravity:'));
    if (!profileKey) {
        console.error("❌ No google-antigravity profile found.");
        console.error("Available profiles:", Object.keys(profiles).join(', '));
        return;
    }

    const profile = profiles[profileKey];
    console.log(`✅ Found profile: ${profileKey}`);
    console.log(`   Email: ${profile.email}`);
    console.log(`   Project: ${profile.projectId}`);

    const refreshToken = profile.refresh;
    const projectId = profile.projectId || 'vital-landing-p27sp';

    console.log("\n🐟 Step 1: Refreshing OAuth token...");

    const params = new URLSearchParams({
        client_id: AG_CLIENT_ID,
        client_secret: AG_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
    });

    const body = params.toString();
    
    const tokenResult = await new Promise((resolve, reject) => {
        const req = https.request({
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
                try {
                    resolve(JSON.parse(respData));
                } catch {
                    reject(new Error('Invalid JSON: ' + respData.slice(0, 200)));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });

    if (!tokenResult.access_token) {
        console.error("❌ Token refresh failed:", JSON.stringify(tokenResult).slice(0, 300));
        return;
    }
    console.log('✅ Token refreshed successfully!');
    console.log(`   Token type: ${tokenResult.token_type}`);
    console.log(`   Scopes: ${tokenResult.scope || 'N/A'}`);

    // Test Cloud Code API
    console.log(`\n🐟 Step 2: Testing Cloud Code API at ${AG_ENDPOINT}...`);
    const apiBody = JSON.stringify({
        project: projectId,
        model: 'claude-sonnet-4-6',
        requestType: 'agent',
        userAgent: 'antigravity',
        requestId: `agent-${Date.now()}`,
        request: {
            contents: [{ role: 'user', parts: [{ text: "Say 'FishbigAgent test OK' and nothing else." }] }],
            generationConfig: { maxOutputTokens: 50 }
        }
    });

    const apiResult = await new Promise((resolve, reject) => {
        const req = https.request({
            hostname: AG_ENDPOINT,
            path: AG_PATH,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tokenResult.access_token}`,
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(apiBody)),
                'x-goog-api-client': 'google-cloud-sdk',
                'x-goog-user-project': projectId,
            },
        }, (res) => {
            let raw = '';
            res.on('data', c => (raw += c));
            res.on('end', () => resolve({ status: res.statusCode, body: raw, headers: res.headers }));
        });
        req.on('error', reject);
        req.write(apiBody);
        req.end();
    });

    console.log(`\n📊 === RESULT ===`);
    console.log(`   HTTP Status: ${apiResult.status}`);
    
    if (apiResult.status === 200) {
        console.log("🎉 SUCCESS! Cloud Code API is working!");
        // Try to extract text from SSE response
        const lines = apiResult.body.split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines.slice(0, 3)) {
            try {
                const d = JSON.parse(line.replace('data: ', ''));
                const text = d?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) console.log(`   Model says: ${text}`);
            } catch {}
        }
    } else {
        console.log(`❌ FAILED with status ${apiResult.status}`);
        console.log(`   Response: ${apiResult.body.substring(0, 500)}`);
        
        if (apiResult.status === 403) {
            console.log("\n💡 403 Troubleshooting:");
            console.log("   1. Check if the project has Owner + Service Usage Consumer roles");
            console.log("   2. Try restarting the IDE to get a fresh token");
            console.log("   3. IAM propagation can take up to 7 minutes");
        }
    }
}

testAuth();
