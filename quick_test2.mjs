import https from 'https';
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';

const STATE_DB = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
const raw = execSync(`sqlite3 "${STATE_DB}" "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus';"`, { encoding: 'utf-8' }).trim();
const token = JSON.parse(raw).apiKey;
console.log('Token:', token.substring(0, 30) + '...');

// Test variations: with/without project header, different projects
const tests = [
    { label: 'No project header', project: null },
    { label: 'vital-landing-p27sp (original default)', project: 'vital-landing-p27sp' },
];

for (const t of tests) {
    console.log(`\n--- ${t.label} ---`);
    const bodyObj = {
        model: 'gemini-3-flash',
        request: {
            contents: [{ role: 'user', parts: [{ text: 'Say hello' }] }],
            generationConfig: { maxOutputTokens: 100 },
        },
        requestType: 'agent',
        userAgent: 'antigravity',
        requestId: `test-${Date.now()}`,
    };
    if (t.project) bodyObj.project = t.project;

    const body = JSON.stringify(bodyObj);
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'x-goog-api-client': 'google-cloud-sdk',
    };
    if (t.project) headers['x-goog-user-project'] = t.project;

    await new Promise((resolve) => {
        const req = https.request({
            hostname: 'daily-cloudcode-pa.sandbox.googleapis.com',
            path: '/v1internal:streamGenerateContent?alt=sse',
            method: 'POST',
            headers,
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                console.log(`Status: ${res.statusCode}`);
                if (res.statusCode === 200) {
                    const lines = data.split('\n').filter(l => l.startsWith('data: '));
                    for (const l of lines) {
                        try {
                            const j = JSON.parse(l.slice(6));
                            const txt = j.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? j.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (txt) process.stdout.write(txt);
                        } catch {}
                    }
                    console.log('\n✅ SUCCESS');
                } else {
                    console.log('Response:', data.slice(0, 200));
                }
                resolve(undefined);
            });
        });
        req.on('error', e => { console.log('Error:', e.message); resolve(undefined); });
        req.write(body);
        req.end();
    });
}
