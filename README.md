# cf_ai_chat_assistant

An AI-powered chat assistant built on Cloudflare's developer platform. It uses Llama 3.3 for inference, Durable Objects for per-session memory, and a streaming chat UI served as a static asset.

Deployed link: https://cf-ai-chat-assistant.akansha-bansiya.workers.dev/

## Architecture

| Component | Technology | Role |
|-----------|-----------|------|
| LLM | Llama 3.3 70B (Workers AI) | Generates responses |
| Memory / State | Durable Objects + SQLite | Stores per-session conversation history |
| Coordination | Cloudflare Worker | Routes requests, calls AI, manages sessions |
| User Interface | Static HTML (Assets) | Streaming chat UI with session persistence |

**Data flow:**

1. The browser generates a UUID session ID on first load and stores it in `localStorage`.
2. Each message is sent via `POST /api/chat?sessionId=<id>`.
3. The Worker retrieves the matching `ChatSession` Durable Object and fetches its history.
4. History + the new message are sent to Workers AI (Llama 3.3) with streaming enabled.
5. The SSE stream is piped directly to the browser; tokens appear in real time.
6. After the stream completes, both the user message and AI response are persisted to the DO's SQLite storage via `ctx.waitUntil`.

## Project Structure

```
src/index.ts        — Worker entry point + ChatSession Durable Object
public/index.html   — Chat UI (served as static asset)
wrangler.jsonc      — Cloudflare configuration (DO, AI, Assets bindings)
```

## Running Locally

**Prerequisites:** Node.js 18+, a Cloudflare account, and Wrangler authenticated.

```bash
# Install dependencies
npm install

# Regenerate TypeScript types after wrangler.jsonc changes
npm run cf-typegen

# Start local dev server (Workers AI calls hit Cloudflare's API)
npm run dev
```

Open [http://localhost:8787](http://localhost:8787) in your browser.

> Workers AI is not simulated locally — `wrangler dev` proxies AI calls to Cloudflare's network, so you need to be logged in (`wrangler login`).

## Deploying

```bash
# Authenticate (first time only)
npx wrangler login

# Deploy to Cloudflare
npm run deploy
```

Wrangler will print the deployed URL when done.

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/chat?sessionId=<id>` | Send a message; returns SSE stream |
| `GET`  | `/api/history?sessionId=<id>` | Fetch full conversation history |
| `DELETE` | `/api/history?sessionId=<id>` | Clear all messages for a session |

**POST /api/chat request body:**
```json
{ "message": "Hello!" }
```

**SSE response format** (streamed):
```
data: {"response": "Hi"}
data: {"response": " there"}
data: [DONE]
```
