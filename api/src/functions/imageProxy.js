const { app } = require("@azure/functions");

// Tiny proxy: translates OpenAI-style Bearer auth → Azure api-key header
// for MAI-Image-2e image generation.
// OpenClaw sends: POST /api/image-proxy/images/generations with Authorization: Bearer <key>
// We forward to: POST https://eastus.api.cognitive.microsoft.com/mai/images/generations?api-version=2025-04-01-preview

const AZURE_ENDPOINT = "https://eastus.api.cognitive.microsoft.com";
const API_VERSION = "2025-04-01-preview";

app.http("imageProxy", {
  methods: ["POST"],
  route: "image-proxy/{*path}",
  authLevel: "anonymous",
  handler: async (request, context) => {
    const path = request.params.path || "images/generations";
    const azureUrl = `${AZURE_ENDPOINT}/mai/${path}?api-version=${API_VERSION}`;

    // SWA strips/rewrites Authorization header, so always use the env var
    const apiKey = process.env.AZURE_AI_API_KEY || "";

    if (!apiKey) {
      return { status: 401, jsonBody: { error: "Missing API key" } };
    }

    try {
      const body = await request.text();
      
      const response = await fetch(azureUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": apiKey,
        },
        body: body,
      });

      const responseBody = await response.text();
      
      return {
        status: response.status,
        headers: { "Content-Type": "application/json" },
        body: responseBody,
      };
    } catch (err) {
      context.log("Image proxy error:", err);
      return {
        status: 502,
        jsonBody: { error: "Proxy error", message: err.message },
      };
    }
  },
});
