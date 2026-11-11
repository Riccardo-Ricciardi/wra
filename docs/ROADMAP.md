# Roadmap

What is finished, what is in progress, what is planned — and for everything planned, **what it
means for it to be finished**. Past phases are in `HANDOFF.md` with their evidence; here is only
what remains.

State as of **4 November 2026**, branch `main`.

---

## Done

| Phase | What | State |
|---|---|---|
| M1–M5 | Terminal in the browser, chat, live sync, per-conversation permissions, projects and conversations | closed |
| Phase 1 | Stability: PTY races, `wra stop` not killing foreign processes, registry corruption, `Ctrl+C`/`Ctrl+Q`, configurable remote access | closed |
| Phase 2A | Daily use: home, multi-select, filters, navigation with hundreds of conversations | closed |
| Phase 2B | Admin panel, guided access, backups and restore, processes, settings | closed |
| Phase 3 | Live-server acceptance, PWA shell, release preparation | closed |
| — | "Controlled automatic mode": a policy that grants only what it can verify | closed |
| — | Long-turn lifecycle: the listening window is no longer the end of the turn | closed |
| — | `MCP bypass`: the absolute ban becomes an explicit, dated, revocable consent | closed · on branch `feature/mcp-bypass-esplicito`, **not on `main`** |
| M6 | UX/UI redesign: design system, truthful authorization modes, before/after | closed |
| M7 | Architectural refactoring: `core/`, `state/`, `ui/`, documented React decision | closed |
| M8 | FreeLLMAPI visual language, four-page shell, registry cleanup | closed |
| M8.1 | The bench that builds its own world, the 35 green checks, and the views out of `app.js` | closed |
| M9 | UX/UI remediation: anchored menus, the five-section panel, test entries, reconciliation | closed |

---

## M9 — interface remediation (UX/UI) — **closed**

The owner's milestone after trying the real interface. Six phases, all finished; the plan and the
measurements are in `docs/M9-AUDIT.md`, the before/after screenshots in `docs/screenshots/m9/`.

### 1. The audit — `docs/M9-AUDIT.md`

Reproduced with a real browser and an isolated bench, and looked at on **real data** (a read-only
copy: 84 conversations, 64 project metadata). The three defects that mattered: the menus at
`left: 8px`, the 64 test entries in front of the 9 real folders, and the two conversation lists that
did not match.

### 2. The menus, and the components

The cause was not `left: 8px`: it was that the menu measured itself **before** `position: fixed`.
The geometry is now `src/web/ui/anchor.mjs` — pure, tested in Node — with three rules: inside the
screen, attached to its anchor, flipped only when there is no room below. The layer scale is
declared in the tokens and used by everyone; focus does not leave dialogs with Tab; a choice among a
few is drawn as a dot, not as four switches.

**Measured**: controls outside the window at six widths **7 → 0**; targets under 40px where the
finger is **21 → 0**. The bottom sheet on the phone is gone.

### 3. The panel

Five sections, one at a time, secondary navigation on the left and fixed, a single reading column,
explanations behind "why…", diagnostics closed in their own section. `ui-admin-check.mjs` 18/18,
and fields do not lose what you write in **any** section.

### 4. Projects and conversations

Test entries are hidden by default (a row at the bottom, not a block at the top) and the header
number counts the same thing as the page. Reconciliation between registry and transcript lives in
`src/core/reconcile.mjs` (pure, 8 cases in Node) and in the "Conversations" section of the panel:
preview, deduplication, copy before writing, explicit confirmation, and **nothing is deleted**.

### 5. The identity

`icon.svg` was still `#2563a8` — the old blue. Now the SVG and the PNGs come from a single drawing,
and three tests prevent them from drifting apart.

### 6. The acceptance test

`node --test` **491/491**, `ui-check.mjs` **38/38** even with 1000 conversations, `ui-admin-check.mjs`
**18/18** even with 1000, flat performance (177–293 ms from 10 to 1000), contrast in order,
`npm audit` 0, security review of the diff. The real registry was not touched: SHA-256 identical
before and after.

**A defect found only on real data**: at 320px, on 30 of 84 rows, the `⋯` button left the row (the
row could not shrink: `width: 100%` + `min-width: auto`) and was cut off by the card's
`overflow: hidden`. The bench did not show it because the seed names are short.

---

## To do now

M8.1 closed the two things M8 left open. What remains is **outside the repo**, and blocks nothing.

### Done in M8.1 — the two things M8 left open

1. **The bench, and the checks.** `ui-check.mjs` was at **27 out of 35**. It is now at **35 out of
   35**, and the bench no longer modifies the registry under its feet: it builds its own world on
   every run (`tools/bench.mjs`) and `tools/bench-rounds.mjs` proves that **ten rounds in a row give
   the same result**. Four rounds of ten were served: the first ten out of ten, the second **nine**
   out of ten (a real flakiness — a fixed wait), the third stopped at four greens at the owner's
   request, the fourth — on the final code and with the access check made stricter — **ten out of
   ten**. And the fourth also closed the defect that the detail of the previous rounds indicated:
   the panel redraws itself every five seconds and rebuilt the fields from the saved value, so what
   you were typing disappeared under your fingers (with focus). The red that remained was a fact
   that lived elsewhere — a running conversation is drawn in the "Now" tab, which has no sections —
   and the step that masked it was an `if` that skipped silently. And `tools/bench-solo.mjs`, which
   runs **every check alone**, found **ten hidden dependencies** that the whole round could not see.
   Details and diagnosis: `docs/M81-APERTO.md`.
2. **The views out of `app.js`.** From **2481 lines** to **949**, with nine factories in
   `src/web/ui/views/` — one per responsibility, each with its boundaries written down. The table is
   in `docs/M81-APERTO.md` §3, and `tools/estrazione-check.mjs` compares the bodies of the moved
   functions with the old `app.js`: it is a move, not a rewrite.

### The 64 test entries in the owner's registry

They are in `~/.cc-remote/projects.json`, they are metadata, and **they are not conversations**: now
they are visible on the Projects page, hidden with a filter, and removed with a preview,
confirmation and a copy written first. Removing them is the owner's decision, not the program's.

### The M8.1 screenshots

**Done.** `docs/screenshots/m81/` has 20 images of the interface in `dopo/` and 7 of the panel in
`pannello/`, regenerated from the current code with
`node tools/ui-check.mjs --shot docs/screenshots/m81/dopo` and
`node tools/ui-admin-check.mjs --shot docs/screenshots/m81/pannello`. The framing is the same as the
previous round, and 14 of the 27 images are byte-identical: the extraction did not change a pixel.

---

## M6 — interface redesign (UX/UI) — **closed**

**Why it was needed.** The interface had grown by successive additions: every phase added what it
needed, and the result was coherent in the code and not in the head of whoever uses it. And there
were **three ways to authorise** coexisting in the same row — normal, controlled automatic, bypass —
plus exposure to ChatGPT: four states distinguished by the colour of an 11px badge.

### 1. Audit — `docs/AUDIT-M6.md`

Nine defects, each with its measurement. The three that matter:

- **everything at 11px**: 88 text nodes out of 118, that is, the whole interface at the same size.
  There was no hierarchy, and "technical and quiet" had been realised as "small and grey".
- **four names for three axes**: `bypass`, `MCP`, `auto (here)`, `auto (project)`. `bypass` does not
  say what happens; `MCP` does not say it is an exposure.
- **the conversation menu**: eleven items, four jobs, and the three that change the security model at
  the same height as "copy the id".

**And one thing that is not needed**: performance is **flat** up to 2000 conversations (109–121 ms
to open, 30–46 ms to search). No virtualisation, no pagination.

### 2. Direction — `PRODUCT.md`

New. `product` register, users (at the PC, from the phone, and those who do not know Claude Code), and
the anti-references — starting from the previous interface, which the owner described as "an
experimental technical panel".

### 3. System — `docs/UI.md`, "The system" section

A type scale with a step every 8–13% and the two extremes far apart; two voices (sans for reading,
monospace for data); six radii instead of nine; a layer scale with a name per step; five rules,
including **"components outside the table are zero"**.

Contrast is measured **twice**: on the token pairs (`check-contrast.mjs`) and on **rendered nodes**
(`ui-probe.mjs`). It is not redundancy: the token check passed while four metadata classes sat at
4.28–4.49.

### 4. The three authorization modes — the heart

- `src/web/authorization.mjs`: the sentences in one place, **pure**, tested in Node.
- The mode is **always** in the header, with a tint and glyph for each: normal has no sign, automatic
  is amber, bypass is red and **declares itself** with a strip.
- In the list it is the **row's tint**, not a badge: it is visible from the side.
- Exposure is a **different** axis — a plug, never a mode.
- `bypass` + exposed has its own name, because it is worse than the sum.
- The **"This conversation"** screen: three choices with the consequences written down, exposure
  separate, and what is being accepted.
- The `⋯` menu holds a single door.

### 5. The rest

Two-column home (it was a 280px column inside 1152), project names in normal form (never
uppercase), the status ledger instead of the grid of boxes, and the phone header on two lines (the
title was 234px wide out of 390).

### What "finished" means — and how it went

| criterion | result |
|---|---|
| the browser benches pass, and the new checks cover the flows | **33/33** and **14/14**, with the two permission checks rewritten on the new vocabulary |
| no screen requires more steps than before | changing mode goes from 3 steps to 3, but from "three switches in a menu" to a screen that says what is accepted |
| the three modes are distinguishable without reading a badge | tint + shape + position, and the word is there as **confirmation**, not as the only sign |
| contrast in both themes, targets ≥ 44px, keyboard everywhere | zero nodes below threshold, zero targets below 44px, 149 reachable and **zero without a name** |
| components outside the system are zero | `docs/UI.md`, component table |
| the screenshots in `docs/screenshots/` are redone | `docs/screenshots/m6/prima` and `.../dopo` |

**What did not change**, and was a constraint: no new functionality, no frontend rewrite for its own
sake, **no change to the security model**. The redesign **shows** the boundaries, it does not move
them. `src/web/authorization.mjs` reads the same fields the previous code read.

### The security review, and the lie it found

The diff touches the authorization model, so it went through a review before being considered
closed. **It found something serious**: `acceptEdits` — which, per `docs/SECURITY.md`, auto-approves
reads, file edits and the common filesystem commands inside the project — was read as "normal", so
no sign on the row, "Normal" in the header, and the sentence "every command asks" said to a
conversation that was editing files on its own.

That is **the defect this milestone exists to not have**, written during the milestone, with a test
that encoded it. Now there is a separate state for the modes the interface does not offer and cannot
describe: it declares itself, turns on none of the three, and can be left. Plus three minor defects
and two found by measuring while fixing — details in `CHANGELOG.md`.

It is worth writing down because it is the lesson of the milestone: **the review found what no test
and no screenshot could find**, because the test asserted the wrong thing and the screenshot showed a
state that looked right. A check that passes is not proof that the thing is true; it is proof that
the check and the code agree.

### A deviation, declared

The system was supposed to live in `docs/DESIGN.md`. `DESIGN.md` is, however, the **architecture**
document ("why WRA is built this way"), and a table of CSS components inside it would confuse two
different things. It ended up in `docs/UI.md`, which is the interface document, under "The system".
The point of the milestone — *the system is written and the components outside it are zero* — is
respected.

### And one thing the bench found about benches

`ui-admin-check.mjs` does a **restore**, which rewrites the registry. Run before `ui-check.mjs`, the
latter finds data different from what it expects and fails for reasons unrelated to what it is
testing — verified by reseeding: it turns green. It is an order dependency **of the bench**, not of
the code, and it is written in `docs/UI.md`.

**Fixed in M8.1**: there is no longer a shared registry to reseed by hand. Every bench has its own
(`tools/bench.mjs`), and the order in which they are launched does not matter.

---

## M7 — architectural refactoring — **in progress**

**Why.** `app.js` was 2943 lines, 116 functions and **zero `export`**. The client's success
criterion — "add functionality without touching a huge JavaScript file" — is a problem of
**boundaries**, and boundaries are put in place without changing framework.

**I evaluated and measured React**, not dismissed it on taste: 139 KB raw / 46 KB gzip for React and
ReactDOM, against 76 KB gzip for our entire frontend. The decision, the three reasons and **what
would make me change my mind** are in `docs/AUDIT-M7.md` §5.

### Done

- `core/` pure and testable in Node: `format`, `session-view`, plus the three moved modules.
- `state/` — `api` with the token injected, `socket` which **does not know how to draw**.
- `ui/views/permissions.mjs` — the first extracted view, as a **factory**: it is the model for the
  others.
- `app.js` from **2943 to 2530 lines**.
- **37 new tests** (455 in all), the first that exercise the websocket.
- Performance **measured before and after**: unchanged, flat up to 1000 conversations.

### To do

The remaining views — list, home, chat, terminal, header — are still inside `app.js`. It is
mechanical work with the `views/permissions.mjs` mould, **one at a time, verifying each time**.

**And the lesson, which is worth more than the work done:** the three defects introduced by the
refactoring were all found **by exercising the program**, none by reading it. A forgotten dependency
in a factory is only seen when that factory runs. So: one extraction, one green bench, then continue.

### A note on method, to avoid repeating the mistake

To prove that the refactoring had not changed the appearance I compared the screenshots with those
of M6: 17 out of 20 were different. The control experiment — **two captures of the same code** —
found 11 different, the same ones. The screenshots contain the clock and the live state: a byte
comparison measures elapsed time, not the code. The proof of equivalence is the 34 unchanged checks.

---

## After M6 — the rest, in order

1. **Real ChatGPT**, which depends on a Cloudflare Access rule on `/authorize` (owner's decision,
   `docs/CHATGPT.md`).
2. **Real Android phone**: the 390×844 tests pass, the phone in hand does not (`docs/PHONE.md`).
3. **`Ctrl+C` / `Ctrl+Q` pressed by hand** in Windows Terminal (two minutes).
4. **Import of the remaining historical conversations** (`docs/MIGRATION.md`).
5. **Windows autostart** (optional, `docs/WINDOWS.md`).
6. **Dismissal of the old `claude-remote`**: only after points 1–5 and explicit consent.

### Ideas evaluated and not done (so as not to propose them again without reason)

- **Expiry of the `MCP bypass` consent**: 12 hours, `CR_MCP_BYPASS_TTL_S`. **It is not on `main`** —
  it is on the branch `feature/mcp-bypass-esplicito`, together with the mode it belongs to. On
  `main` exposure to an external client is the `mcpAllowed` switch, and that is it: there is no
  consent that expires because there is no consent to give.
- **Windows job object** for orphan PTYs: requires native code (evaluated in Phase 2B).
- **Compact density** and **PWA install prompt**: proposed in Phase 2, never done; they fit naturally
  into M6.