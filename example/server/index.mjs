import "dotenv/config";
import express from "express";
import cors from "cors";
import { Pinecall } from "@pinecall/sdk";

/**
 * Test backend for the Ionic app.
 *
 *  1. Runs ONE live AI agent (English, deepgram/flux) — this process staying
 *     connected is what keeps the agent alive for WebRTC calls.
 *  2. Exposes GET /api/token → a short-lived (60s), single-use WebRTC token
 *     minted with the org API key. The browser/app never sees the API key.
 *
 * Set PINECALL_API_KEY in server/.env before running.
 */

const pc = new Pinecall(); // reads PINECALL_API_KEY from env, auto-connects

const agent = pc.agent("assistant", {
  prompt:
    "You are a friendly voice assistant. Keep answers short and natural — " +
    "one or two sentences, conversational.",
  llm: "openai/gpt-5-chat-latest",
  voice: "elevenlabs/sarah",
  stt: "deepgram/flux",
  language: "en",
  greeting: "Hey there! How can I help you today?",
});

const app = express();
app.use(cors()); // dev: allow the app origin / Capacitor webview

app.get("/api/token", async (_req, res) => {
  try {
    // agent.createToken → { token, server, expiresIn }
    const t = await agent.createToken("webrtc");
    // Normalize to the shape @pinecall/web VoiceSession expects.
    res.json({ token: t.token, server: t.server, expires_in: t.expiresIn });
  } catch (err) {
    console.error("[token] failed:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ---- Inbound "the agent calls YOU" — dev-testable without PushKit ----------
//
// The app subscribes to /api/ring/stream (SSE). Hitting POST /api/ring
// broadcasts a ring event → every connected app presents a native CallKit
// incoming call. This is the in-app-event path (works while the app runs, in
// the simulator, no Apple account). PushKit is only needed to ring a
// killed/backgrounded app — that needs a real device + VoIP cert + APNs.

const ringClients = new Set();

app.get("/api/ring/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  ringClients.add(res);
  req.on("close", () => ringClients.delete(res));
});

// Trigger a ring: curl -X POST "http://localhost:8787/api/ring?agent=assistant"
app.post("/api/ring", express.json(), (req, res) => {
  const agentId = req.query.agent || req.body?.agent || "assistant";
  const payload = JSON.stringify({ agent: agentId });
  for (const client of ringClients) client.write(`event: ring\ndata: ${payload}\n\n`);
  res.json({ rang: ringClients.size, agent: agentId });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT) || 8787;
app.listen(port, () => {
  console.log(`🌲 Pinecall token server on http://localhost:${port}`);
  console.log(`   agent "assistant" live · GET /api/token`);
});
