import https from 'https';
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';

const STATE_DB = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');

const raw = execSync(`sqlite3 "${STATE_DB}" "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus';"`, { encoding: 'utf-8' }).trim();
const authData = JSON.parse(raw);
const token = authData.apiKey;
console.log('Token:', token.substring(0, 30) + '...');

// Try different project IDs
const projects = ['vital-landing-p27sp', 'vital-landing-p27sp-488216'];

for (const project of projects) {
    console.log(`\nTesting project: ${project}`);
    const body = JSON.stringify({
        project,
        model: 'gemini-3-flash',
        request: {
            contents: [{ role: 'user', parts: [{ text: 'Say hello' }] }],
            generationConfig: { maxOutputTokens: 100 },
        },
        requestType: 'agent',
        userAgent: 'antigravity',
        requestId: `test-${Date.now()}`,
    });

    await new Promise((resolve) => {
        const req = https.request({
            hostname: 'daily-cloudcode-pa.sandbox.googleapis.com',
            path: '/v1internal:streamGenerateContent?alt=sse',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(body)),
                'x-goog-api-client': 'google-cloud-sdk',
                'x-goog-user-project': project,
            },
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
                            const t = j.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? j.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (t) process.stdout.write(t);
                        } catch {}
                    }
                    console.log('\n✅ SUCCESS');
                } else {
                    console.log('Response:', data.slice(0, 300));
                }
                resolve(undefined);
            });
        });
        req.on('error', e => { console.log('Error:', e.message); resolve(undefined); });
        req.write(body);
        req.end();
    });
}
