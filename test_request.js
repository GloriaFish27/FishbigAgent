import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tokenPath = path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
const tokenDataJSON = fs.readFileSync(tokenPath, 'utf8');
const tokenData = JSON.parse(tokenDataJSON);

const tokenReqData = JSON.stringify({
    client_id: tokenData.client_id,
    client_secret: tokenData.client_secret,
    refresh_token: tokenData.refresh_token,
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
        const access_token = JSON.parse(responseData).access_token;
        const apiReqData = JSON.stringify({
            model: "google-antigravity/claude-opus-4-6-thinking",
            messages: [{ role: "user", content: "Hello" }]
        });
        const apiReq = https.request({
            hostname: 'us-central1-antigravity-sandbox.cloudfunctions.net',
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
            apiRes.on('end', () => console.log(apiRes.statusCode, apiResponseData));
        });
        apiReq.on('error', console.error);
        apiReq.write(apiReqData);
        apiReq.end();
    });
});
tokenReq.on('error', console.error);
tokenReq.write(tokenReqData);
tokenReq.end();
