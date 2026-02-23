import https from 'https';
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';

const STATE_DB = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
const raw = execSync(`sqlite3 "${STATE_DB}" "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus';"`, { encoding: 'utf-8' }).trim();
const authData = JSON.parse(raw);
const token = authData.apiKey;
console.log('Token:', token.substring(0, 30) + '...');
console.log('Email:', authData.email);

// Check if the token actually belongs to this user by calling userinfo
await new Promise((resolve) => {
    const req = https.request({
        hostname: 'www.googleapis.com',
        path: '/oauth2/v3/userinfo',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
    }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { console.log('UserInfo:', data); resolve(undefined); });
    });
    req.on('error', e => { console.log('Error:', e.message); resolve(undefined); });
    req.end();
});

// Now try calling the Cloud Code API with vital-landing-p27sp
const body = JSON.stringify({
    project: 'vital-landing-p27sp',
    model: 'gemini-3-flash',
    request: {
        contents: [{ role: 'user', parts: [{ text: 'Say hello in one word' }] }],
        generationConfig: { maxOutputTokens: 50 },
    },
    requestType: 'agent',
    userAgent: 'antigravity',
    requestId: `test-${Date.now()}`,
});

console.log('\n--- Calling Cloud Code API ---');
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
            'x-goog-user-project': 'vital-landing-p27sp',
        },
    }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
            console.log('Status:', res.statusCode);
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
                console.log('Full response:', data.slice(0, 500));
            }
            resolve(undefined);
        });
    });
    req.on('error', e => { console.log('Error:', e.message); resolve(undefined); });
    req.write(body);
    req.end();
});
