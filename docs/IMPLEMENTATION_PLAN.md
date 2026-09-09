# Glow Agent MVP implementation plan

**Status:** Phase 1 and the local-first data layer are being implemented now.

## Product boundary for this first working release

Glow Agent is a **single-owner, local-first AI workspace** run from Termux. It connects to OpenAI-compatible providers using a user-supplied base URL and API key, discovers models server-side, and lets the owner write reusable skills.

The initial release deliberately binds to `127.0.0.1`. It does not claim to be safe for LAN or public exposure until authentication, authorization, HTTPS, and a deliberate network-access design are complete.

## Delivery order

1. **Foundation**
   - Node/Express static server, health endpoint, `.env` configuration, security headers, graceful shutdown, and a SQLite migration runner.
   - An encrypted-at-rest local credentials store using AES-256-GCM and an operator-provided 32-byte application key.
2. **Provider and model workflow**
   - Safe provider CRUD: browser responses contain names, URLs, availability/count metadata, and selected model IDs only—never API keys.
   - Server-side OpenAI-compatible `/models` discovery. API keys are read only by the server and are never placed in URLs, client markup, browser storage, responses, or logs.
   - Persistent selected-model CRUD.
3. **Skills workflow**
   - Persistent skill CRUD with the existing mobile design: Name, Description, and Instructions.
   - The three-dot card menu opens below its card and exposes Configure and Delete.
4. **Usable chat vertical slice**
   - Conversations and messages persist locally.
   - The browser sends a message to the same-origin server. The server resolves the selected provider/model, injects explicitly selected skill instructions as a system message, calls the OpenAI-compatible `/chat/completions` endpoint, and returns the assistant response. No client code receives the provider secret.
5. **Verification and handover**
   - Node API tests cover health, safe provider output, model selection, skills, and common input failures.
   - README documents install, encryption-key generation, local operation, backup, and the current security boundary.

## Concrete API contract

All endpoints are same-origin and are rooted at `/api/v1`.

| Area | Routes |
| --- | --- |
| Operations | `GET /health` |
| Providers | `GET, POST /providers`; `GET, PUT, DELETE /providers/:providerId`; `POST /providers/:providerId/fetch-models` |
| Selected models | `GET, POST /providers/:providerId/models`; `DELETE /providers/:providerId/models/:modelId` |
| Skills | `GET, POST /skills`; `GET, PUT, DELETE /skills/:skillId` |
| Conversations | `GET, POST /conversations`; `GET /conversations/:conversationId`; `POST /conversations/:conversationId/respond` |

Mutating requests accept JSON only. Every API response uses a `{ "data": ... }` envelope on success and `{ "error": { "code", "message", "requestId" } }` on failure.

## Local records

- `providers`: display name, normalized base URL, encrypted credential bundle, and timestamps.
- `provider_models`: selected model IDs, scoped to a provider.
- `skills`: name, description, instructions, and timestamps.
- `conversations` and `messages`: local chat history. Provider/model IDs are recorded with messages, but credentials never are.

## Explicit security decisions

- `APP_ENCRYPTION_KEY` is a base64-encoded 32-byte key supplied in `.env`, never generated into source control. Credentials are encrypted separately using authenticated AES-256-GCM before entering SQLite.
- SQL uses prepared statements. Inputs are bounded and validated at the server boundary.
- The upstream OpenAI-compatible request is made only by the server. The UI works with safe provider metadata and IDs.
- Credential strings are never logged, returned, persisted in browser storage, interpolated into HTML, or included in query strings.
- The project currently refuses non-loopback binding. LAN/public support will be a separate authenticated release rather than an unsafe environment toggle.

## Deferred, not omitted

Tool execution and attachment processing require a separate capability-permission model and sandboxing policy, so the initial Attach affordance remains a clearly labelled future capability. Streaming responses, account auth, LAN/public access, full tool execution, and production backup scheduling follow after this secure local workflow is proven.
