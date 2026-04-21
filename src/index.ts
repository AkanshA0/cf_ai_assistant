import { DurableObject } from "cloudflare:workers";

interface Message {
	role: "user" | "assistant" | "system";
	content: string;
}

/**
 * ChatSession Durable Object
 * Stores per-session conversation history in SQLite (Cloudflare DO Storage).
 * Each unique sessionId gets its own isolated DO instance with its own message history.
 *
 * Auto-summarization: once the history exceeds SUMMARIZE_THRESHOLD messages, the DO
 * compresses the oldest messages into a single summary row. This keeps the token count
 * sent to the LLM bounded while preserving conversational context. Because the DO is
 * single-threaded, the read → AI call → rewrite sequence is atomic — no race conditions.
 */
export class ChatSession extends DurableObject<Env> {
	private static readonly SUMMARIZE_THRESHOLD = 20; // trigger after this many messages
	private static readonly KEEP_RECENT = 6;          // always keep the last N messages verbatim

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id         INTEGER PRIMARY KEY AUTOINCREMENT,
				role       TEXT    NOT NULL,
				content    TEXT    NOT NULL,
				created_at INTEGER NOT NULL DEFAULT (unixepoch())
			)
		`);
	}

	/** Returns all messages for this session in chronological order. */
	async getHistory(): Promise<Message[]> {
		const cursor = this.ctx.storage.sql.exec<{ role: string; content: string }>(
			`SELECT role, content FROM messages ORDER BY id ASC`
		);
		return cursor.toArray() as Message[];
	}

	/**
	 * Appends a message to the history. After saving an assistant message,
	 * checks whether the history needs summarizing and runs it if so.
	 */
	async addMessage(role: string, content: string): Promise<void> {
		this.ctx.storage.sql.exec(
			`INSERT INTO messages (role, content) VALUES (?, ?)`,
			role,
			content
		);
		if (role === "assistant") {
			await this.maybeSummarize();
		}
	}

	/** Wipes all messages for this session. */
	async clearHistory(): Promise<void> {
		this.ctx.storage.sql.exec(`DELETE FROM messages`);
	}

	/**
	 * If the total message count exceeds SUMMARIZE_THRESHOLD, compress the oldest
	 * messages into a single summary row using the LLM.
	 *
	 * Strategy: update the oldest row in-place to hold the summary text (preserving
	 * its low ID so it still sorts before recent messages), then delete the rest of
	 * the old rows. This keeps ordering correct without needing an extra sort column.
	 */
	private async maybeSummarize(): Promise<void> {
		const { count } = this.ctx.storage.sql
			.exec<{ count: number }>(`SELECT COUNT(*) as count FROM messages`)
			.one();

		if (count <= ChatSession.SUMMARIZE_THRESHOLD) return;

		const toSummarizeCount = count - ChatSession.KEEP_RECENT;

		const rows = this.ctx.storage.sql
			.exec<{ id: number; role: string; content: string }>(
				`SELECT id, role, content FROM messages ORDER BY id ASC LIMIT ?`,
				toSummarizeCount
			)
			.toArray();

		if (rows.length < 2) return;

		const anchorId  = rows[0].id;
		const lastOldId = rows[rows.length - 1].id;

		const conversationText = rows
			.map(r => `${r.role === "user" ? "User" : "Assistant"}: ${r.content}`)
			.join("\n\n");

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = await (this.env.AI as any).run(MODEL, {
			messages: [
				{
					role: "system",
					content:
						"<task>Summarize the conversation provided by the user into 2-3 sentences.</task>\n" +
						"<requirements>Preserve all key facts, topics discussed, and any conclusions reached. " +
						"Write in third person. Do not add commentary outside the summary.</requirements>",
				},
				{
					role: "user",
					content: `<conversation>\n${conversationText}\n</conversation>`,
				},
			],
			max_tokens: 256,
		}) as { response: string };

		// Update the oldest row to hold the summary (keeps its low ID → correct sort order)
		this.ctx.storage.sql.exec(
			`UPDATE messages SET role = 'system', content = ? WHERE id = ?`,
			`[Summary of earlier conversation]: ${result.response}`,
			anchorId
		);

		// Delete the rest of the now-summarized rows
		this.ctx.storage.sql.exec(
			`DELETE FROM messages WHERE id > ? AND id <= ?`,
			anchorId,
			lastOldId
		);
	}
}

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
} as const;

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const SYSTEM_PROMPT = `\
<role>You are a helpful, concise AI assistant powered by Cloudflare Workers AI.</role>
<behavior>Be friendly, clear, and accurate. When asked about code, provide working examples.</behavior>`;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Handle CORS preflight
		if (request.method === "OPTIONS") {
			return new Response(null, { headers: CORS_HEADERS });
		}

		// Derive a Durable Object stub from the sessionId query param.
		// Each unique sessionId → its own ChatSession instance with isolated history.
		const sessionId = url.searchParams.get("sessionId") ?? "default";
		const doId = env.CHAT_SESSION.idFromName(sessionId);
		const session = env.CHAT_SESSION.get(doId);

		// POST /api/chat — send a message, get a streaming AI response
		if (url.pathname === "/api/chat" && request.method === "POST") {
			let body: { message?: string };
			try {
				body = await request.json();
			} catch {
				return jsonError("Invalid JSON body", 400);
			}

			const userMessage = body.message?.trim();
			if (!userMessage) {
				return jsonError("message field is required", 400);
			}

			// Fetch history from the Durable Object (persistent, per-session memory)
			const history = await session.getHistory();

			// Persist the user's message immediately
			await session.addMessage("user", userMessage);

			// Build the full message array for the LLM
			const messages: Message[] = [
				{ role: "system", content: SYSTEM_PROMPT },
				...history,
				{ role: "user", content: userMessage },
			];

			// Call Workers AI (Llama 3.3) with streaming enabled.
			// The response is an SSE ReadableStream in the format:
			//   data: {"response": "token"}\n\n  …  data: [DONE]\n\n
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const aiStream = (await (env.AI as any).run(MODEL, {
				messages,
				stream: true,
				max_tokens: 1024,
			})) as ReadableStream<Uint8Array>;

			// Intercept the stream so we can capture the full response text
			// and persist it to the Durable Object after streaming completes.
			let assistantText = "";
			const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					controller.enqueue(chunk);
					// Parse SSE lines to accumulate the full response
					const text = new TextDecoder().decode(chunk);
					for (const line of text.split("\n")) {
						if (line.startsWith("data: ") && !line.includes("[DONE]")) {
							try {
								const data = JSON.parse(line.slice(6)) as { response?: string };
								if (data.response) assistantText += data.response;
							} catch {
								// ignore malformed lines
							}
						}
					}
				},
			});

			// Pipe AI stream through our transform; save the response when done.
			ctx.waitUntil(
				aiStream.pipeTo(writable).then(() => {
					if (assistantText) {
						return session.addMessage("assistant", assistantText);
					}
				})
			);

			return new Response(readable, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					...CORS_HEADERS,
				},
			});
		}

		// GET /api/history — return the full conversation history as JSON
		if (url.pathname === "/api/history" && request.method === "GET") {
			const history = await session.getHistory();
			return new Response(JSON.stringify(history), {
				headers: { "Content-Type": "application/json", ...CORS_HEADERS },
			});
		}

		// DELETE /api/history — clear all messages for this session
		if (url.pathname === "/api/history" && request.method === "DELETE") {
			await session.clearHistory();
			return new Response(JSON.stringify({ success: true }), {
				headers: { "Content-Type": "application/json", ...CORS_HEADERS },
			});
		}

		return new Response("Not found", { status: 404, headers: CORS_HEADERS });
	},
} satisfies ExportedHandler<Env>;

function jsonError(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}
