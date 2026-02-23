import http from 'http';
import https from 'https';

console.log("🐟 Starting daemon GCP API Access test...");

// 1. Fetch token from the local VS Code extension server
const req = http.request('http://localhost:8765/token', { method: 'GET' }, (res) => {
    let tokenDataStr = '';
    res.on('data', chunk => tokenDataStr += chunk);
    res.on('end', () => {
        if (res.statusCode !== 200) {
            console.error("❌ Failed to get token from local extension (port 8765). Is the IDE logged in?");
            console.error(tokenDataStr);
            return;
        }

        try {
            const tokenJson = JSON.parse(tokenDataStr);
            const token = tokenJson.access_token;
            console.log("✅ Successfully fetched auth token from local IDE server.");

            // 2. Test the Antigravity Sandbox API with this token
            const apiReqData = JSON.stringify({
                model: "google-antigravity/claude-opus-4-6-thinking",
                messages: [{ role: "user", content: "Hello, this is a test from FishbigAgent daemon. Are you receiving this and do I have permission?" }]
            });

            const apiReq = https.request({
                hostname: 'antigravity-sandbox-uc.a.run.app',
                port: 443,
                path: '/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                    'Content-Length': Buffer.byteLength(apiReqData)
                }
            }, (apiRes) => {
                let apiResponseData = '';
                apiRes.on('data', chunk => apiResponseData += chunk);
                apiRes.on('end', () => {
                    if (apiRes.statusCode === 200) {
                        console.log("✅ API Request SUCCESS! The new account has correct permissions.");
                        console.log("Response:", JSON.parse(apiResponseData).choices[0].message.content.substring(0, 200) + '...');
                    } else {
                        console.log(`❌ API Request FAILED with status ${apiRes.statusCode} (403 usually means NO GCP access)`);
                        // Output snippet to show the error
                        if (apiResponseData.includes('<html')) {
                            const titleMatch = apiResponseData.match(/<title>(.*?)<\/title>/);
                            console.log("HTML Error Title:", titleMatch ? titleMatch[1] : 'Unknown page error');
                        } else {
                            console.log(apiResponseData.substring(0, 300));
                        }
                    }
                });
            });

            apiReq.on('error', e => console.error("Sandbox API Request Error:", e));
            apiReq.write(apiReqData);
            apiReq.end();

        } catch (e) {
            console.error("❌ Failed to parse token response:", e.message);
        }
    });
});

req.on('error', (e) => {
    console.error("❌ Cannot connect to local auth server on port 8765. Make sure the IDE extension is active.");
});
req.end();
