# Glow Agent

**Glow Agent** is a mobile-first, local-first AI workspace designed to run from Termux. It uses plain HTML, CSS, and browser JavaScript on the frontend, with a same-origin Node.js/Express API and local SQLite database on the backend.

The current implementation supports OpenAI-compatible BYOK providers, server-side model discovery, persistent selected models, reusable skills, safe built-in tools, local conversation history, and non-streaming chat completions. Provider API keys are encrypted before they are stored in SQLite and are never returned to the browser after save.

## Run locally in Termux

Glow Agent requires **Node.js 22.13+** because it uses Node's built-in SQLite module.

```sh
pkg update && pkg upgrade
pkg install nodejs-lts git
cd ~/Glow-Agent
npm ci
cp .env.example .env
```

Generate a unique encryption key, then paste it as `APP_ENCRYPTION_KEY` in `.env`:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Start the app:

```sh
npm start
```

Open `http://127.0.0.1:3000` on the Termux device. Check the service with:

```sh
curl http://127.0.0.1:3000/api/v1/health
```

For development with file watching, run `npm run dev`. Run automated API checks with `npm test` and syntax checks with `npm run check`.

## Security boundary

- The MVP **only binds to loopback** (`127.0.0.1`, `::1`, or `localhost`). It intentionally refuses LAN/public binding until user authentication, authorization, and an HTTPS deployment design are implemented.
- Use a long random `APP_ENCRYPTION_KEY`, keep `.env` private, and do not change the key after adding providers: the existing encrypted credentials would become unreadable.
- The SQLite database lives under `data/`, which is ignored by Git. Back it up only to storage you trust, together with a secure copy of the encryption key.
- API keys are never included in URLs, client markup, browser storage, normal API responses, or request logs. Model discovery and chat requests are made only by the server.

## Current workflow

1. Open **Providers** and add an OpenAI-compatible provider with its base URL and primary API key. Optional backup keys are tried only for upstream `401`, `403`, or `429` responses.
2. Open **Models** for that provider, fetch `/models`, and add the models you want available in chat.
3. Create reusable **Skills**. The three-dot menu opens below each skill card and offers Configure and Delete. In chat, select zero or more skills for the next request.
4. In the chat composer, optionally permit the **Calculator** and/or **Current time** tool for the next response. Tool calls are requested by the model but validated and executed only by the server; no model-supplied shell commands or arbitrary JavaScript are allowed.
5. Select a provider/model using the compact composer icon and send a message. Glow Agent persists the conversation locally, applies selected skills, performs any selected tool calls, and calls the configured provider's `/chat/completions` endpoint from the server.

Attachments, streaming responses, accounts, networked deployment, and richer tools are deliberately deferred to later security-focused phases. The Attach control is labelled accordingly rather than pretending those capabilities are active.

## Documentation and design references

- [Concrete MVP implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Termux web application plan](docs/TERMUX_WEB_APP_PLAN.md)
- [Mobile UI design exploration](design-exploration.html) — interactive review of three palettes and three mobile directions.
- [Neural Ink chat design](chat-page.html), [settings/Providers design](settings-page.html), [Models design](models-page.html), and [Skills design](skills-page.html) — prototype references for the implemented mobile direction.
- `design-previews/` — PNG previews including the [Neural Ink chat page](design-previews/neural-ink-chat-page.png), [chat model picker](design-previews/neural-ink-chat-model-picker.png), [Skills page](design-previews/neural-ink-skills-page.png), [Add skill modal](design-previews/neural-ink-add-skill-modal.png), and [skill actions](design-previews/neural-ink-skill-actions.png).
