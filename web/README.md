# WRA web

React frontend for WRA — Workspace Relay for Agents. It is the default UI, served whenever
`web/dist` exists; `CR_REMOTE_UI=classic` selects the classic UI as the rollback path. See
`docs/FRONTEND-2.md`.

```bash
npm install
npm run dev      # Vite dev server, proxies /local and /ws to 127.0.0.1:4310
npm run build    # writes dist/, served by the server by default
npm run typecheck
```
