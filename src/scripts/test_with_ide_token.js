import https from 'https';
import { execSync } from 'child_process';

const AG_ENDPOINT = 'daily-cloudcode-pa.sandbox.googleapis.com';
const AG_PATH = '/v1internal:streamGenerateContent?alt=sse';
const PROJECT_ID = 'vital-landing-p27sp';

function getIDEToken() {
    const result = execSync(`python3 -c "
import sqlite3, json
db = sqlite3.connect('/Users/yuyi/Library/Application Support/Antigravity/User/globalStorage/state.vscdb')
cursor = db.cursor()
cursor.execute(\\\"SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'\\\")
row = cursor.fetchone()
if row:
    d = json.loads(row[0])
    print(d.get('apiKey', ''))
db.close()
"`).toString().trim();
    return result;
}

async function test() {
    console.log("🐟 === Testing Cloud Code API with IDE's L-account token ===");
    console.log(`🐟 Time: ${new Date().toISOString()}`);

    const token = getIDEToken();
    if (!token || !token.startsWith('ya29.')) {
        console.error("❌ Could not extract IDE token. Got:", token?.slice(0, 30));
        return;
    }
    console.log(`✅ Got IDE token: ya29.***${token.slice(-20)}`);

    console.log(`\n🐟 Calling ${AG_ENDPOINT} with project=${PROJECT_ID}...`);
    const apiBody = JSON.stringify({
        project: PROJECT_ID,
        model: 'claude-sonnet-4-6',
        requestType: 'agent',
        userAgent: 'antigravity',
        requestId: `agent-${Date.now()}`,
        request: {
            contents: [{ role: 'user', parts: [{ text: "Say 'FishbigAgent test OK' and nothing else." }] }],
            generationConfig: { maxOutputTokens: 50 }
        }
    });

    const result = await new Promise((resolve, reject) => {
        const req = https.request({
            hostname: AG_ENDPOINT,
            path: AG_PATH,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(apiBody)),
                'x-goog-api-client': 'google-cloud-sdk',
                'x-goog-user-project': PROJECT_ID,
            },
        }, (res) => {
            let raw = '';
            res.on('data', c => (raw += c));
            res.on('end', () => resolve({ status: res.statusCode, body: raw }));
        });
        req.on('error', reject);
        req.write(apiBody);
        req.end();
    });

    console.log(`\n📊 HTTP Status: ${result.status}`);
    if (result.status === 200) {
        console.log("🎉🎉🎉 SUCCESS! Cloud Code API works with L-account token!");
        const lines = result.body.split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines.slice(0, 5)) {
            try {
                const d = JSON.parse(line.replace('data: ', ''));
                const text = d?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) console.log(`   Model says: ${text}`);
            } catch { }
        }
    } else {
        console.log(`❌ FAILED: ${result.body.substring(0, 500)}`);
    }
}

test();
