/**
 * Quick test: FishbigAgent independent auth → Cloud Code Assist API
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleAuth } from '../auth/google-auth.js';
import { AntigravityAPI, MODELS } from '../engine/antigravity-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');

async function test() {
    console.log('🧪 Testing FishbigAgent independent auth...');
    console.log('');

    const auth = new GoogleAuth(DATA_DIR);
    if (!auth.load()) {
        console.log('❌ No credentials. Run: npm run login');
        process.exit(1);
    }

    console.log(`   Account:  ${auth.email}`);
    console.log(`   Project:  ${auth.companionProject}`);
    console.log('');

    const api = new AntigravityAPI(auth);

    // Test token refresh
    console.log('🔄 Refreshing token...');
    const token = await auth.getAccessToken();
    console.log(`✅ Token: ya29.***${token.slice(-15)}`);
    console.log('');

    // Test API call
    const testModels = [MODELS.chatFallback, MODELS.chatPrimary];
    for (const model of testModels) {
        try {
            console.log(`📡 Testing model: ${model}...`);
            const reply = await api.complete(
                `Say "Hello from FishbigAgent! Model: ${model}" in exactly those words.`,
                'You are a test bot. Reply concisely.',
                model,
            );
            console.log(`✅ ${model}: ${reply.slice(0, 100)}`);
        } catch (err) {
            console.log(`❌ ${model}: ${(err as Error).message.slice(0, 100)}`);
        }
        console.log('');
    }

    console.log('🎉 Test complete!');
}

test();
