# Glow Agent

**Glow Agent** is a mobile-first, local-first AI workspace designed to run from Termux. It uses plain HTML, CSS, and browser JavaScript on the frontend, with a same-origin Node.js/Express API and local SQLite database on the backend.

The current implementation supports OpenAI-compatible BYOK providers, server-side model discovery, persistent selected models, reusable skills, safe built-in tools (calculator, current time, workspace file read/write/list, read-only SQL, DuckDuckGo web search, and URL fetch), developer file-management tools (edit/create/rename/delete for files and folders), an optional shell tool, local conversation history, live streaming chat completions, and safe client-side Markdown rendering for assistant answers. Provider API keys are used only by the local server and are never returned to the browser after save.

## Run locally in Termux

Glow Agent requires **Node.js 22.13+** because it uses Node's built-in SQLite module.

```sh
pkg update && pkg upgrade
pkg install nodejs-lts git
cd ~/Glow-Agent
npm ci
npm start
```

Open `http://127.0.0.1:3000` on the Termux device. Check the service with:

```sh
curl http://127.0.0.1:3000/api/v1/health
```

The defaults work without an `.env` file. To use a different local port or database location, copy the optional configuration template:

```sh
cp .env.example .env
```

For development with file watching, run `npm run dev`. Run automated API checks with `npm test` and syntax checks with `npm run check`.

## Storage and security boundary

- The MVP **only binds to loopback** (`127.0.0.1`, `::1`, or `localhost`). It intentionally refuses LAN/public binding until user authentication, authorization, and an HTTPS deployment design are implemented. This matters more than ever once developer tools are enabled: anything that can reach the chat API can reach the enabled tools.
- Provider API keys are stored **unencrypted** in the local SQLite database under `data/`, following the requested simplified setup. Protect the Termux device and do not copy the database to untrusted storage. All file tools refuse paths matching `*.sqlite`, and the shell tool refuses commands that reference them — but treat those as guardrails against model mistakes, not a vault.
- API keys are not included in URLs, client markup, browser storage, normal API responses, or request logs. Model discovery and chat requests are made only by the local server.
- **File tools are sandboxed to the assistant workspace.** Every file tool — list, read, create, edit, write, rename, delete — only works inside `data/workspace/` (the assistant's own folder, also where plugin clones live). The app's code, skills, settings, and database are unreachable: paths outside the folder are refused, symlink escapes included, and `.git`/`.env`/database names are refused everywhere. Delete and overwrite are real; disable **File management** in Other settings if you want read-only-only behaviour.
- **Shell is unsandboxed by design and off by default.** Enabling it gives the model the same powers you have in Termux on that device — it can read what your user can read and change what your user can change, well beyond the project folder. It exists for trusted single-owner use, not for any context where the prompt cannot be trusted (note that fetched web pages and MCP server output *are* untrusted prompt content).
- **Per-command approval is available.** With **Other settings → Developer tools → Approve each command** on, every `run_shell` call pauses the live chat on a card showing the exact command; nothing runs until you tap **Approve** (or the request expires, which counts as a denial). Only your tap can settle the card — the model never sees the approval id and cannot approve its own commands. Denials and refusals are relayed to the model with a do-not-retry instruction.
- If you used an earlier encrypted version of Glow Agent, existing provider cards will ask you to enter their API key again after upgrading. The old encrypted key cannot be converted without its previous encryption key.

## Current workflow

1. Open **Providers** and add an OpenAI-compatible provider with its base URL and primary API key. Optional backup keys are tried only for upstream `401`, `403`, or `429` responses.
2. Open **Models** for that provider, fetch `/models`, and add the models you want available in chat.
3. Create reusable **Skills**. The three-dot menu opens below each skill card and offers Configure and Delete. Every skill is advertised to the model by id, name, and description; when the model needs a skill it calls the **read_skill** tool to load that skill's full instructions on demand — no selection is needed.
4. All built-in tools are offered to the model automatically for every message; no selection is needed. They include **Calculator**, **Current time**, **List files**, **Read file** (paged for large files), **Write file**, **Edit file** (targeted search/replace), **Create file** / **Create folder**, **Delete file** / **Delete folder**, **Rename file** / **Rename folder**, **SQL query** (read-only SELECT against the local database), **Web search** (DuckDuckGo), **Fetch URL** (HTTP/HTTPS page to text), and the **memory pair**: **Search conversations** (keyword search over past chats — returns only titles and tiny snippets) plus **Read conversation** (pages through one chat a few messages at a time, like a paged file read). The model can therefore recall things from earlier sessions without those sessions ever flooding the current context. Tool calls are requested by the model but validated and executed only by the server; every file tool is confined to the assistant workspace folder (`data/workspace/`) by a shared realpath guard that refuses escapes and protected names, and web fetches refuse private/local network addresses. File-management tools can be switched off (and shell switched on) in **Other settings → Developer tools**. The **Shell command** tool (`run_shell`, off by default) runs one-off `sh -c` commands from the workspace root — unsandboxed, as the device's own user — with a kill timeout (default 30 s, max 120 s), 16 KB captured output per stream, a scrubbed environment, and a blanket refusal of commands that reference `*.sqlite` files. There is no cap on how many tools or skills a response may use: the model can keep round-tripping through tools (each round may request as many calls as the provider returns) up to a high safety ceiling (`MAX_TOOL_ROUNDS`, default 500) so a runaway loop can't hang the request.
5. Select a provider/model using the compact composer icon and send a message. Glow Agent persists the conversation locally, applies any skills/tools the model requests, and forwards the provider's `/chat/completions` stream as live response text. The chat shows the assistant's real sequence as it happens — thinking, response text, tool calls, and tool results — in the true order, and saves that ordered timeline with the message so it replays truthfully on reload. **Every conversation has its own address** — `/chat/<id>` — like ChatGPT and Claude: opening a chat from history (or pasting its link) lands straight in that conversation, the address bar follows as chats are opened, switched, or created by the first message, the header **link button copies** the current chat's URL, Back/Forward move between chats, and a link to a deleted chat falls back to a fresh conversation with a notice. **The send button becomes a red Stop button** the moment a reply starts streaming: tapping it ends the response immediately — even mid-token, mid-tool-call, or while a shell approval card waits — and whatever the model already wrote is kept and marked *Stopped* in the conversation instead of being lost.

Assistant answers are rendered safely as Markdown: headings, emphasis, links, lists, quotes, task lists, fenced code blocks, tables, and common LaTeX-style inline/display math are supported. Raw provider HTML is never injected into the page. Attachments, accounts, networked deployment, and richer tools are deliberately deferred to later security-focused phases. The Attach control is labelled accordingly rather than pretending those capabilities are active. When a compatible provider streams reasoning text, Glow Agent shows it in a live Thinking disclosure; it never invents reasoning for providers that do not send it. Tool usage is also streamed live: when the model requests a tool, a "Using …" card appears, and the result is shown immediately after, in the same order. If a provider request fails — a network error, a 5xx response, a timeout, or a mid-stream interruption — Glow Agent retries it up to `MAX_PROVIDER_RETRIES` (default 20). On a mid-stream interruption it resumes from the partial text already produced (keeping that text and asking the model to continue from exactly where it stopped) rather than restarting the request from scratch.

## Documentation and design references

- [Concrete MVP implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Termux web application plan](docs/TERMUX_WEB_APP_PLAN.md)
- [Mobile UI design exploration](design-exploration.html) — interactive review of three palettes and three mobile directions.
- [Neural Ink chat design](chat-page.html), [settings/Providers design](settings-page.html), [Models design](models-page.html), and [Skills design](skills-page.html) — prototype references for the implemented mobile direction.
- `design-previews/` — PNG previews including the [Neural Ink chat page](design-previews/neural-ink-chat-page.png), [chat model picker](design-previews/neural-ink-chat-model-picker.png), [Skills page](design-previews/neural-ink-skills-page.png), [Add skill modal](design-previews/neural-ink-add-skill-modal.png), and [skill actions](design-previews/neural-ink-skill-actions.png).
