# Changelog

All notable changes. Dates are when the work landed, versions are the state of the repository
(WRA is not published to a registry: `package.json` is a formality).

## M9 — interface remediation: menus, panel, lists (2026-11-05)

The owner's milestone, after trying the real interface: fix the defects measured by the audit
(`docs/M9-AUDIT.md`), rebuild administration, standardise the components, put projects and
conversations back in order, align the visual identity. Five commits, `main`, no push.

**Defect number one, and it was not `left: 8px`.** Every menu opened detached from its anchor
because it measured itself **before** being positioned: attached to `#menu-layer` — a block as wide
as the page — its measurement was 1440 instead of 230. Now `position: fixed` comes first, and the
geometry comes out of the DOM in `src/web/ui/anchor.mjs`: pure, tested in Node, three rules (inside
the screen, attached to its anchor, flipped only when needed). Measured: controls outside the window
at six widths go from **7 to 0**, finger targets below threshold from **21 to 0**. The "bottom
sheet" on the phone is gone: it was the cure for the symptom, and at 390px the same rule now holds
as at 1440.

**The panel** is five sections, one at a time, with the secondary navigation on the left and fixed;
a single reading column (before there were three measures in the same screen); explanations needed
once behind a "why…"; diagnostics closed in their own section, whose title does say whether there is
anything to look at.

**The 64 test entries** in the registry no longer occupy the projects screen: hidden by default, in
a row at the bottom. The recognition was already there and correct — the default was wrong. Four new
cases keep the **false positives** still, which is the only part of that rule that would be painful
to do twice.

**Reconciliation** between registry and transcript: 13 entries without a file and 183 transcripts
without an entry on the real registry. `src/core/reconcile.mjs` (pure, 8 cases in Node)
deduplicates, does not import what `--resume` would not resume, and deletes nothing; the panel shows
a row-by-row preview, writes a safety copy before touching the registry, and requires confirmation.
The good list is recomputed by the server: the client says *which*, not *what*.

**The identity**: `icon.svg` was still `#2563a8`, the old blue. Now the SVG and the two PNGs come
from a **single drawing** (`tools/make-pwa-icons.mjs`), the stroke is thicker to hold up at 16px,
and three tests in `test/pwa-shell.test.mjs` prevent one from drifting from the other.

**Verified**: `node --test` **491/491** (it was 466); `ui-check.mjs` **38/38** (it was 35) even with
**1000 conversations**; `ui-admin-check.mjs` **18/18** (it was 14) even with 1000; flat performance
(177–293 ms to open from 10 to 1000); contrast in order; `npm audit` 0. The real registry **was not
touched**: SHA-256 of `sessions.json` and `projects.json` identical before and after, modification
dates unchanged — the tests on real data run on a copy in `%TEMP%` with a test token.

**A defect found only on real data**: at 320px, on 30 of 84 rows, the `⋯` button left the row and
was cut off by the card's `overflow: hidden`. The bench did not show it because the seed names are
short. Now there is a check that sets a long name with the same commands a person would use, and
demands it inside the row at four widths — falsified by removing the CSS line.

## M8.1 — closing the verification: ten rounds, and the field that emptied itself (2026-11-05)

`node tools/bench-rounds.mjs 10` on the final code: **ten identical rounds**, `35/35` and `14/14`,
exit `0` every round, stable times (140–141 s for the interface, 43 s for the panel). The real
registry was not touched — SHA-256 of `sessions.json` and `projects.json` identical to before the
rounds, modification dates unchanged — and a whole round starting from a clean bench leaves neither
orphan processes nor test folders. It is the **fourth** round of ten: the first ten out of ten, the
second nine (a real flakiness), the third stopped at four greens at the owner's request.

The fourth was launched with the access check **made stricter** — before it looked for any
`CR_PUBLIC_ORIGIN` in the plan, and passed even when the plan contained **another address** — and
that is where the defect surfaced. The detail of the previous rounds already said it: 9 times out of
10 that check reported `https://pc-ric…` instead of the hostname he had typed.

**The defect was in the product, not the check.** The panel refreshes itself **every five seconds**
(`setInterval` → `admin.refresh()` → `paint()`), and `paint()` rebuilt the fields from the **saved**
value: a half-typed hostname disappeared under your fingers, and "Prepare the commands" or "Apply
the choice" worked on another address. With the node went the **focus** too — the rest of the line
ended up on the document, where keys are shortcuts. It applied to all panel fields: tailnet
hostname, Cloudflare domain, MCP endpoint, projects folder, new allowed root.

Now the panel fields have a **draft** per key, which wins over the saved value, and `paint()` puts
the cursor back where it was. **Two proofs, made before the fix**: the text (four rounds of the panel
bench alone: **4 red out of 4**, "the field lost what I wrote: `pc-example…`") and focus (**red**,
"the redraw took the focus away"). The check, for its part, is stricter than before: the fixed 1.5 s
wait became a wait **for the redraw to have passed** (the field node is marked and we wait for it to
disappear) and the assertion on the plan requires the typed hostname, not any origin — two assertions
added, none removed. `node --test`: **466/466**.

**The security review** of the diff found no vulnerabilities (semgrep `p/javascript` +
`p/security-audit`: zero on both files; the value goes through `node.value` and never through markup;
no token in the DOM; no way to save a value that was not written) and suggested two one-line
hardening changes, applied: `CSS.escape` on the key inside the selector and the guard on non-text
fields before restoring the cursor. The ten-round run was run **twice**, before and after those
hardening changes: ten out of ten both times.

## M8.1 — the bench that does not lie, and the views out of `app.js` (2026-11-04)

**35/35** and **14/14** in a real browser, **466/466** in Node, `app.js` from **2634 to 949 lines**.
No test removed, no assertion weakened, no change to the live server or the real registry — verified
with SHA-256 fingerprints before and after.

### The bench was not a bench

It pointed at a server started by hand, on a registry that the **previous** round had already
modified. Two rounds in a row gave two different numbers. `tools/bench.mjs` builds the world on every
run — throwaway folder, freshly seeded registry, server on an ephemeral port, fake TUI — and takes it
away: shutdown from the shutdown route (closes the PTYs), then the tree, then the folder. No
`~/.cc-remote`, no waits chosen by eye, and the two benches no longer step on each other (each has
its own registry and its own port). `tools/bench-rounds.mjs N` is the proof of repeatability: **ten
rounds in a row, ten times the same** — 35/35 and 14/14, exit 0, and the details that change are
only the pid, the request count and the temporary folder name.

### Every check, alone

`tools/bench-solo.mjs` runs **every check alone**, on a new registry (`--only <name>` in the bench).
A check that passes only because it ran another one before depends on where the previous one left
the page. **Ten out of 49 did not pass alone** — three in the interface and seven in the panel, all
of the same shape. The clearest case: the backup check verified that the process started by the
**previous** check was still on; alone, it verified that it was `null`. They were green in the whole
round anyway: the defect was not that they failed, it was that their success depended on something
they did not say.

### The red that remained, and the diagnosis that was wrong

"a section groups" was not failing because of grouping: **opening a conversation starts its
process**, and a running conversation is drawn in the "Now" tab, which has no sections. And the
diagnosis stayed wrong for a whole round because of a defect in the check: the step that removes the
star was an `if` that, when the item was not there, continued **silently**. Now the item is compared
with what the registry says, the process is turned off from the menu item and it is required to be
off, and the check reads the drawn groups and asserts the real rule — the star **moves**, it does not
duplicate. The production logic was not touched.

### The views

Nine factories in `src/web/ui/views/`, one per responsibility: `shell`, `list`, `chat`, `selection`,
`terminal`, `projects`, `activity`, plus `permissions` and `admin` from previous years. The boundaries
are not declarations: selection knows nothing about filters, the list does not know what happens when
you tick, chat does not know how a conversation is chosen or how it is authorised.

### The real defect, found by the suite

`test/attach-lifecycle.test.mjs` fixed the **path** of `app.js` instead of the promise it claimed to
test ("the browser tab uses the shared definition, not a copy of its own"), and with the terminal
moved it fell for an unrelated fact. Now it walks all of `src/web/` — `.js` included — and requires
that whoever names `TERMINAL_RESET` imports it and that nobody writes a hand-made copy of the
sequences. Two falsifications, both fall.

### Performance, and a thing that is no longer true

Measured on the page shell: open **115 ms** with 10 conversations, **229 ms** with 1000, **370 ms**
with 2000. Search is flat (13–33 ms). **The curve is not flat**, and the M6 measurement ("flat up to
2000, 109–121 ms") was made on the column shell, where the list was a box and not a whole page: it is
not comparable. The page draws all rows, so it grows with the registry — and at the real volume (84
conversations) it opens in ~115 ms. I did not virtualise: it was not requested, and the measurement
says it is not needed yet.

### And on the second round of ten, a red: a fixed wait

The first round of ten passed ten out of ten. The **second** did **nine out of ten**, with a single
red in the panel — "the file does not have the chosen folder". It was not the product: the check
waited **fixed times** (700 ms for the confirmation dialog, 1,500 for the write) and under load the
write had not arrived yet. It is the same defect the benches had already learned elsewhere. Now it
waits for what must appear, and the `waitFor` helper moved up into `tools/cdp.mjs`, where shared
things live: it was inside `ui-check.mjs`, and the panel did not have it.

## M8.1 — closing the round: checks turn green (2026-11-04)

Eleven reds between the two benches. Now **34/35** and **14/14**, on a freshly seeded registry. No
assert removed, no check deleted: every red reproduced in the browser, and for each one the decision
whether the defect was in the product or the check.

### Seven real defects, and the first explains half of the others

- **`.session` had no CSS rule**: the conversation drew itself by accident, and with an empty chat
  the writing field measured **0x0**. You did not see it by looking: you saw it by writing in it.
- **The toast ate clicks**: it sits 24px from the bottom with `z-index: 60`, the action bar 16px with
  `z-index: 40` — that is, under and over. For five seconds after a bulk action the bar's buttons did
  not respond, and the only trace was a dialog that did not open.
- **The list row did not update the remote-exposure sign.**
- **`/` and `Ctrl+K` threw you out of the conversation**, and with it focus from the writing field.
- **The `/` key was dead** with the Terminal tab remembered but closed.
- **Phone targets**: the search button at 32px, the dialog buttons at 36px.
- **A project's filter survived page changes**, with nothing saying so.

Plus four **check** defects — all of the same family: a check that stands on where the previous one
left the page. And two races removed by waiting for **what must appear** instead of a fixed time.

### One red remains

"a section groups": a **pinned** conversation that also has a label does not show its label's group,
because `groupSessions` puts favourites under "pinned". It is **intended and tested** behaviour
(`test/ordering.test.mjs:61`), so the defect is in the check — the step that removes the star is
conditional on an item being present in the menu and **skips silently** if it is not. The
reproduction and the next step are in `docs/M81-APERTO.md`.

### And two things that were not done

**The view extraction (PHASE C) was not started**: `app.js` is at 2634 lines. The bench is not green,
and extracting with an open red means being unable to distinguish a new failure from an old one.
**The full regression (PHASE B) is partial**: mobile at 320 and 768, offline PWA and the 1000-
conversation round are missing.

### The bench is not idempotent — the thing to know first

`ui-check` modifies the registry it runs on: a second round in a row starts from different data and
fails on **different** checks. Before every round it is reseeded with `tools/seed-demo.mjs`. The real
solution is to make the bench reseed itself: it is the first job of the next round.

## M8.1 — the browser checks run again (2026-11-04, same day)

The 34 browser checks of M6/M7 pointed at the column list and since M8 no longer ran: the product had
no safety net on behaviours. This round puts it back — **35 checks**, of which **27 pass** — and so
finds five real defects, none by reading the code.

### Found and fixed

- **The search field lost focus on every keystroke.** It was rebuilt on every redraw: you typed one
  letter and the second went into the void. The field is the only node on the page with a state of
  its own — where the cursor is — and that state is not rebuilt.
- **The "When" button moved between mouse press and release**: the counter next to it changes text,
  the group realigns by a few pixels, and the click landed in the void.
- **The star no longer reordered anything.** With the list grouped by project it meant "ahead of the
  others in its project"; with the flat list it stayed on without moving.
- **Sections were no longer visible**: you could still give a label and it appeared nowhere. Lost
  moving from the column list to the page.
- **Phone targets at 36px**: the header items are navigation and were below the touch minimum.
- **The open conversation's row** was no longer marked and no longer said the authorization mode —
  which is the thing that row exists to say.

### Changed

- The checks that tested commands that no longer exist were **rewritten** on what those commands
  did, not translated: list, project, draggable width, open/close all projects, home, "only the open
  project".
- **New checks** that the page shell makes necessary: the four sections with their title and their
  number, a project row that opens its conversations, the ⋯ menu identical from every page, the page
  surviving refresh, no horizontal scrolling at 5 widths × 3 pages, filters combining.
- The search check now types **letter by letter**, as a person would.

### Not finished — in `docs/M81-APERTO.md`

**Eight checks out of 35 remain red**, each with its diagnosis. And the **view refactoring was not
started**: `app.js` is at 2490 lines. The right order is the eight reds first, then the extraction —
extracting without a green bench means not knowing whether what breaks is new or was already broken.

## M8 — the FreeLLMAPI language, and the entries the tests had left behind (2026-11-04)

Three things, independent of one another: the **visual language** taken from FreeLLMAPI, the **shell**
moving from a side column to four pages, and the **registry cleanup** of the entries written by the
tests.

### Changed

- **The token layer, and only that, for the rest.** The palette was tinted blue with a blue accent:
  two things that together made every screen look like a variant of a technical panel. Now it is
  FreeLLMAPI's neutral — **black** as the only strong accent, blue remaining only for links and for
  remote exposure, which are something other than an action. Changing the values moved the whole
  application without touching a component rule: that is why the token layer exists, and the 34
  checks in a real browser passed unchanged.
- **Geist and Geist Mono**, 52 KB, served from this machine and put in the service worker shell: no
  CDN, so the page opens identically from the phone without a network too.
- **The shell**: a header at the top with four sections — Conversations, Projects, Activity,
  Administration — and below **one page at a time** at full width. The list is no longer a 296px
  column: it is the conversations page, with search, a segmented filter and the rows in a card with a
  thin border. The number next to each section is data and is visible from outside.
- **`src/web/core/registry-hygiene.mjs`** — which registry entries the tests wrote, with the proofs.
  It is pure and tested in Node.
- **The registry cleanup**, in three steps: preview with the real paths, confirmation saying what
  happens, and a copy written before touching the file. On the projects page, plus the filter that
  hides them without removing anything.

### Removed

- The drawer, the draggable list width, the column compression, the "sort and filter" menu with
  opening and closing all projects: they existed for the previous shape. The functions remain —
  filters are the segments, "when" is next to them, multi-select is a floating bar instead of sitting
  at the bottom of a column that no longer exists.
- The colour table inside `tools/check-contrast.mjs`: it was a hand-written **copy** of the tokens,
  and it had already gone out of sync once. Now it reads `app.css`.

### The test entries, in one number

The owner's registry had **64 project entries** that nobody had created by hand:
`test/e2e.stub.test.mjs` wrote them into `~/.cc-remote/projects.json` because of the configuration
defect closed in M7. **They are not conversations**: the real registry, 84 entries, does not have a
single test one — 71 imported, 12 created by the application. They were 64 ghost projects, all
without a name, all without a conversation, all in temporary folders.

The rule does not use the name: two independent proofs, including the one from the code
(`cc-remote-e2e-`, `progetto-auto-`, two strings that appear **only** in the test file, and a test
scans for them in `src/`). And a condition, not a proof: **zero conversations** — a temporary folder
with work inside is not declared a test one because of its name.

### Verified

466 Node tests (it was 459), the four pages in real Chrome, a conversation opening and closing, 0
horizontal scrolling at 320/390/768/1024/1440, clean console. The cleanup tried on the isolated
registry: 26 entries → 2 forgotten → 24 left, the backup has 26, the 520 conversations intact.

## M7 — architectural refactoring (2026-11-04)

`app.js` was 2943 lines, 116 functions and **zero `export`**: there was no way to import a function
from inside it, so every new feature went through that file. The client asked to be able to add code
without touching "a huge JavaScript file": it is a problem of **boundaries**, and boundaries are put
in place without changing framework.

I evaluated React, TypeScript, Vite and shadcn — and **measured them**: `react.production.min.js`
10.5 KB plus `react-dom.production.min.js` 128.7 KB, that is **139 KB raw and 46 KB gzip** against
the 76 KB gzip of our entire frontend. The decision is documented in `docs/AUDIT-M7.md` §5, with the
three reasons and with **what would make me change my mind**.

### Added

- **`src/web/core/`** — pure, tested in Node: `ordering`, `markdown`, `authorization` (moved), plus
  `format.mjs` (time, counts, states) and **`session-view.mjs`**.
- **`src/web/state/`** — `api.mjs` (the routes, with the token injected and `fetch` as a parameter)
  and `socket.mjs` (opening, retries, callbacks). **The websocket does not know how to draw**:
  before, `connect()` called `setConn`, `renderBanner`, `showGate` and touched the gate.
- **`src/web/ui/`** — `dom`, `icons`, `terminal-reset` (moved) and `views/permissions.mjs`.
- **37 new tests** (455 in all): 22 on `session-view`, 13 on transport, 2 regression. They are the
  first tests in this project that exercise the websocket — with a fake socket and a fake timer,
  without a browser.

### Changed

- **`renderProjects`** no longer derives anything: it asks `visibleProjects` — pure, tested — and
  draws what comes back. It was 75 lines in which filtering, grouping, sorting and building DOM nodes
  were done together, reading `state` from outside.
- **`src/web/ui/views/permissions.mjs`**: the "this conversation" screen was 320 lines inside
  `app.js`. Now it is a **factory** that receives what it needs and returns its functions. It is the
  model for the other views.
- **`app.js` goes from 2943 to 2530 lines**, and the pure functions it contained are 246 lines that
  now live in modules with a name.

### Performance, measured before and after

| conversations | open (before) | open (after) | search (after) |
|---|---|---|---|
| 10 | 121 ms | 118 ms | 27 ms |
| 100 | 121 ms | 118 ms | 35 ms |
| 500 | 120 ms | 120 ms | 33 ms |
| 1000 | — | **122 ms** | 32 ms |

**Unchanged, and flat.** The refactoring cost nothing and bought nothing in speed: it was not
needed, and that is not what it was done for.

### Verified

**455 tests** in Node (it was 420), **34/34** and **14/14** in a real browser with real clicks. Zero
horizontal scrolling at 320 / 390 / 768 / 1024 / 1440 **and horizontally** (844×390), zero checks
without an accessible name, and finger targets at zero below 44px under 60rem.

**A note on method, because it is worth more than the verification.** I wanted to prove that the
refactoring had not changed the appearance by comparing screenshots with those of M6: 17 out of 20
came out different. Before writing it down I did the control experiment — **two captures of the same
code** — and there too 11 out of 20 were different, the same ones. The screenshots contain the clock
("1 min", "2 h") and the live state of conversations: a byte comparison does not measure the code, it
measures elapsed time. The proof of equivalence is the **34 unchanged checks**, not the pixels.

### What the refactoring broke, and who found it

Three real defects, all introduced by me and all found **by exercising the program**, not by reading
it:

1. The websocket `protocols` was read **at module construction**, that is, before the token existed:
   the first connection started with an empty `bearer.` and the server answered "no valid
   credentials". 16 of 34 checks red. No unit test would have seen it: the module was correct, what
   was wrong was *when* it was called.
2. `projectOf` uses `projectKeyOf`, which I had not passed to the factory: `ReferenceError`, and the
   list no longer drew. It is a **forgotten dependency**: it is seen only by exercising.
3. The header marker's listener had been left behind during the extraction.

And one was found by an unrelated test: `test/attach-lifecycle.test.mjs` asserted the **paths** of
the files in the source — a check that fixes where a file happens to sit does not test the thing it
promises, it tests that nobody moved it. Rewritten to verify that the two imports point to the
**same** shared definition.

### What remains to be done

The refactoring is **started and real**, not finished. `app.js` is 2530 lines: the boundaries are
there and the model is written, but the remaining views — list, home, chat, terminal, header — are
still inside. Extracting them is mechanical work with the same mould as `permissions.mjs`, and must
be done one at a time **verifying each time**, because every extraction can forget a dependency and
the only way to notice is to exercise the program.

I did not do it all in this milestone on purpose: a hurried extraction on 2500 lines is how you break
an interface that works, and this repository exists to control the machine the agent runs on. The
part that matters — **the boundaries and the model** — is there and is tested.

## The M6 security review: one lie, and three other things (2026-11-03)

The M6 diff touches the authorization model, so it went through a review before being considered
closed. It found **one serious thing** and three minor ones. The serious one is the most important of
all the work: it was exactly the defect the milestone exists to not have.

### Fixed

- **`acceptEdits` was painted as "Normal".** `permissionMode` accepts a closed list that the
  interface does not offer — `acceptEdits`, `plan`, `auto`, `dontAsk` — and the first version read
  everything that was not bypass or automatic as "normal". But `docs/SECURITY.md` documents that
  `acceptEdits` **auto-approves** reads, file edits and the common filesystem commands (`mkdir`,
  `touch`, `mv`, `cp`) inside the project folder. So the row carried no sign, the header said
  "Normal", and the screen said "every command and every edit goes through a request you approve" to
  a conversation that was editing files on its own. The worst case shown as the least alarming of
  all.
  Now there is a separate state: the mode's name, amber tint with the warning, a strip saying what we
  know and what we do not, and **none of the three radios on**. For the modes we do not know, the
  answer is "I don't know", not a guess.
  The test **encoded** the defect (`acceptEdits → 'normal'`), with the right intention and the wrong
  conclusion: "it must not become bypass by accident" was true, but the chosen way out was the one
  that lies. Rewritten the other way round, and the bench has a new check that holds it: falsified by
  putting the defect back, it falls with the same symptom.
- **You could not leave `acceptEdits`.** Clicking "Normal" exited immediately with "it is already the
  one you chose", because the mode was read as "normal". And `setMode('auto')` did not reset
  `permissions` to `default`, so it stacked the automatic one on top of `acceptEdits` without
  removing it. Now `permissions {mode:'default'}` is sent **always** when the target is not bypass.
- **The exposure button did the opposite of what was written.** The label came from the effective
  state (`reach.on`) and the action from the written switch (`mcpAllowed`): with an expired consent
  the button said "give consent again" and called `setReach(false)` — that is, it revoked, **without
  even the confirmation dialog**, and deleted the consent date. The first click did the opposite of
  its label. Now the label and the action come from the same source, and the click **grants**: you
  can tell because the confirmation appears with the name to type.
- **The order of calls went through a worse state than the one requested.** Towards "Normal" the
  mode was sent first and then the automatic mode switched off: in between, the conversation was
  `default` and therefore **inherited** the project's automatic mode — you had asked for the
  narrower mode and for an instant had a wider one. Now the order depends on the target, and it is
  written down why.
- **A failed mode change left the panel showing the target.** The radio was marked on click and the
  `catch` exited without rereading: the screen said "Bypass" to a conversation that had stayed
  normal. Now it rereads and redraws, and you see how it went.
- **`POST /local/sessions` accepted any `permissionMode`.** `setPermissionMode` checked the closed
  list and `create` did not, so the creation route passed any string to
  `claude --permission-mode`. It was the widest door through which a mode the interface cannot
  describe could enter. Now the same list applies in both places.
- **Amber as text sat at 3.53:1.** `--warn` is calibrated to be a **sign** (a dot is visible even at
  3:1), and the mode's sign is an **11px word**. Added `--warn-ink`, and the distinction is written
  in `docs/UI.md`: a sign colour and a text colour are two jobs and two tokens. The contrast check
  now also measures the new pair — and the two values of `--muted` and `--faint` that had been left
  behind in the tool's table.
- **The permissions screen did not close with Escape**, unlike the panel: Escape closes what is open,
  and this is a screen like the others.
- **"Consent has expired" said to an archived conversation.** Right direction, wrong reason — and a
  screen that gets the reasons wrong stops being believed. Now they are two messages.

### Verified

The serious defect was falsified: putting the old reading back, the new check falls with the same
original symptom (`the header does not say it is an undescribed mode: normal`). The exposure button
was tested end-to-end on the case that broke it — bypass with expired consent — and now the click
**grants** instead of revoking.

**429/429** tests in Node, **34/34** and **14/14** in a real browser, contrast at zero nodes below
threshold in both themes, zero targets below 44px, zero elements without an accessible name.

### What the review confirmed as sound

No server-side verification was weakened: the client's three confirmations (the bypass dialog, the
name to type, the local-origin rule) are all **also** on the server, and a client that skips the
dialog is refused. The reading of `autoApprove` matches the server policy in every case tried —
`true`, `false`, `null`, absent, and even a wrong type — and where it differs the interface is
**more** alarming, not less. And exposure to an external client is not something the browser can
decide by itself: what you see is what the server says, and the server recomputes it on every read.

## M6 — the interface redesign (2026-11-03)

The interface worked and was not understandable. With 520 conversations in 24 projects the bench
said it *held up*, not that it read well — and the owner described it for what it was: "an
experimental technical panel". This is the round that remakes it, and the part that matters is not
the look: it is that **what the agent can do** stops being a word you have to know.

No new functionality, no frontend rewrite for its own sake, and **no change to the security model**:
the redesign *shows* the boundaries, it does not move them.

### The audit, with numbers (`docs/AUDIT-M6.md`)

Nine defects, each with its measurement. The three that matter:

- **Everything at 11px.** 88 text nodes out of 118, that is, the whole interface — project names,
  conversation names, counts, dates, state — at the same size. Visual hierarchy is what tells the
  eye what is important before it is read; here there was none, so the eye had to read everything.
  "Technical and quiet" had been realised as "small and grey".
- **Four names for three axes.** `bypass`, `MCP`, `auto (here)`, `auto (project)`: four 11px badges to
  say what the agent can do *and* who can talk to it, which are two different things. `bypass` does
  not say what happens; `MCP` does not say it is an exposure.
- **The conversation menu.** Eleven items and four jobs — organise, **authorise**, keep alive,
  destroy — and the three that change the security model at the same height as "copy the id".

And one thing that is **not** needed: performance is flat up to 2000 conversations (109–121 ms to
open, 30–46 ms to search). No virtualisation, no pagination, nothing at all.

### Added

- **`PRODUCT.md`**: the direction, the users (at the PC, from the phone, and those who do not know
  Claude Code) and the anti-references — starting from the previous interface.
- **`src/web/authorization.mjs`**: the three authorization modes and the two axes, as **pure
  functions**. `modeOf`, `authorizationOf`, `reachOf`, `stateOf`. The sentences explaining the modes
  live here and not inside a `render`, because `docs/SECURITY.md` is the source and two screens
  cannot say it in two ways.
- **The "This conversation" screen**: the three modes as real choices, each with **what it entails**
  written under the label, bypass with **what is being accepted**, and exposure separate with its
  switch. It opens from the header marker or from `⋯ → Permissions and access…`, and it lives in the
  address (`#c=<id>&permissions`).
- **The mode marker in the header**, always in the same place: normal has no sign, automatic is
  amber, bypass is red and **declares itself** with a strip carrying the sentence in full. The strip
  appears only for states that must be seen.
- **`tools/ui-shots.mjs`**, **`tools/ui-probe.mjs`**, **`tools/ui-perf.mjs`**: the always-identical
  screenshots for before/after, the measurement (type scale, contrast on rendered nodes, targets,
  keyboard), and the times at 10/100/500/2000 conversations.

### Changed

- **The type scale** has a step every 8–13% and the two extremes far apart: 11 / 12 / 13 / 14 / 15 /
  17 / 20 / 24. 11px remains for status labels and counters, and that is it.
- **Two voices**: sans for everything that is read, **monospace for the data** — counts, dates, ids,
  paths, and the names of the modes. The product *is* a terminal; it does not have to look like one.
- **In the list the state is the row's tint**, not a badge: it is visible from the side while
  scrolling, which is what you need with five hundred rows. Colour is not the only sign — the word is
  there too — because colour blindness exists and red/amber is the pair that is lost first.
- **`bypass` + exposed to an external client has its own name** (`bypass + exposed`): it is not the
  sum of the other two, it is worse, and it is seen as one thing.
- **Exposure to ChatGPT has a different shape** from the modes — a plug, in accent: it is the other
  axis, and whoever looks must not be able to confuse them.
- **The home is two columns**: what is happening on the left, where things are on the right. It was a
  280px column inside 1152, with three quarters of the screen empty around it. Titles are titles.
- **Project names are no longer uppercase**: on twenty-four entries uppercase is a shout and removes
  the shape of the words.
- **The status ledger instead of the grid of boxes**: one row per fact, with the value in monospace
  and **what it means** next to it. "1 processes on" was ungrammatical by construction. And the two
  numbers that matter for security — with permissions skipped, exposed to an external client — stop
  being at the bottom of a throwaway sentence.
- **The phone header goes on two lines**: on one it kept the title at 234px out of 390 (`migra…`)
  while next to it sat the list button, the mode, the star, the two tabs and the menu.
- **The search field is 44px high** on the phone too: it was the only target left below threshold.

### Fixed

- **Four metadata classes below the contrast threshold**, and the check that did not see them: the
  ratio was measured on **token** pairs, and the real colour depends on **what is underneath**. They
  were on `--raised` (4.28–4.49), and the pair being measured was the one on `--surface`. Now
  `ui-probe.mjs` reads the colours **rendered by the browser** — going through the canvas, because
  the browser returns `oklch(…)` and not RGB — and climbs back to the painted background behind every
  node. Zero nodes below threshold in both themes.
- **The time at the bottom of the row wrapped**: two new elements in the row had taken away its width
  and `.meta` had no `flex: none`. The row went from 38 to 51px. Found by measuring.
- **The home grid shrank to its content**: `#home-body` is already a `.home-body`, and nesting a
  second one made it 505 wide instead of 1024 — in flexbox a `margin: auto` on the cross axis cancels
  stretching. Invisible in the source, obvious by measuring.
- **`modeOf` treated `autoApprove: false` as `null`**: in the registry they are two different things
  — `null` means "I have not decided" and the project applies, `false` means "not here" and wins — so
  a conversation could not opt out of its folder's automatic mode. Found by writing the tests.
- **`authorization.mjs` was missing from the service worker shell**: without a network the
  application would not have opened. Found by the PWA shell check.

### Verified

**424/424** tests in Node (it was 409: 15 new, 14 of them on `authorization.mjs`), **33/33** and
**14/14** in a real browser with real mouse clicks, contrast at zero nodes below threshold in both
themes, zero targets below 44px, 149 keyboard-reachable elements and zero without a name.

The two permission checks were **rewritten** on the new vocabulary, not loosened — and one of the two
now asserts that the three permission items did **not** return to the `⋯` menu. The new regressions
were falsified: putting the row back without the tint, or removing the name from the worst case, the
checks **fall**.

Token, DNS, Cloudflare Access, tunnel and the live server **not touched**. No push.

## Long turns are no longer lost (2026-11-03)

Two lost turns, with the evidence in the journal: `state: "timeout"`, `reply: null`, `error: null`,
at **exactly 600 seconds**. The agent had worked — it had made the commits — but the answer no
longer existed anywhere, and what the client read was "Error: null".

The cause was not time: it was the **lifecycle**. `maxWaitMs` was treated as "how long a turn can
last", while it was only "how long we watch the transcript before giving up". At expiry the turn was
closed in state `timeout` — terminal — and from then on nobody read anything: the agent kept going,
the answer went into the transcript, and there was no way to recover it. The journal fixed it even
more permanently, because the same `request_id` returned that empty answer.

### Fixed

- **The listening window renews, the turn does not.** `runTurn` accepts a `resume` and resumes
  reading **from the same point** (`TailingReader.resumeOffset`), without resending the message:
  resending it would be a second prompt in the same conversation, that is, the damage idempotence
  exists to prevent. The coordinator stays in `running` while the agent works.
- **The real ceiling is separate and declared** (`CR_TURN_HARD_MS`, 4 hours): when it arrives, the
  turn closes in `timeout` **with the partial and with a reason**. Never again `error: null`.
- **An agent that finishes and exits does not lose the answer**: the transcript is read **before**
  declaring the process dead, and if the end of the turn has already been seen (`end_turn`), the
  death is not news.
- **The result can be recovered without `turnId` too**: `get_turn_status` with no arguments returns
  the last turn of the chosen chat (only for a chat the client already has `mcpAllowed` for).
- **The journal also keeps the partial** of an unsuccessful turn (capped at 4 000 characters), and
  gains `latestFor(sessionId)`: it is the answer that survives a server restart.
- **A line that arrives halfway is not lost**: the resume restarts from the beginning of the
  incomplete line, not from the middle. And if the transcript **shortens** under the turn (truncated,
  replaced, an id reused), it does not resume from a point that no longer exists: the turn closes
  saying so, instead of rereading from the start and duplicating the answer.
- **A line cut inside a multi-byte character is not lost** (found following a reviewer's suspicion,
  and confirmed with a probe in a minute). The count was made on the bytes *read*, but `TextDecoder`
  with `stream: true` holds up to three bytes aside when a UTF-8 sequence falls across two reads:
  `resumeOffset` restarted **inside** the line, `JSON.parse` failed, and a piece of the answer
  disappeared silently. Now the bytes **emitted** are counted.
- **`wait_seconds` no longer leads to a 524**: the ceiling goes from 300 to **90** seconds by default
  (`CR_MAX_WAIT_S`), below Cloudflare's ~100 second cut. The zod schema accepts up to 600 and the
  value is **clamped**, not refused: a refusal would leave the client with nothing to read.
- **Diagnostics measure idleness, not age** (`CR_TURN_STALL_MS`, 15 minutes): a long turn is not a
  suspect; a turn that has produced nothing for a while is.
- **Dead code removed**: `src/mcp/tools/talk.mjs` (nobody imported it, and it was the old version
  with the same "Error: null" defect).

### Verified

- `test/turn-lifecycle.test.mjs` (12 cases): resuming from the same point, the message sent **only
  once**, the agent exiting after answering, the queue not being skipped, the client disconnecting,
  recovery without `turnId`, the ceiling with the partial, the journal, the line split across two
  writes, the shortening transcript, the line cut inside a multi-byte character. **Falsified**:
  putting the old behaviour back, the two live-server cases fall.
- `test/long-turn-live.test.mjs` (3 cases, **real server + real PTY + real transcript**): listening
  window at 900 ms and answer at 2 500 ms. The HTTP call receives the **final answer** with
  `watches >= 2`; and if the connection drops halfway, the turn reaches the end anyway and the
  answer is found in the journal; two conversations in parallel do not wait for each other.
- `test/mcp-tools.test.mjs` (+3): the expired turn no longer says "null", the state is recovered
  without an id, a wait longer than the ceiling is shortened.
- Full suite: **397/397**. `npm audit`: 0 vulnerabilities. Contrast: passes.
- Full OAuth + MCP round on the **real public host** (`tools/smoke-public-host.mjs`): **all checks
  pass**, the four tools answer.
- Interface and panel in a real browser: **32/32** and **14/14** (520 conversations, 24 projects).

### Not solved, and outside the code

The OAuth round through the **public** address stops at `/authorize`: Cloudflare Access answers 302
to its login. The code is in order (the same sequence, with the tunnel's `Host` header, passes all of
it); the Access rule on `/authorize` is missing — which is a decision for whoever uses the machine,
and the brief says not to touch it. Details and commands: `docs/CHATGPT.md`.

## "Controlled automatic mode" (2026-11-03)

A new feature, and a new boundary to hold. The problem: making ChatGPT work inside a project via MCP
costs one human approval per file edit, and an approval clicked forty times a day is an approval you
stop reading.

The answer is not "skip permissions" (which remains what it was: a conversation in bypass is not
exposed to ChatGPT, and the rule is not touched) nor a filter on commands, which is bypassed with a
`;`. The answer is a policy that grants **only what it can verify**.

### Added

- **`src/host/auto-policy.mjs`**: it auto-grants only `Read`/`Edit`/`Write`/`MultiEdit`/
  `NotebookEdit` when the path resolves **inside the conversation's project**, no component below
  the root is a link, and the destination is not in a reserved place (`.claude/`, `.git/`,
  `.mcp.json`, `.env*`, `id_rsa*`, `*.pem`, …). Always no: commands (`Bash`), patterns
  (`Glob`/`Grep`), the network, and anything outside the project. Every doubt ends in "I do not
  decide", that is, in the usual dialog.
- **The switch**, off from the start: per conversation (`POST /local/sessions/:id/auto`) or per
  project (`POST /local/projects/update {autoApprove}`), from the interface's ⋯ menu. The
  conversation wins over the project; the list shows the `auto (here)` / `auto (project)` badge.
- **Revocation is server-side**: the policy rereads the registry and metadata on **every** request,
  so turning it off takes effect on the next request — no restart, no cache. The registry refuses
  the two dangerous combinations: turning the automatic mode on for a bypass chat, and putting a
  chat with the automatic mode on into bypass (in bypass the hook does not run: the policy would
  decide nothing and the person would believe they had a boundary).
- **Transparency**: every automatic grant goes into the log, reaches the browser of whoever is
  watching that conversation (`approval_auto`), and stays in a short list (`autoApprovals` on
  `/local/sessions` and on `/healthz`).
- **`src/core/paths.mjs`**: `linkInPath` (it was inside the registry) and `isInside`, which compares
  path components and not string prefixes — `…/project-2` is not inside `…/project`.

### Verified

- `test/auto-policy.test.mjs` (9 cases: inside, outside, the misleading prefix, link, reserved,
  commands, revocation).
- `test/approvals.test.mjs` (+6): the policy that grants, the one that stays silent, the one that
  **breaks** (costs a question, not a permission), revocation on the next request, the relay off.
- `test/registry.test.mjs` (+3): off from the start, incompatibility with bypass in both directions,
  survival across restart.
- `test/e2e.stub.test.mjs` (+2): from the site to the hook's answer — on it grants inside the
  project, outside it does not, commands do not, `.env` does not, and revocation applies immediately;
  the project turns the folder on, the conversation that says "off" stays off.
- `test/workspace.test.mjs` (+1): the project switch reaches the interface, and is born off.
- Full suite: 380 tests, 0 failed.

### Fixed (same day, by trying instead of reasoning)

- **A file's name is not the path.** On Windows `.env::$DATA` is the *main* content of `.env`
  (verified by writing), and the short alias `ENV~1` — which `cmd /c dir /x` shows next to `.env` —
  leads to the same file: two ways to write `.env`, `id_rsa` or `credentials.json` without going
  through the check. Now the stream is cut and trailing spaces and dots are removed before comparing
  the name, and a component that looks like an 8.3 alias is not resolved: it **asks**. The price is
  that a file genuinely called `a~1` asks too. `test/auto-policy.test.mjs` covers all three cases,
  and the suite went to 382/382.

### Documented

- `docs/SECURITY.md`: the "Controlled automatic mode" section, with what it grants, what it never
  grants, fail-closed, revocation and the remaining limits.
- **The `PermissionRequest` hook was verified by execution** (not only read): with a hook that
  answers `allow` the file is written without asking; with a hook that answers `deny` the tool is
  blocked and the reason reaches the model; a hook that produces no decision leaves the tool blocked.
  It is the assumption the whole relay rests on.

## Phase 3 — live-server acceptance, and the PWA shell made whole again (2026-11-02)

No new function: verifications on the server actually used, one defect found and closed, and the
documentation for publishing. The active configuration (token, tunnel, DNS, Tailscale, Cloudflare)
**was not touched**.

### Fixed

- **The PWA shell was incomplete.** The service worker caches a hand-written list of files:
  `/ordering.mjs`, `/terminal-reset.mjs` and `/admin.mjs` were not there. Online you do not notice
  (those modules arrive from the network), but on the **first offline open** the missing modules
  answer 504 and the page stays blank. Added, `VERSION` to `cc-remote-v2`, icons included. Test:
  `test/pwa-shell.test.mjs` — every file in the shell must exist, and every module `app.js` imports
  must be in the shell. Verified by removing an entry: the test fails, and turns green when you put
  it back.
- **`docs/PHONE.md` said that `CR_PUBLIC_ORIGIN` accepts a single address.** It accepts several
  separated by `;` (since Phase 1): the line had been left behind, and it is the line that explains
  why the websocket refuses a badly declared origin.
- **`README.md`**: installation now says `npm link` (without it, `wra` does not exist and the
  commands in the "Use" section do not work from a fresh clone), and the browser benches are 32 + 14
  as they are now, not 20.

### Added

- `docs/RELEASE.md` — the publishing checklist: what is verified and with which command, what is
  not, the three decisions to take before the first push (work diary, licence, repo name), and what
  must be configured by hand outside the repo.

## Phase 2B — admin panel, guided access, backups and processes (2026-11-02)

An application inside the application: install, configure, check and maintain WRA without going
through the terminal. `src/net/admin.mjs` (the routes), `src/web/admin.mjs` (the panel).

### Added

- **Status**: server and project version, conversations by state, the **processes actually managed**
  with their pid, projects, MCP bridge, connected windows, the diagnostic checks (with "recheck
  everything" adding the slow ones — `claude` version, installed tools, a write test in the state
  folder — and the log tail), where every file lives, and restart.
- **Access from outside, guided**: three choices (local only, Tailscale, Cloudflare Tunnel) and both
  modes together. For each: whether the tool is installed, the service status, the prerequisites,
  the **plan** with the exact commands *before* the button, application with confirmation,
  `tailscale serve` run only on explicit request, and removal that does not touch the conversations.
- **Access verification**, which is the part that answers "do not consider a tunnel safe just
  because it answers 200": for each address it asks `/`, the person's APIs without a token and
  `/mcp`; it says whether Cloudflare Access is in front, whether our gate is there, or whether
  **there is nobody** — and in that case it says so with the words "do not consider it protected".
- **Backups from the panel**: create one, list them, verify the fingerprint, preview the restore (by
  name: which conversations come back and which leave), restore with confirmation saying how many
  transcripts are not touched, and download.
- **Processes**: four groups — managed, **left after a forced shutdown**, opened by another window,
  rows to remove. Closing requires recognising the process; if it cannot be verified, it is not
  closed and it says so.
- **Settings**: projects folder and allowed roots, validated one by one.
- **First start**: with an empty registry, Status becomes a list of steps to do from the panel.
- `wra restart`, `wra admin`. The access choice and the settings apply at the next start, and the
  panel says so instead of pretending they are already active.

### Fixed

- **The Terminal tab could open empty** on a conversation that had already written, and filled only
  on the first keypress. xterm writes to the buffer even when hidden but does not paint it, and
  `fit()` is not enough if the measurement does not change: now there is `term.refresh()`. It had
  always been there, and was only visible with an agent that writes little.
- Compressing the list with the panel open left the home visible underneath (two rules for the same
  thing, in two places): now `renderChrome` decides, in one place.

### Security

Four rules on every admin route — token, origin, confirmation that repeats the object, no commands
from the browser — and a dedicated review of the diff: see `docs/SECURITY.md` and
`docs/OPERATIONS.md`.

## Phase 2A — daily use: home, bulk actions, navigation (2026-11-02)

No new route, no new data: **everything needed was already there** (`/local/sessions`,
`/local/projects/*`, search, filters). This phase is how you get to those things with ten, a hundred
or five hundred conversations.

### Added

- **The home.** Opening the application with no conversation open there is no longer a generic
  invitation: there is **now** (the conversations with a live process), **recent** (the last eight)
  and **projects** (with star, count and the "+" to open one there). At first start, with an empty
  registry, there are instead the three things to know: what WRA is, that the agent runs on this PC,
  and the only action to take. Outside the home the writing field is not visible, since it would
  have no conversation to write to.
- **The open conversation lives in the address** (`#c=<id>`): refreshing the page — or an accidental
  `Ctrl+R` on a phone — brings you back where you were, instead of to the home. The brand at the top
  of the list returns to the full list.
- **The list compresses** with the header button (the same one that opens the drawer on a phone), and
  the choice is remembered.
- **Multi-select**: the "sort and filter" menu turns the mode on, every row has its checkbox, every
  project has its own ("all of this folder's"), and at the bottom the action bar appears —
  archive/resume, pin, section — with **the number of conversations it takes**. Archiving asks for
  confirmation and says how many running ones it is turning off; the selection closes by itself after
  the action, and `Esc` exits. Every action reports how many it took and which it did not.
- **Date filter** (any date / today / last 7 / last 30 days), which combines with the status filter
  instead of replacing it: when on it is visible in the filter row, with the number, and it is
  removed from there.
- **Open all projects / close all projects**, so as not to click twenty chevrons.
- **What the agent is doing**: the waiting row says the tool in progress and how long the turn has
  been going — transcript data, no invented "thinking".
- **In the terminal of a finished conversation** a row appears saying so and saying how to start it
  again, instead of leaving an empty box that looks broken.
- **On a phone the menus are bottom sheets**: anchored to a row at the bottom of the list they went
  off the screen, or opened under the finger.

### Fixed (found by trying)

- **Compressing the list left the conversation zero wide.** Removing the column with `display: none`
  made it disappear from the grid, and the conversation became the *first* child: it ended up in the
  zero-pixel column. Now the column is zeroed and the content is hidden (`visibility`), which also
  removes it from the keyboard.
- The context menu and action bar targets on the phone, the brand width, and the "Ctrl+K" hint in a
  search field that on a phone has no physical keyboard.
- **The `Ctrl+K` check in the terminal could fail at random**: it read the box after a fixed 800 ms,
  while the agent process was still being born. Now it waits for the terminal to have drawn
  something, and if it does not, it says so with the conversation's state.

## Phase 1 — stability, bugs, configurable remote access (2026-10-31)

### Fixed — processes and registry (the serious ones)

- **`stop`+`start` left the conversation without a process.** A late exit callback from the *old*
  process deleted the entry of the *new* one: the chat became unwritable, the state said "off", and
  `sinkFor` — not finding it alive — started **a second `--resume` on the same conversation**. Now
  only the process alive *now* can declare the session dead. `test/session-process.test.mjs`, with
  the real race and a full round over the network.
- **`wra stop` could kill a foreign process.** Recovery (rotated token) killed the pid written in
  `server.json` without verifying it, and on Windows every `wra stop` left that file there
  (`process.kill(pid,'SIGTERM')` is `TerminateProcess`: the shutdown handler never ran). Now shutdown
  is orderly — the server closes the PTYs, removes its own reference and exits with code 0 — and
  recovery verifies **pid and start time**: if the pid has been reused, it is not touched.
- **A websocket frame over the limit brought down the server.** An `error` on the socket with no
  listener = unhandled exception = dead process: a single client took down everyone's conversations.
  Now that connection closes and the others remain.
- **A corrupted registry blocked every later save.** The health check ran *before* the rename and
  raised: from that moment no conversation was saved any more, and new ones stayed in memory without
  existing on disk. Now the broken file is set aside (`.corrupt-<when>`) and we write; and memory is
  updated **after** the write, so ghost conversations no longer exist.
- **`wra start` with an unreadable registry waited 40 useless seconds** and then could not say why
  (the log was in the queue and never written). Now it notices the child's exit immediately, and the
  log is written line by line.
- **A path through a link (junction/symlink) could leave the allowed roots** — and the machine
  authenticated to a network server *during validation* (NTLM relay). Now every component below the
  allowed root is checked with `lstatSync`.

### Fixed — client, CLI, interface

- **`Ctrl+C` must not leave the shell stuck.** The attached window puts the terminal back in order
  when it exits (alternate screen, mouse, focus, bracketed paste, cursor), **and the bytes really go
  out** (`process.exit()` discarded the write queue); `SIGINT`/`SIGTERM` handlers are registered
  before every wait; and **when the session dies the window exits by itself** instead of staying mute
  forever, which is the real "PowerShell stuck".
- **`exited` was not a visible state**: a death read as "off", identical to a chat never started. Now
  the registry says so, and the interface shows it.
- **The `wra attach` banner was printed twice** (`welcome` + `opened`).
- **Input to a conversation without a process disappeared silently**: now a message arrives.
- **`findSession` preferred an id prefix over an exact name** — `wra attach abc` attached the wrong
  conversation — and a record without a name crashed the CLI.
- **`serve.lock` was not isolated** (a test touched the file of whoever uses the machine) and was
  considered "old" after 30s while whoever holds it can wait 40: now it sits next to the registry and
  is discarded only if whoever holds it is no longer alive.
- **`Ctrl+K` did not work with the terminal focused** (xterm stops key propagation, so the handler on
  the document did not see them, and that byte reached the shell as "clear line"), and **`Esc` emptied
  the search instead of closing the open menu**. Now `Ctrl+K` uses xterm's API, `Esc` gives priority
  to menus and dialogs, and in the terminal the only key taken is `Ctrl+K` (the `/` slash stays with
  Claude Code).
- The turn journal is also trimmed when it is loaded; two entries with the same `sessionId` no longer
  cause damage (one is kept).

### Added — access from outside, two modes

- **`wra access`**: writes the choice (Tailscale or Cloudflare Tunnel, or both) into
  `~/.cc-remote/access.json` and **prints** the commands to run. It touches neither tunnel, DNS nor
  the already-active configuration.
- **The two surfaces stay separate in the code**: on the dashboard hostname the machine routes
  (including the consent round) answer 404; on the MCP endpoint hostname the site and the person's
  APIs answer 404. The locks are always mounted, even with the MCP bridge off.
- **More allowed origins** for the websocket: with Tailscale and Cloudflare on together the browser
  arrives from two addresses, and accepting only one left the page mute from the other side.
- `docs/REMOTE-ACCESS.md`, new; `docs/CHATGPT.md` and the tools no longer contain personal values
  (no domain, hostname or path of whoever wrote them).

## M5 — projects and conversations (2026-10-30, night)

### Added
- **Project metadata** in `~/.cc-remote/projects.json`, deliberately separate from the session
  registry: a display name, a star and a "hidden" flag per folder. Renaming a project in the
  interface cannot touch a conversation, a transcript or the real folder path. Atomic writes, a
  verified `.bak`, and the same fail-closed recovery as the registry.
- **Managing projects from the interface**: search, expand/collapse (remembered), sort by recent
  activity / name / favourites first, favourite, hide and restore (the footer says how many are set
  aside), copy the real path, open the folder on the PC, and add a project by choosing a folder that
  exists. `Open the folder on the PC` is accepted **only from a local origin**: from the phone it is
  a 403.
- **Managing conversations**: pin to the top, move into a *section* (a label — the project folder and
  the transcript never move), archive and restore, rename, sort by activity / name / creation date,
  and a context menu with every action.
- **Filters with counts** — all, recent (last week), favourites, active, archived — plus "only the
  project of the open conversation".
- **Search inside the messages** (`GET /local/search`): bounded by a time and byte budget, it hands
  the event loop back while it reads — a search must not freeze the terminal or an approval — and it
  *says* when it stopped early instead of pretending it looked everywhere.
- **Resizable sidebar**, remembered, draggable or with the arrow keys; double click resets it.
- **`wra detach`**: detaches attached windows from another window. Leaving must not depend on a key,
  and this is the way out when a terminal swallows one.
- **`tools/ui-check.mjs`**: twenty checks in a real browser (Chrome over CDP, no new dependencies)
  with real mouse events, screenshots, and a final "no console errors, no failed requests".
  `tools/seed-demo.mjs` fills a demo registry with 520 conversations / 24 projects.
- **260 tests** (13 of them on the new routes, against a real server): projects, detach, search, a
  failed spawn, and two browsers writing at the same time without losing a field.

### Fixed
- **`Ctrl+Q` never detached, and now it does.** ConPTY writes `ESC[?9001h` (win32-input-mode) at the
  start of every PTY; `wra attach` forwarded it to the local terminal, which then encoded every
  keypress as a win32 sequence — `0x11` no longer existed. The `ESC[?9001l` that would turn it off is
  swallowed by conhost. `src/core/input-mode.mjs` strips both from the output before it becomes
  replay or websocket, carrying an incomplete sequence across chunks.
- **A conversation opened empty when its process could not start.** A failed PTY spawn (the folder
  was deleted, say) aborted the whole `open`, so the history never arrived — an empty chat with a
  toast scrolling by. Now the conversation opens, its history is read from the transcript, and the
  reason there is no process is reported.
- **"Only the open project" with nothing open showed an empty list**, and it is a remembered
  preference — a dead end that survived restarts. With no conversation open it now means "show
  everything".
- The last filters were unreachable: the row scrolled horizontally and the fifth chip sat outside the
  visible area, so the click landed on the chat. It wraps now.
- **The test suite wrote into the user's `server.json`.** `serve` recorded the server it had just
  started at a fixed `~/.cc-remote/server.json`, so a test server on an ephemeral port overwrote the
  record of the real one — with the pid of a process that was already dead, which is how `wra stop`
  (which reads that file when the token was rotated) could end up killing a recycled pid. The record
  now lives next to *its* registry (`CR_STATE_FILE`'s directory).
- **A path through a link could leave the allowed roots, and authenticate the machine to a network
  server while validating it.** A directory junction planted inside an allowed root looks like a
  normal folder and `statSync` follows it, so the SMB/NTLM contact happened *before* anything was
  opened — the exact relay the UNC check says it prevents, and the new "open on the PC" button made
  it reachable from the interface. `resolveProjectDir` now walks each component below the allowed
  root with `lstatSync` and refuses symlinks, junctions and mount points (`test/guards.test.mjs`,
  with a real junction).
- **The origin check was documented as more than it is.** `Origin` is written by the client: a
  token-holder can omit or forge it. What it really does — keep another site's browser out of local
  actions, together with a `SameSite=Lax` cookie — is kept and is worth having; the claim that `open`
  is "local only" is gone from the code comment, `docs/OPERATIONS.md` and `docs/SECURITY.md`.
- **Hardening from the same review**: message search is serialised (a queue, not parallel disk
  reads) and answers `500` with one line instead of letting a future stack trace reach the response
  body; the atomic-write temp file carries a random suffix, so a leftover temp can no longer block
  every later save once the pid is reused; the unused `flush()` on the input-mode filter is gone;
  `setLabel` accepts text only (`String({})` was being stored as "[object Object]").

## 0.1.0 — 2026-10-30

### Added
- **Approval relay**: a `PermissionRequest` hook inside each `claude` process reports the request to
  the interface and waits for a human answer. If nobody answers — or anything fails — the hook exits
  silently and Claude Code shows its own dialog. Nothing is ever granted automatically.
- **Session registry** (`~/.cc-remote/sessions.json`): one id per conversation, persistent, atomic
  writes, a verified `.bak`, and fail-closed recovery (the server refuses to start rather than
  discarding conversations).
- **Turn journal** (`~/.cc-remote/turns.json`): a `requestId` stays idempotent **across a restart**,
  not only within one process.
- **MCP bridge**: `list_chats`, `select_chat`, `talk`, `get_turn_status`, with OAuth (PKCE S256),
  per-client selection, and a per-conversation ACL that an explicit `session_id` cannot bypass.
- **Web interface**: chat view with tool cards, real diffs and collapsible reasoning; the real
  terminal; approvals integrated; sidebar with search, sorting, archiving and the MCP switch; light
  and dark themes designed separately; installable PWA.
- **CLI**: `wra start|stop|status|doctor|web|attach|detach|sessions|migrate|backup|permissions`, and
  `wra new` / `wra -c` (the gestures; `cc` / `cc -c` remain valid aliases for backward
  compatibility). `Ctrl+Q` detaches an attached window (it used to be `Ctrl+]`, awkward on an Italian
  keyboard — `Ctrl+]` stays available too, and `wra detach` needs no key at all); `Ctrl+C` is left to
  Claude, which uses it to interrupt.
- **Permission mode per conversation**, not per server. `wra new` opens a conversation with
  `bypassPermissions` (a person, at this machine, who asked for it); `wra -c` keeps whatever mode the
  conversation already had. `wra permissions [mode]` shows or changes it, the ⋯ menu does the same
  from the interface, and the sidebar and header show a `bypass` chip. Changing it restarts the live
  process with `--resume` (the mode is read only at startup); a busy conversation is left alone until
  the turn ends. **A bypass conversation cannot be exposed to MCP, and an exposed one cannot become
  bypass** — a remote client never drives a conversation where the agent acts without asking.
- **Migration**: `wra migrate` finds the conversations already on disk (the same files the previous
  system used), reads their real project and title, and registers them **without touching a
  transcript** and without starting a process.
- **Backup**: `wra backup` with SHA-256 manifests, `--verify`, `restore`, and a safety copy of the
  current state before any restore.

### Changed
- `maxSessions` default 8 → 64, plus an optional per-project cap
  (`CR_MAX_SESSIONS_PER_PROJECT`).
- Automatic conversation names count **within a project** (two projects no longer both get "chat 1"),
  and names are unique inside a project.
- `zod` 3.25 → 4.6.7 (a known DoS in the constrained-collections validator); `npm audit` clean.

### Fixed
- A whole family of ways a turn could hang or duplicate: a turn waiting for a dead process for ten
  minutes, an unbounded queue, a `requestId` forgotten after a restart, and a tool result looking for
  a message that was not in memory.
- `forget` resurrected the conversation (the exiting process wrote its record back), and the
  resulting partial record could stop the server from starting.
- The browser was logged out and its token deleted on every server restart (1006 treated as "token
  rejected").
- xterm's focus sequences (`\x1b[I`, `\x1b[O`) were forwarded to the agent's PTY as input.
- `[hidden]` did not hide anything where a `display` was set, so the token page sat on top of the
  interface, and the Chat and Terminal panes were both visible.
- A reused refresh token was indistinguishable from an invented one; revocation did not check who the
  token belonged to; the "issued for this resource" check compared a value with itself.
- The registry's startup refusal was invisible (the process runs detached): it now writes to the log,
  exits non-zero, and `wra start` prints the last lines.
- `wra status` read `turns` as a list, but `/healthz` returns an object: it died with
  `turns.find is not a function`, in the one command you run to see what is running.
- The **WebSocket upgrade did not go through Express**, so the public-host guard never applied to it:
  a valid token plus the public host reached the terminal, bypassing the host rules. The upgrade now
  applies the same surface lock (404), before authentication.

### Known issues
- `smoke-remote` failed once, right after a server restart: the permission request never arrived. It
  has not been reproduced in seven subsequent runs, and its cause is **not** established. The tool
  now prints, on failure, the conversation state, whether the prompt reached the transcript, and the
  running turns.
- The mobile keyboard, PWA installation and screen-lock reconnection have not been verified on a
  physical Android device (`docs/PHONE.md` has the checklist).