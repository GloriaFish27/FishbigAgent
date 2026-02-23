import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';

async function testGCP() {
    console.log("🐟 Starting direct GCP test for Antigravity Sandbox...");
    
    // Mimicking the AntigravityModel logic directly in JS
    const tokenPath = path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
    if (!fs.existsSync(tokenPath)) {
        console.log("❌ No gcloud ADC found at", tokenPath);
        return;
    }
    
    const tokenDataJSON = fs.readFileSync(tokenPath, 'utf8');
    const tokenData = JSON.parse(tokenDataJSON);
    
    const REFRESH_TOKEN = tokenData.refresh_token;
    const CLIENT_ID = tokenData.client_id;
    const CLIENT_SECRET = tokenData.client_secret;
    
    console.log("Fetching new access token...");
    
    const tokenReqData = JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: REFRESH_TOKEN,
        grant_type: 'refresh_token'
    });

    const tokenReq = https.request({
        hostname: 'oauth2.googleapis.com',
        port: 443,
        path: '/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(tokenReqData)
        }
    }, (res) => {
        let responseData = '';
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
            if (res.statusCode !== 200) {
                console.log("❌ Token refresh failed:", responseData);
                return;
            }
            const access_token = JSON.parse(responseData).access_token;
            console.log("✅ Token generated successfully.");
            
            // Now test the actual API
            console.log("Sending test request to Cloud Code Private API...");
            const apiReqData = JSON.stringify({
                model: "google-antigravity/claude-opus-4-6-thinking",
                messages: [{ role: "user", content: "Hello, this is a test from FishbigAgent. Do you have access?" }]
            });

            const apiReq = https.request({
                hostname: 'antigravity-sandbox-uc.a.run.app',
                port: 443,
                path: '/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${access_token}`,
                    'Content-Length': Buffer.byteLength(apiReqData)
                }
            }, (apiRes) => {
                let apiResponseData = '';
                apiRes.on('data', chunk => apiResponseData += chunk);
                apiRes.on('end', () => {
                   if (apiRes.statusCode === 200) {
                       console.log("✅ API Request SUCCESS! We have permission.");
                       console.log("Response:", JSON.parse(apiResponseData).choices[0].message.content.substring(0, 100) + '...');
                   } else {
                       console.log(`❌ API Request FAILED with status ${apiRes.statusCode}`);
                       console.log("Response details:");
                       // Print snippet of HTML if it's the 403 Google page
                       if(apiResponseData.includes('<html')) {
                           const titleMatch = apiResponseData.match(/<title>(.*?)<\/title>/);
                           console.log("HTML Error Title:", titleMatch ? titleMatch[1] : 'Unknown');
                           console.log("It's likely still blocking the account. See full response length:", apiResponseData.length);
                       } else {
                           console.log(apiResponseData);
                       }
                   }
                });
            });
            
            apiReq.on('error', e => console.error("API Request Error:", e));
            apiReq.write(apiReqData);
            apiReq.end();
            
        });
    });
    
    tokenReq.on('error', e => console.error("Token Request Error:", e));
    tokenReq.write(tokenReqData);
    tokenReq.end();
}

testGCP();
