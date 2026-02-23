import { AntigravityModel } from '../llm/antigravity.js';

async function testGCP() {
  console.log("🐟 Starting GCP test for Antigravity Sandbox...");

  // We already have a working AntigravityModel wrapper that handles the 
  // exact token fetching from the local VSCode/Cloud Code extension.
  const model = new AntigravityModel();

  try {
    console.log("Fetching token...");
    const token = await model.getToken();
    console.log("Token generated successfully:", token.substring(0, 30) + "...");

    console.log("Sending test request to Cloud Code Private API...");
    const reply = await model.generateReply(
      "test-gcp-" + Date.now(),
      "Hello, this is a test from the FishbigAgent daemon. Do you have access?",
      []
    );

    console.log("✅ API Request SUCCESS");
    console.log("Response:", reply);
  } catch (err: any) {
    console.log("❌ API Request FAILED");
    console.log("Error details:", err.message);
    if (err.response) {
      console.log("Status:", err.response.status);
      console.log("Data:", err.response.data);
    }
  }
}

testGCP().catch(console.error);
