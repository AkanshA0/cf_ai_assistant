# AI Prompts Used

Prompts given to Claude Code (claude-sonnet-4-6) during development of this project.

---

## 1. Architecture design

> Design a Cloudflare Workers application that satisfies all four requirements:
> an LLM (Llama 3.3 via Workers AI), workflow coordination (Durable Objects),
> user chat input (static Assets), and persistent memory (Durable Object SQLite storage).
> Each user session should get an isolated Durable Object instance identified by a UUID
> stored in localStorage. Explain the request lifecycle from browser to AI and back.

Used to establish the overall architecture before writing any code. Forcing a full
lifecycle explanation upfront surfaced the `ctx.waitUntil` requirement for saving
the assistant response after the stream closes.

---

## 2. Durable Object with SQLite-backed chat history

> Implement a `ChatSession` Durable Object in TypeScript that:
> - initialises a `messages` table in `ctx.storage.sql` on construction
> - exposes `getHistory()` returning the last 50 messages as `{role, content}[]`
> - exposes `addMessage(role, content)` to append a row
> - exposes `clearHistory()` to delete all rows
> Keep it minimal — no business logic, just storage.

Separating storage concerns into a focused prompt prevented the DO from becoming
bloated with AI-call logic, which belongs in the Worker.

---

## 3. Streaming SSE pipeline with response capture

> In the Worker's POST /api/chat handler, after fetching history from the DO,
> call Workers AI with `stream: true`. Use a TransformStream to simultaneously:
> (a) forward the raw SSE bytes to the HTTP response, and
> (b) accumulate the full assistant response by parsing `data: {response}` lines.
> After the stream ends, persist the captured text to the DO using ctx.waitUntil
> so it doesn't block the response. The user message should be saved before the
> AI call; the assistant message after.

This prompt produced the core streaming pattern. Specifying both the forwarding
and the capture requirement in one prompt ensured the TransformStream was used
correctly rather than two separate consumers.

---

## 5. Auto-summarization design using DO coordination

> The Durable Object is currently only used as a database — a D1 table could do the same job.
> What logic could we add to the DO that genuinely requires its single-threaded guarantee?
> Design an auto-summarization feature: when history exceeds a threshold, the DO should
> compress old messages into a single summary row. Explain why this sequence must be atomic
> and why a plain database cannot safely do it without transactions plus external locking.

This prompt reframed the DO from a storage detail into the coordination layer it's meant to be.
The answer clarified that the read → AI call → rewrite sequence has no race conditions only
because the DO serializes all requests — a key architectural insight.

---

## 6. Summarization implementation with correct ordering

> Implement maybeSummarize() inside ChatSession. Requirements:
> - trigger after every assistant message if total rows exceed SUMMARIZE_THRESHOLD (20)
> - keep the last KEEP_RECENT (6) messages verbatim
> - call Workers AI (non-streaming) to produce a 2-3 sentence summary of the older messages
> - after summarizing, the summary row must sort before the kept recent rows when queried
>   ORDER BY id ASC — solve this without adding an extra sort column
> - the whole operation must be two SQL statements after the AI call, not a transaction block

The ordering constraint drove the key design decision: update the oldest row in-place
(preserving its low ID as an anchor) rather than deleting all old rows and inserting a
new one. Inserting a new row would give it a higher AUTOINCREMENT ID, placing it after
the recent messages — wrong order. The in-place update avoids that entirely.

---

## 4. Chat UI with real-time token streaming

> Build a single-file HTML chat UI (no framework, no build step) that:
> - generates a UUID session ID on first load and persists it in localStorage
> - restores previous messages from GET /api/history on page load
> - sends messages via POST /api/chat and reads the SSE response body with
>   a ReadableStream reader, appending each token to the AI bubble as it arrives
> - shows a blinking cursor during streaming, removes it when done
> - has a "Clear chat" button that calls DELETE /api/history
> - uses a dark theme consistent with Cloudflare's orange brand color (#f6821f)
> Design should be clean and minimal — no external CSS or JS dependencies.

Keeping the constraint "no framework, no build step" in the prompt avoided
solutions that would have required adding a bundler to what is intentionally
a zero-build project.

---

## 7. Structured prompts with XML tags

> Our prompts to the LLM are unstructured strings. Add XML-style tags to clearly
> delineate the different parts of each prompt — role, behavior, task, requirements,
> and input content. For the system prompt use `<role>` and `<behavior>`. For the
> summarization prompt, wrap the instruction in `<task>` and `<requirements>`, and
> wrap the conversation input in `<conversation>`. Explain why this matters for
> model instruction-following.

XML tags give the model unambiguous boundaries between what it *is*, what it should *do*,
and what it should *act on*. Without tags, instructions and content blur together —
the model has to infer structure from prose. With tags, the separation is explicit,
which reduces misinterpretation especially in the summarization prompt where raw
conversation text is injected directly into the message.
