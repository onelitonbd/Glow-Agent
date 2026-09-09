# Glow-Agent

Planning for a mobile-friendly web application with a JavaScript backend running in Termux.

- [Termux web application plan](docs/TERMUX_WEB_APP_PLAN.md)
- [Mobile UI design exploration](design-exploration.html) — a self-contained, interactive HTML review with three palettes and three mobile-screen directions.
- [Neural Ink chat-page design](chat-page.html) — the selected dark/precise mobile chat direction, without bottom navigation. Its left icon opens an accessible chat-history drawer; the top-centre session title truncates long names with an ellipsis; its two-stage composer separates text entry from attach/model actions.
- [Neural Ink settings-page design](settings-page.html) — the first dedicated settings screen. Its Providers button opens a focused in-page Providers section; Add provider opens a blurred modal with primary and unlimited backup-key inputs.
- [Neural Ink models-page design](models-page.html) — the provider-level Models page with separate Selected models and Fetch models sections.
- [Neural Ink skills-page design](skills-page.html) — reusable assistant expertise with a blurred Add skill modal.
- `design-previews/` — PNG previews for Neural Ink / Focus Chat, Iris Signal / Agent Run, Paper Circuit / Skills & Tools, the selected [Neural Ink chat page](design-previews/neural-ink-chat-page.png), its [chat-history drawer](design-previews/neural-ink-chat-history.png), [settings page](design-previews/neural-ink-settings-page.png), [Providers section](design-previews/neural-ink-providers-section.png), [Add provider modal](design-previews/neural-ink-add-provider-modal.png), [configured Providers](design-previews/neural-ink-providers-populated.png), [Models after fetch](design-previews/neural-ink-models-page.png), [chat model picker](design-previews/neural-ink-chat-model-picker.png), [Skills page](design-previews/neural-ink-skills-page.png), and [Add skill modal](design-previews/neural-ink-add-skill-modal.png).

The product brief is the next required step before implementation. The plan lists the exact decisions needed and the proposed frontend, backend, security, database, and Termux approach.
