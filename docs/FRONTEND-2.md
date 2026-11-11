# Frontend 2.0

The React frontend for WRA. It lives in `web/` and is the **default**: the server serves it whenever
`web/dist` exists. The classic UI in `src/web/` remains the rollback path, selected with
`CR_REMOTE_UI=classic`.

## Build and run

```bash
cd web && npm install && npm run build
wra serve
```

Without `web/dist/index.html` the server serves the classic UI. To force the classic UI even when
`web/dist` exists, set `CR_REMOTE_UI=classic`:

```bash
CR_REMOTE_UI=classic wra serve
```

## Stack

React 19, TypeScript, Vite 7, Tailwind CSS 4, Radix primitives (shadcn-style components written
in `web/src/components/ui`), Lucide icons, xterm.js for the advanced terminal (lazy-loaded).

## Structure

```
web/src/
├── lib/            api, websocket store, types, markdown, theme
├── components/
│   ├── ui/         button, dialog, popover, dropdown, tabs, switch, tooltip, …
│   ├── layout/     app shell and sidebar
│   └── conversation/  message, tool card, diff, composer, approvals, permissions, ChatGPT
└── pages/          conversations, conversation, projects, settings, login
```

## Product rules

- Three destinations: Conversations (default), Projects, Settings.
- Conversations are persistent objects. Opening one resumes its agent automatically; the UI never
  exposes start/stop/attach/detach.
- User-facing states are only: Thinking, Needs approval, Connection lost (with retry).
- Permissions are per conversation, in a compact popover. Bypass is labelled as high risk.
- ChatGPT exposure is one dialog, with an explicit confirmation when the conversation bypasses
  permissions.
- English throughout.

## Backend contract

The new UI uses the existing routes unchanged: `/local/sessions`, `/local/sessions/:id/:action`,
`/local/projects/:action`, `/local/talk`, `/local/approvals`, `/local/admin/*`, `/healthz`, and the
`/ws` protocol (proto 2). No backend, OAuth, MCP, PTY or registry code was rewritten.

## Verification

Screenshots in `docs/screenshots/frontend-2/`. The isolated fixture used for them is
`tools/ui-fixture.mjs`; it never touches real conversations.