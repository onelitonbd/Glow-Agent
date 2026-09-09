# Termux Web Application Plan

**Planning status:** ready for product discovery

**Repository review (9 September 2026):** this repository currently has only `README.md`. There are no source files, image assets, or existing architecture to preserve.

## 1. Agreed direction

We will create a **real, responsive website** rather than a one-screen mockup:

- **Frontend:** plain HTML, CSS, and browser JavaScript — no React, no build-only UI framework.
- **Backend:** JavaScript running under Node.js in Termux on Android.
- **Database:** SQLite stored locally on the Termux device.
- **Connection model:** the frontend and API are served by the same Node server. Browser code uses relative URLs such as `/api/auth/login`, never `localhost` hard-coded into JavaScript.
- **Design priority:** mobile-first, fast on mid-range phones, with polished desktop layouts as the screen grows.

“Only HTML, CSS and JavaScript” is fully compatible with this plan: the web pages use those three technologies and the server is JavaScript too. Node/Express and SQLite are infrastructure, not a separate frontend technology.

The product’s actual purpose is still unknown, so the first implementation should be a reusable secure foundation. Exact pages, records, roles, and database fields will be based on the product brief.

## 2. Recommended architecture

```text
Phone / desktop browser
        │
        ├── GET /             static HTML, CSS, JavaScript
        └── /api/*            JSON requests over the same origin
                                 │
                         Node.js + Express in Termux
                         ├── route layer
                         ├── authentication / authorization middleware
                         ├── validation and error handling
                         └── repository / service layer
                                 │
                              SQLite database
```

### Why this is the right starting stack

| Area | Choice | Reason |
| --- | --- | --- |
| Interface | Semantic HTML + custom CSS + ES modules | Complete control, little overhead, excellent load performance, and no framework lock-in. |
| Interaction | `fetch`, DOM APIs, native form controls | Standard browser features that work across modern Android and desktop browsers. |
| Server | Node.js LTS + Express | One language end-to-end; simple to operate from Termux; mature middleware and routing model. |
| Persistence | SQLite | A single local database file, transactional, low-maintenance, and well-suited to a single Termux host. |
| Auth | Cookie-based opaque sessions | Keeps tokens out of `localStorage`; a session can be revoked at the server. |
| Passwords | Node `crypto.scrypt` with a unique random salt | No plaintext passwords; avoids reliance on a native password-hashing add-on in Termux. |

SQLite is the correct first database for a phone-hosted, low-to-moderate traffic service. If the product later needs many concurrent public users, separate backups, jobs, and a managed PostgreSQL deployment become appropriate.

## 3. Proposed source layout

```text
Glow-Agent/
├── client/
│   ├── index.html                 # public landing/home page
│   ├── pages/                     # auth, dashboard, feature pages
│   ├── assets/
│   │   ├── css/                   # reset, tokens, layout, components, pages
│   │   ├── js/                    # api client, views, UI utilities
│   │   └── icons/
│   └── 404.html
├── server/
│   ├── app.js                     # Express configuration
│   ├── server.js                  # process entry point and graceful shutdown
│   ├── routes/                    # narrow HTTP route handlers
│   ├── controllers/               # request/response coordination
│   ├── services/                  # product rules
│   ├── repositories/              # parameterized database queries
│   ├── middleware/                # auth, role checks, validation, rate limits
│   ├── db/
│   │   ├── migrations/            # versioned schema changes
│   │   └── seed.js                # development-only data
│   └── lib/                       # config, logger, errors, crypto
├── data/                           # ignored: live SQLite database and backups
├── tests/                          # API and browser-flow tests
├── docs/
│   └── TERMUX_WEB_APP_PLAN.md
├── .env.example                    # variable names only; never secret values
├── .gitignore
├── package.json
└── README.md
```

The client will use several focused pages or server-served views with shared header/navigation/footer components. It will not be an oversized single HTML file.

## 4. Frontend skill plan and quality bar

I will apply the following frontend design and implementation skills during the build:

1. **Information architecture** — clear page hierarchy, meaningful navigation, obvious primary action, and empty/loading/error states designed before details.
2. **Mobile-first responsive design** — CSS custom properties, fluid spacing/type, Flexbox/Grid, touch-friendly controls, then progressive desktop layouts.
3. **Reusable design system** — tokens for color, spacing, radius, shadows, typography, transitions, and reusable buttons/forms/cards/dialogs. The result will feel like one product rather than unrelated screens.
4. **Semantic and accessible markup** — native landmarks, headings in logical order, visible keyboard focus, labelled inputs, appropriate button/link elements, modal focus management, colour contrast, and reduced-motion support.
5. **Vanilla JavaScript engineering** — ES modules, a centralized API client, event delegation where useful, form validation, safe DOM rendering (no unsanitized `innerHTML` for user data), state-specific UI, and no duplicated request logic.
6. **Performance** — minimal dependencies, system fonts or limited font weights, compressed responsive images if used later, defer/module scripts, and no unnecessary animation or network calls.

Semantic HTML should come first: it gives browsers and assistive technology useful behaviour without recreating it in JavaScript. MDN specifically recommends using the right HTML element for the job, labels for form controls, keyboard-accessible controls, and sensible source order.[^mdn-semantics]

## 5. Backend skill plan and quality bar

1. **API design** — versioned, resource-oriented `/api/v1/...` routes; predictable JSON envelopes; appropriate HTTP status codes; pagination/filtering only where needed.
2. **Validation at the boundary** — enforce types, required fields, lengths, formats, and allowed values on the server. Browser validation improves UX but is never trusted for security.
3. **Layered JavaScript backend** — handlers do HTTP work, services enforce product rules, repositories access SQLite. This keeps changes testable and prevents SQL in the UI layer.
4. **Database discipline** — migrations, foreign keys, unique constraints, indexes based on real query paths, parameterized queries, transactions for multi-step changes, and scheduled backups before migrations.
5. **Authentication and permissions** — sign-up/login/logout/current-user endpoints; strong password handling; session expiry and revocation; route-level role/ownership checks for every protected record.
6. **Operational readiness** — environment-based configuration, structured request/error logging without passwords or tokens, health endpoint, safe error responses, graceful shutdown, backup and restore instructions.

OWASP advises slow, salted password hashing rather than plaintext or fast hashes; its guidance names scrypt as an option when Argon2id is not available.[^owasp-passwords] Authentication endpoints also need rate limiting and anti-brute-force controls.[^owasp-auth]

## 6. Baseline security rules

These are non-negotiable for the first usable backend:

- Parameterize every SQL query; never concatenate user-controlled text into SQL.
- Parse only JSON with a size limit, validate every request, and send generic errors to clients.
- Use an opaque, cryptographically random session identifier in an `HttpOnly`, `SameSite=Lax` cookie. Store only a hash of the session identifier in the database.
- Hash passwords asynchronously with `crypto.scrypt`, a per-password random salt, and a tuned memory limit that is safe for the specific phone. Do not log or return password material.
- Rate-limit login, sign-up, password reset, and other sensitive actions. Return generic login/reset failures to reduce account enumeration.
- Enforce ownership/role checks on the server for every record ID; hiding a button in the UI is not authorization.
- Add security headers, an explicit CORS policy (normally no CORS is needed because frontend and API share an origin), request body limits, and production HTTPS when traffic leaves the device.
- Commit `.env.example`, but ignore `.env`, databases, backups, logs, and uploaded private files.

## 7. Termux operation model

### Initial local installation

The exact installation command will be verified against the current Termux package repository before implementation, but the expected workflow is:

```sh
pkg update && pkg upgrade
pkg install nodejs-lts git sqlite
cd ~/Glow-Agent
npm install
cp .env.example .env
npm run start
```

The server will listen only on `127.0.0.1` by default. This is safest when the site is used only from the phone itself. A deliberate `HOST=0.0.0.0` setting can make it available to devices on the same Wi-Fi network; that mode must use a firewall/network trust decision and authenticated users. A public deployment should sit behind HTTPS and a reverse proxy or managed tunnel — it must not expose an unauthenticated development server directly.

For long local runs, Termux’s wake-lock capability and an Android battery-optimization exception may be needed. The launch scripts will document the safe foreground/background workflow, health check, logs, backup, and restore procedure.

Termux describes itself as an Android terminal and Linux environment extended through packages.[^termux]

## 8. Delivery phases

### Phase 0 — product brief (next)
Define the product name, users, core job, pages, data objects, roles, and whether access is phone-only, LAN, or public. This is the only blocking phase.

### Phase 1 — foundation
- Initialize the Node project, lint/test scripts, `.gitignore`, environment example, static client shell, and responsive design tokens.
- Start Express, serve the client, add `/api/v1/health`, central error handling, structured logs, and a local Termux run guide.
- Create SQLite migration runner and backups directory policy.

**Acceptance check:** `npm run start` opens a polished responsive shell and `GET /api/v1/health` reports a healthy server.

### Phase 2 — identity and core data
- Implement the approved schema and CRUD API.
- Build registration/login/logout/current-user flows only if the product needs accounts.
- Add protected dashboard/list/detail/create-edit pages with complete loading, empty, success, and error states.

**Acceptance check:** a user can safely complete the primary real-world task; data persists after a server restart; unauthorized data access is denied.

### Phase 3 — product polish
- Add search/filter/sort/pagination where justified, profile/settings, role-specific UI, responsive refinements, accessibility audit, and form usability improvements.
- Add chosen domain features only after the core workflow works end-to-end.

### Phase 4 — hardening and handover
- API tests, manual mobile/browser checks, dependency audit, backup/restore rehearsal, security review, production environment instructions, and deployment notes.

**Acceptance check:** installation and recovery can be performed from the documentation on a fresh Termux environment.

## 9. Decisions needed before coding the actual app

Please provide short answers to these:

1. **What is the website for?** Describe the main task in one or two sentences (for example: shop management, booking, inventory, community, learning, portfolio, etc.).
2. **Who will use it?** One owner only, registered customers, staff/admin roles, or the public?
3. **What are the three most important actions a user must complete?**
4. **Which data must be stored?** List the main records and a few fields for each (for example, `products: name, price, stock`).
5. **How should it be reached?** Only on the Termux phone, over local Wi-Fi, or publicly from the internet? Does it need a custom domain?
6. **Which visual direction do you prefer?** Minimal/professional, bold/colourful, dark, light, or a site whose feel we should emulate?

After those decisions, I will turn this plan into the repository’s concrete page map, API contract, database schema, and the first working implementation.

## Research references

[^termux]: [Termux package/documentation overview](https://packages.termux.dev/) — Termux is an Android terminal/Linux environment extended with packages.
[^mdn-semantics]: [MDN: HTML — a good basis for accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/HTML) — semantic controls, labels, keyboard access, source order, and text alternatives.
[^owasp-passwords]: [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) — use modern slow password hashes with salts; do not store passwords as plaintext.
[^owasp-auth]: [OWASP API Security: Broken Authentication prevention](https://owasp.org/API-Security/editions/2023/en/0xa2-broken-authentication/) — rate limiting, anti-brute-force controls, and re-authentication for sensitive changes.
