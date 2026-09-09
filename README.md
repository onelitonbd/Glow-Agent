# Glow Agent

**Glow Agent** is a mobile-first, local-first AI workspace designed to run from Termux. It uses plain HTML, CSS, and browser JavaScript on the frontend, with a same-origin Node.js/Express API and local SQLite database on the backend.

The current implementation supports OpenAI-compatible BYOK providers, server-side model discovery, persistent selected models, reusable skills, safe built-in tools (calculator, current time, workspace file read/write/list, read-only SQL, DuckDuckGo web search, and URL fetch), local conversation history, live streaming chat completions, and safe client-side Markdown rendering for assistant answers. Provider API keys are used only by the local server and are never returned to the browser after save.

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

- The MVP **only binds to loopback** (`127.0.0.1`, `::1`, or `localhost`). It intentionally refuses LAN/public binding until user authentication, authorization, and an HTTPS deployment design are implemented.
- Provider API keys are stored **unencrypted** in the local SQLite database under `data/`, following the requested simplified setup. Protect the Termux device and do not copy the database to untrusted storage.
- API keys are not included in URLs, client markup, browser storage, normal API responses, or request logs. Model discovery and chat requests are made only by the local server.
- If you used an earlier encrypted version of Glow Agent, existing provider cards will ask you to enter their API key again after upgrading. The old encrypted key cannot be converted without its previous encryption key.

## Current workflow

1. Open **Providers** and add an OpenAI-compatible provider with its base URL and primary API key. Optional backup keys are tried only for upstream `401`, `403`, or `429` responses.
2. Open **Models** for that provider, fetch `/models`, and add the models you want available in chat.
3. Create reusable **Skills**. The three-dot menu opens below each skill card and offers Configure and Delete. Every skill is advertised to the model by id, name, and description; when the model needs a skill it calls the **read_skill** tool to load that skill's full instructions on demand — no selection is needed.
4. All built-in tools are offered to the model automatically for every message; no selection is needed. They include **Calculator**, **Current time**, **List files**, **Read file**, **Write file** (scoped to the workspace project directory), **SQL query** (read-only SELECT against the local database), **Web search** (DuckDuckGo), and **Fetch URL** (HTTP/HTTPS page to text). Tool calls are requested by the model but validated and executed only by the server; no model-supplied shell commands or arbitrary JavaScript are allowed, and file/SQL tools are confined to the workspace.
5. Select a provider/model using the compact composer icon and send a message. Glow Agent persists the conversation locally, applies any skills/tools the model requests, and forwards the provider's `/chat/completions` stream as live response text. The chat shows the assistant's real sequence as it happens — thinking, response text, tool calls, and tool results — in the true order, and saves that ordered timeline with the message so it replays truthfully on reload.

Assistant answers are rendered safely as Markdown: headings, emphasis, links, lists, quotes, task lists, fenced code blocks, tables, and common LaTeX-style inline/display math are supported. Raw provider HTML is never injected into the page. Attachments, accounts, networked deployment, and richer tools are deliberately deferred to later security-focused phases. The Attach control is labelled accordingly rather than pretending those capabilities are active. When a compatible provider streams reasoning text, Glow Agent shows it in a live Thinking disclosure; it never invents reasoning for providers that do not send it. Tool usage is also streamed live: when the model requests a tool, a "Using …" card appears, and the result is shown immediately after, in the same order.

## Documentation and design references

- [Concrete MVP implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Termux web application plan](docs/TERMUX_WEB_APP_PLAN.md)
- [Mobile UI design exploration](design-exploration.html) — interactive review of three palettes and three mobile directions.
- [Neural Ink chat design](chat-page.html), [settings/Providers design](settings-page.html), [Models design](models-page.html), and [Skills design](skills-page.html) — prototype references for the implemented mobile direction.
- `design-previews/` — PNG previews including the [Neural Ink chat page](design-previews/neural-ink-chat-page.png), [chat model picker](design-previews/neural-ink-chat-model-picker.png), [Skills page](design-previews/neural-ink-skills-page.png), [Add skill modal](design-previews/neural-ink-add-skill-modal.png), and [skill actions](design-previews/neural-ink-skill-actions.png).
