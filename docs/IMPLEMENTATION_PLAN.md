# Glow Agent MVP implementation plan

**Status:** Foundation, local data workflows, the first safe agentic-tool vertical slice, and live provider response streaming are implemented. Attachments, authenticated network access, and richer tools remain later phases.

## Product boundary for this first working release

Glow Agent is a **single-owner, local-first AI workspace** run from Termux. It connects to OpenAI-compatible providers using a user-supplied base URL and API key, discovers models server-side, lets the owner write reusable skills, and supports selected server-side tools during a chat response.

The initial release deliberately binds to `127.0.0.1`. It does not claim to be safe for LAN or public exposure until authentication, authorization, HTTPS, and a deliberate network-access design are complete.

## Delivery order

1. **Foundation**
   - Node/Express static server, health endpoint, `.env` configuration, security headers, graceful shutdown, and a SQLite migration runner.
   - A simplified local credentials store that does not require an application encryption key. Provider keys remain server-only, but the SQLite data file must be protected because credentials are unencrypted.
2. **Provider and model workflow**
   - Safe provider CRUD: browser responses contain names, URLs, availability/count metadata, and selected model IDs only—never API keys.
   - Server-side OpenAI-compatible `/models` discovery. API keys are read only by the server and are never placed in URLs, client markup, browser storage, responses, or logs.
   - Persistent selected-model CRUD.
3. **Skills workflow**
   - Persistent skill CRUD with the existing mobile design: Name, Description, and Instructions.
   - The three-dot card menu opens below its card and exposes Configure and Delete.
4. **Allowlisted tool workflow**
   - The server exposes Calculator and Current time as built-in tools. The browser selects a tool for one message but never executes model-supplied commands itself.
   - The server sends OpenAI-compatible function definitions only for the tools the user selected, validates call arguments, executes a small explicit allowlist, limits execution to four provider rounds, and records a safe tool-use summary alongside the assistant message.
5. **Usable chat vertical slice**
   - Conversations and messages persist locally.
   - The browser sends a message to the same-origin server. The server resolves the selected provider/model, injects explicitly selected skill instructions as a system message, invokes selected tools when the provider requests them, and forwards OpenAI-compatible stream deltas to the browser. No client code receives the provider secret.
   - A Thinking disclosure is created only if the provider's stream includes reasoning text (`reasoning_content`, `reasoning`, or `analysis_content`); it is never fabricated client-side.
6. **Verification and handover**
   - Node API tests cover health, safe provider output, model selection, skills, common input failures, tool discovery, server-side tool calling, skill injection, provider stream forwarding, optional reasoning forwarding, and persistence of the completed message.
   - README documents no-key setup, local operation, backup, and the current security boundary.

## Concrete API contract

All endpoints are same-origin and are rooted at `/api/v1`.

| Area | Routes |
| --- | --- |
| Operations | `GET /health` |
| Tools | `GET /tools` |
| Providers | `GET, POST /providers`; `GET, PUT, DELETE /providers/:providerId`; `POST /providers/:providerId/fetch-models` |
| Selected models | `GET, POST /providers/:providerId/models`; `DELETE /providers/:providerId/models/:modelId` |
| Skills | `GET, POST /skills`; `GET, PUT, DELETE /skills/:skillId` |
| Conversations | `GET, POST /conversations`; `GET /conversations/:conversationId`; `POST /conversations/:conversationId/respond`; `POST /conversations/:conversationId/respond/stream` |

Mutating requests accept JSON only. JSON API responses use a `{ "data": ... }` envelope on success and `{ "error": { "code", "message", "requestId" } }` on failure. The stream endpoint returns `text/event-stream` events: `started`, `thinking`, `token`, `completed`, and `error`; its `completed` event contains the normal response payload.

## Local records

- `providers`: display name, normalized base URL, unencrypted local credential bundle, and timestamps.
- `provider_models`: selected model IDs, scoped to a provider.
- `skills`: name, description, instructions, and timestamps.
- `conversations` and `messages`: local chat history. Provider/model IDs, provider-emitted streaming reasoning when available, and safe tool-use summaries are recorded with messages, but credentials never are.

## Explicit security decisions

- Provider credentials are stored unencrypted in the local SQLite database by request. This removes setup friction but means device and database-file access must be treated as access to provider credentials.
- SQL uses prepared statements. Inputs are bounded and validated at the server boundary.
- The upstream OpenAI-compatible request is made only by the server. The UI works with safe provider metadata and IDs.
- Credential strings are never logged, returned, persisted in browser storage, interpolated into HTML, or included in query strings.
- Tool calls are limited to an explicit server-side allowlist; no shell, file, network, or arbitrary JavaScript execution is available to a model.
- The project currently refuses non-loopback binding. LAN/public support will be a separate authenticated release rather than an unsafe environment toggle.

## Deferred, not omitted

Attachment processing requires a separate capability-permission model and storage policy, so the Attach affordance remains clearly labelled as a future capability. The current tools are intentionally limited to Calculator and Current time. Live OpenAI-compatible response streaming is implemented, including an optional Thinking disclosure only when the selected provider actually emits reasoning text; account auth, LAN/public access, richer/sandboxed tools, and production backup scheduling follow after this secure local workflow is proven.
