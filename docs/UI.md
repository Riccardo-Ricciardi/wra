# The interface

One stylesheet (`src/web/app.css`) with a fixed order: **tokens first, then the components that use
them**. No colour or measurement written inside a component: if a new colour is needed it is a new
token, otherwise the dark theme becomes an approximate variant of the light one — and that is how
these interfaces age badly.

## Files

| File | What it does |
|---|---|
| `index.html` | the scaffolding: list, header, conversation, terminal, dialogs |
| `app.css` | tokens (colour, type, space, shape, shadow, motion) and components |
| `app.js` | state and views: list, chat, terminal, approvals, connection |
| `ordering.mjs` | the list orders and section groups: **pure functions**, tested in Node |
| `dom.mjs` | `h()` to build nodes. **No `innerHTML`, ever**: text goes through `textContent` |
| `markdown.mjs` | markdown → blocks, pure parser (tested in Node) |
| `icons.mjs` | the icons, hand-drawn inline SVG: no fonts, no packages |
| `sw.js` | service worker: only the app shell, never APIs or websockets |
| `manifest.webmanifest`, `icon*.png/svg` | so that it is installable |

## The system

**The direction is that of a measuring instrument**, and it is written in `PRODUCT.md` together with
its anti-references. In one line: hierarchy is made by **weight and text size**, not by boxes. With
few lines and many rows, the way to say what matters is to write it larger.

### Tokens

Colour in **oklch** (perceptually uniform: two colours with the same L look alike), space in fours
(`--s1`…`--s7`), six radii, two shadows, two durations, and a layer scale with a name per step
(`--z-bar`, `--z-menu`, `--z-dialog`…: never a hand-written `999`).

The two themes are **designed**, not inverted: in the dark one the greys are warm, the accent rises
in luminance to stay legible, shadows become depth.

### The two voices

| voice | where | why |
|---|---|---|
| `--ui` (sans) | everything that is read | it is the normal voice |
| `--mono` | **the data**: counts, dates, ids, paths, and the names of the modes (`auto`, `bypass`) | the product *is* a terminal, and numbers line up |

And a distinction that applies to **all** semantic colours: a colour used as a **sign** (a dot, a
border, a glyph) only needs to reach 3:1, one used as **text** must reach 4.5. They are two
different jobs and two different tokens: `--warn` is the sign-amber, `--warn-ink` is the
text-amber. Using the first for the second gave 3.53:1 on a tinted row — on a word that says how
dangerous the conversation is.

Monospace does **not** go on buttons, labels or running text: it is the data voice, and using it
everywhere is how you look like a terminal instead of being an instrument.

### The type scale

```
11px  --fs-2xs   only status labels and counters
12px  --fs-xs    metadata: dates, paths, ids
13px  --fs-sm    controls, chips, secondary rows
14px  --fs-md    list rows, menu items
15px  --fs-base  running text, conversation
17px  --fs-lg    conversation title, block titles
20px  --fs-xl    title of a screen
24px  --fs-2xl   title of a whole screen
```

A step every 8–13%, and the two extremes far apart: **it is the distance between steps that makes
hierarchy, not the number of steps.** Before M6, 88% of text nodes sat at 11px — the whole interface
at the same size, which is exactly the "technical panel" feeling (`docs/AUDIT-M6.md` §1).

### Contrast — measured twice

```bash
node tools/check-contrast.mjs                     # the token pairs
node tools/ui-probe.mjs --url … --token …         # the colours **rendered by the browser**
```

The first computes the real WCAG ratio (oklch → oklab → linear sRGB → luminance) for ten pairs in
both themes. It is needed because luminance must be computed on **linear** values: doing it on
gamma-encoded values inflates the ratio, and that is the classic way to fool yourself that a
palette passes.

**And it is not enough.** The real colour depends on **what is underneath**: at M6 the token check
passed while four metadata classes, measured on rendered nodes, sat at 4.28–4.49 — they were on
`--raised`, and the pair being measured was the one on `--surface`. That is why `ui-probe.mjs` reads
the colours from the canvas (the browser returns `oklch(…)`, not RGB: reading its digits and calling
them "red, green, blue" gives invented ratios) and climbs back to the **painted** background behind
every node.

Now: **zero nodes below threshold in both themes**.

### The rules

1. **No values outside the tokens.** If a new colour, measurement or radius is needed, it is a new
   token — otherwise the dark theme becomes an approximate variant of the light one.
2. **A new component justifies itself** when what exists cannot do the job. First look whether
   something similar already exists. The components are those in the table below, and **those outside
   it are zero**.
3. **Hierarchy is made with text**, not with boxes. An extra panel is an exception to explain, not
   the default way to group.
4. **Colour is never the only sign.** Every state also has a word or a shape: colour blindness is
   common, and red/amber is the pair that is lost first.
5. **No `innerHTML`**: text goes through `textContent` (`dom.mjs`). A transcript cannot inject
   markup.

### The components

| component | where | variants |
|---|---|---|
| `.btn` | an action | `btn-primary`, `btn-danger`, `:disabled` |
| `.icon-btn` | an action without a word | `[aria-expanded]` on |
| `.field` | a field with an icon inside | `:focus-within` |
| `.chip` | a short fact, in the header or a row | `accent`, `danger` |
| `.facet` | a list filter | `[aria-pressed]` |
| `.conv` | a conversation row | `data-tone`: `normal` · `auto` · `bypass` · `combined` |
| `.project` | a project in the list | `data-current`, `data-hidden` |
| `.menu` | a context menu, **anchored to its button** | `.row`, `.row[aria-checked]`, `.sep` |
| `.switch` / `.radio` | a switch · a choice among a few | `[aria-checked]` on the row |
| `.dialog` | a decision that asks for confirmation | `.btn-danger` for the serious ones |
| `.perche` | an explanation that is needed once | `[open]`, looks like a button |
| `.note.tests` | a row at the bottom, not a block at the top | `.link-btn` for its actions |
| `.mode-btn` | the authorization mode, in the header | `data-tone` like `.conv` |
| `.auth-bar` | the declaration of a state that must be seen | `data-tone`: `bypass`, `combined` |
| `.auth-choice` | one of the three modes, in the panel | `data-tone`, `:has(input:checked)` |
| `.ledger-row` | a fact in the status ledger | — |
| `.tool`, `.code`, `.diff`, `.thinking` | the conversation | `data-status="error"` |

### Where menus end up, and who is above whom

A menu's position is decided by `src/web/ui/anchor.mjs` — **pure**, no DOM, tested in
`test/anchor.test.mjs`. Geometry goes in (the button's rectangle, the menu's size, the screen's
size), position comes out. Three rules, in order:

1. **inside the screen**, at every width;
2. **attached to its anchor**: the menu's right edge sits on the button's;
3. **below, or above if there is no room below**: it flips only when flipping is really better; a
   menu taller than the screen limits itself and scrolls inside.

`position: fixed` is written **before** measuring, and it is not a detail: attached to `#menu-layer`
— a block as wide as the page — the menu measured 1440 instead of 230, the calculation to keep it
inside the screen started from there and always ended in the same place: `left: 8px`, detached from
its anchor. That was **the** M9 defect, and it was visible only by measuring. A `fixed` menu does
not follow its anchor by itself: it repositions when the window resizes or the page scrolls.

Who is above whom is declared in the tokens, and no component writes a number by hand:

```
content 0 · guide 2 · header 3 · veil 30 · drawer 35 · menu 40 · dialog 50 · toast 60 · token 70
```

The toast is above the dialog because it says what has just happened, and a confirmation that ends
up under the dialog that asked for it cannot be read; it does not steal clicks anyway
(`pointer-events: none`).

**Focus does not leave a dialog** with Tab: `aria-modal="true"` promises it, and cycling among the
dialog's buttons is what keeps it true. Escape and an outside click close menus and dialogs, and
there is a check that demands this from three different pages.

### Targets, keyboard, motion

- Finger targets **≥ 44px** below 60rem (`--tap`). At M6 one remained below threshold — the search
  field, 38px — and it is now at 44. M9 found **15** more that escaped because no check was looking
  at them: the `.btn` buttons at 36px, the two text items of the test entries at 19px, and the
  "why…" at 30px. Now they are zero, and `ui-audit-m9.mjs` prints the `finger` column (targets
  under 40px **where the finger is**, that is, below 960px) that enters the problems.
- `ui-probe.mjs` counts the keyboard-reachable ones and those **without an accessible name**: 149
  reachable at 1440px, **zero without a name**. That is a number to keep at zero.
- `prefers-reduced-motion` and `prefers-contrast: more` respected.

## The home

With no conversation open, the page is not an invitation: it is a list you click on.

- **Now** — the conversations with a live process, with their status dot;
- **Recent** — the last eight used, with the project and how long ago;
- **Projects** — the first eight by star and by number of conversations, with the "+" to open one
  there.

**Two columns**, not one: what is happening on the left, where things are on the right. Before it
was a single 280px column inside 1152 — three quarters of the screen empty with the content
squeezed in the middle, which is not calm, it is unused space (`docs/AUDIT-M6.md` §4). The titles
are **titles** (17px, normal form) and not 11px small-caps labels, and the number next to them is
data: monospace and in the background.

Below 60rem it returns to a single column, and an empty column is not drawn.

If the project is closed in the list, it opens from here (`showProject`). The writing field, the
chat/terminal tabs and the conversation options **disappear**: they are things of a conversation,
and without an open conversation they have no subject.

With an empty registry the home becomes the three things to know at first start: what WRA is, that
the agent runs on *this* PC, and the only action to take.

## The authorization mode

**It is the heart of M6**, and it is the thing that was not there before. The three modes — normal,
controlled automatic, bypass — were three switches inside the `⋯` menu, at the same height as "copy
the id", each explained in a tooltip that does not exist on a phone; and in the list they were
distinguished by the colour of an 11px badge. To know what the agent can do you had to **read a
word** (`docs/AUDIT-M6.md` §2 and §3).

Now they are two things: a **marker** that is always in the same place, and a **screen** where the
decision is made.

### The marker

In the header, always visible, with a tint and a glyph for each:

| mode | tint | sign |
|---|---|---|
| **Normal** | none | none — it is the default, and the default must look like the default |
| **Controlled automatic** | amber | the name, in monospace |
| **Bypass** | red | the name, and a **strip** that declares the sentence in full |
| **Undescribed** | amber with the warning | the mode's name, and a strip saying we cannot describe it |

### The fourth, which is not a mode

`permissionMode` accepts a closed list that this screen **does not offer**: `acceptEdits`, `plan`,
`auto`, `dontAsk`. They come from `claude --permission-mode` at the start of a conversation, or
from a `POST` that asked for them by name — not from here.

The first version read them all as "normal", and **lied**: `docs/SECURITY.md` documents that
`acceptEdits` auto-approves reads, file edits and the common filesystem commands (`mkdir`, `touch`,
`mv`, `cp`) inside the project folder, while the screen said "every command asks". That is, the worst
case shown as the least alarming of all — exactly what this milestone exists to avoid. Found by a
security review, not by a test: the test **encoded** the defect.

Now they are a separate state (`other`): the mode's name, amber tint with the warning, a strip, and
none of the three radios on — turning on "Normal" there would be the same lie. For `acceptEdits` the
sentence is the source's; for the others we do not know, the answer is **"I don't know"**, not a
guess: on a screen that says what the agent can do, erring towards alarm costs a reading, erring
towards calm costs what the product exists to prevent.

And you **get out of it**: choosing one of the three really replaces it. In the first version
clicking "Normal" did nothing, because `acceptEdits` was read as "normal" and the screen exited
immediately with "it is already the one you chose".

In states that must be seen — bypass, and bypass **exposed to a remote model** — a strip with the
whole sentence appears under the header, and the only thing that removes it is changing mode. In the
other cases there is none: a strip that is always on is a strip nobody reads after two days.

### In the list

The state is the **row's tint**, not a badge: it is visible from the side while scrolling, which is
what you need with five hundred rows. Colour is not the only sign — the word in monospace is there
too — because colour blindness exists and red/amber is the pair that is lost first.

`bypass` **and** exposed to an external client is not the sum of the other two: it is a worse
condition, and it has its own name (`bypass + exposed`), a stronger tint and one more sign.

Exposure to ChatGPT is a **different axis** — who can talk to the conversation, not what the agent
can do — so it has a different shape: it is a **plug**, in accent, never a mode.

### The screen: "This conversation"

It opens from the marker in the header, or from `⋯ → Permissions and access…`, and it takes the
chat's place instead of living in a dialog: they are three choices with a paragraph of consequences
each, and in a 26rem dialog that paragraph becomes a footnote.

- the three modes as **real choices**, each with **what it entails** written under the label, and
  for bypass also **what is being accepted**;
- exposure, separate, with its switch and its explanation;
- the address carries the screen (`#c=<id>&permissions`), so a refresh brings us back.

The interface's three modes are **two things in the registry** — the conversation's mode and the
automatic one — and the server does not allow them to be on together. The transition is therefore
always "unmount what is there, then mount what you want", in one place (`setMode`), instead of in
three points of the interface that must remember it.

### The sentences live in a module

`src/web/authorization.mjs` is **pure** and tested in Node (`test/authorization.test.mjs`).
`docs/SECURITY.md` is the source, and two screens cannot say it in two ways: if the sentence
explaining bypass lives inside a `render`, sooner or later one of the two promises something the
system does not do.

The functions: `modeOf`, `authorizationOf`, `reachOf`, `stateOf`. And one thing the tests found: in
the registry `autoApprove: false` and `null` are **two different things** — `null` means "I have not
decided" and the project applies, `false` means "not here" and wins. Treating them the same meant a
conversation could not opt out of its folder's automatic mode.

## Where you are, and what remains

The open conversation is written in the address (`#c=<id>`, via `replaceState`): refreshing the page
brings you back where you were. The brand at the top of the list returns to the full list without
turning anything off — the conversation stays in the registry, its process stays on, you only stop
looking at it.

**The list compresses** with the button in the header — the same one that opens the drawer on a
phone: one button, two jobs, one thing less to learn. Compressed it is not a narrow column: the
header and the content are no longer visible (and no longer reachable by keyboard) and the
conversation takes all the space. The choice is remembered.

The reason for `visibility` and not `display: none` is worth writing down: removing it from the grid
makes the conversation the **first** child of `#app` and it ends up in the first column — which,
compressed, is zero wide. A defect found by trying, not by reasoning.

## Organising projects and conversations

With few conversations a list is fine; with five hundred it is a wall. So the list has a structure,
and the structure is controlled.

- **Projects open and close**, and it remembers which: it keeps the set of those **open**, not those
  closed, because the starting point with five hundred conversations in thirty folders is
  "everything closed". The one of the conversation you open opens by itself.
- **The filters** — all, recent (last week), favourites, active, archived — declare how many
  conversations they take: a filter without a number is a filter you do not trust. They wrap
  instead of scrolling: a scrolling row hides the last filter, and a filter you cannot see is a
  filter that does not exist.
- **Sections** are labels inside a project (`⋯ → Move to a section…`). They move nothing: the folder
  and the transcript stay where they are. If a project has at least one section, its conversations
  are grouped; **pinned** ones stay at the top, because that is what the star promises (the label
  stays written on the row and in the header).
- **The project** has a display name, a star and "hidden", and they live in
  `~/.cc-remote/projects.json` — **a file separate from the registry**, so renaming a project cannot
  cost a conversation. "Hide" is reversible (the footer says how many are set aside and puts them
  back); "forget" deletes only the label, and only if there are no conversations left.
- **Open the folder on the PC** is the only action in this list that does something on the machine:
  the server accepts it **only from a local origin**. From the phone you look and organise, you do
  not open windows on the PC.
- **Search** filters the list while you type. To search **inside** the messages there is one extra
  step, and you ask for it: reading the transcripts on every keystroke is how you make search slow
  instead of useful. It has a time and byte ceiling, and when it stops **it says so** (`looked at N
  conversations out of M`) instead of pretending it looked at everything.
- **The list width** is dragged (or changed with the arrow keys, when it has focus) and remembered;
  double click returns to the starting size.
- **When**: any date, today, last 7 days, last 30. It is an axis **different** from status and
  combines with the filter (recent + today = the narrowest), it does not replace it. When on it is
  visible in the filter row with the number, and it is removed from there: an active filter that
  cannot be seen is how you come to believe a conversation disappeared.
- **Open all projects / close all projects** from the sort menu: with twenty folders, twenty chevron
  clicks are twenty clicks too many.
- **Bulk actions.** The "sort and filter" menu turns on selection: the checkbox on every row, the
  checkbox on every project ("all of this folder's" — what you **see**, filters included) and a bar
  at the bottom with archive/resume, pin and section. The bar says **how many** conversations each
  action takes before you press it, and archiving asks for confirmation saying how many active ones
  it is turning off: it is the only bulk action that changes something *while* it happens. When the
  action finishes the selection closes by itself — a mode that stays on is how you archive by
  mistake the next thing you click — and every action reports how many it took and which it did not.
  The requests are one per conversation, on the route that already exists: locally the round is
  milliseconds, and a group route will be added the day selections are counted in thousands
  (`ponytail:` in `app.js`).
  None of this deletes a transcript: archiving removes from the list, labelling writes a label, and
  the project folder is not touched.

What you chose stays: order, filter, open projects, width, theme. An interface that forgets how you
had set it is put back in place every time.

### Long rows, short lists

A row cannot say everything: it says the name, the state (the dot), whether it is pinned, whether it
is imported or archived (an icon with its explanation), **how it authorises** (the tint and the
word) and whether it is exposed to an external client (the plug). The rest — full state, section,
where it comes from — is in the header when you open it, and on hover over the row. With five
hundred rows, legibility *is* the feature.

The list drawing goes through one frame (`requestAnimationFrame`): the server sends state on every
piece of terminal output, and redrawing sixty rows for every line the agent writes is how you make
slow an interface that has nothing slow about it.

### Quick search from the keyboard

Ctrl+K (or Cmd+K) puts the cursor in the chat and project search, opening the sidebar on the phone.
In the chat view you can also use / when you are not typing. Esc clears the filter when the search
field is active. In the terminal / remains a Claude Code key, not a site shortcut.

## What the conversation shows

Everything comes from the transcript, and only what is there:

- **text** from the agent and the user (markdown: headings, lists, quotes, code, links);
- **reasoning** (`thinking`), collapsed, with the duration the transcript records;
- **tool cards**: name, what they ask for, outcome (`error`, `approved by you`, `allowed by the
  rules`, `allowed by the mode`, `done`), request and result;
- **real diffs** for `Edit`/`Write`: the transcript's `structuredPatch` is already a unified diff
  (`-`, `+`, context lines) and is drawn as it is. A diff is not reconstructed from before/after:
  that would mean inventing a numbering the transcript does not give;
- **errors**: the card opens by itself and the result is in red.

If a datum is not there, that piece does not appear. No placeholders, no invented "thinking": the
only activity signal is `busy`, which the turn coordinator really knows.

**While the agent works**, the bottom row says what it is doing: the tool in progress — which is the
last call in the transcript without a result — and how long the turn has been going (computed from
the time of the agent's last message, not estimated). The time updates by itself, because the
server sends nothing while the agent thinks.

**The terminal of a finished conversation** says so, in a row above the box, and says how to start
it again: an empty terminal without explanation is the thing that makes an application that is
working look broken.

## Approvals

The request appears above the writing field, with **the whole command**. If the command looks like
an operation that deletes, rewrites remote history, publishes, shuts down the machine or runs
downloaded code, the card turns red and says so — it is a closer reading, not a verdict: the
decision remains with whoever reads it.

## Keyboard

| key | what it does |
|---|---|
| `Ctrl+K` | opens search — it works **even with the terminal focused** (`term.attachCustomKeyEventHandler`: xterm stops key propagation, so a handler on the document does not see them there) |
| `/` | opens search, **except** in the terminal: there the slash belongs to Claude Code, which uses it for commands |
| `Esc` | closes first what is open (menu, dialogs), and **only if there is nothing to close** empties the search |
| `Enter` / `Shift+Enter` | sends / goes to a new line, in the writing field |

`Ctrl+K` is the **only** key WRA takes from the terminal: everything else reaches the TUI as if this
page did not exist. If Claude Code ever uses Ctrl+K, that key will have to change — and that is why
it is written here.

### When the session ends

The browser terminal, like the `wra attach` window, is put back in order when the conversation ends:
it leaves the alternate screen, shows the cursor, turns off mouse, focus reporting and bracketed
paste (`src/web/terminal-reset.mjs`, one definition for both). Without it, the tab stayed "dirty":
the history no longer scrolled and it looked stuck.

## Accessibility

- Touch targets of **44px** below 60rem (above that a finger errs). At M6 one remained below
  threshold — the search field, 38px — and it is now at 44: it is measured with
  `tools/ui-probe.mjs`;
- **zero** reachable elements without an accessible name (149 reachable at 1440px);
- contrast **verified on rendered nodes**, not only on token pairs: zero below threshold in both
  themes;
- `:focus-visible` with an accent ring on everything;
- roles and labels: `tablist`/`tab`, `dialog`/`aria-modal`, `menu`/`menuitemcheckbox`, `alertdialog`
  for approvals, `aria-live` for messages and warnings;
- Escape closes menus and dialogs; focus goes where it is needed;
- `prefers-reduced-motion` and `prefers-contrast: more` respected.

## The panel

Administration is not a page with everything inside: it is **five sections, one at a time**, with
the secondary navigation **on the left and fixed** (`.admin-rail`). It used to be a row of tabs
above the content — four sections stacked in a single column, scrolling away together with what you
were reading, and to change section you had to go back to the top.

| section | what it does |
|---|---|
| **Status** | what is running now: the registry, the processes, the MCP bridge; advanced diagnostics closed |
| **Access** | how to get in from outside, the two modes side by side, verification |
| **Conversations** | the two lists that do not match: reconciliation |
| **Backups** | make one, verify it, preview the restore, restore |
| **Settings** | where conversations are born, and how far they can go |

Three rules of form, and they are the difference from before:

- **a single reading column** (`--measure-wide`): before, the title sat at 520px, the table at 1060
  and the tabs at 1425 — three measures in the same screen;
- **one row when that is enough**: explanations needed once live behind a `<details class="perche">`
  ("what a backup contains", "what a restart entails", "why nothing is deleted"). It is not text
  removed: it is text moved to where you go looking for it;
- **diagnostics do not occupy the main screen**: the checks, the log and the file paths live inside
  "Advanced diagnostics", closed — but its title says whether there is anything to look at ("14
  checks, 2 to look at").

Fields are written into a **draft** that wins over the saved value, and `paint()` puts the cursor
back where it was: the panel refreshes itself every five seconds, and without that a half-typed
hostname disappeared under your fingers. It applies to all fields of all sections, and it is tested
on each one.

### Reconciliation, in one line

The registry says which conversations WRA knows about; the transcripts in `~/.claude/projects` are
the ones Claude Code actually wrote. The two lists diverge — the M9 audit measured 13 entries
without a transcript and 183 transcripts without an entry — and the "Conversations" section compares
them. The rule lives in `src/core/reconcile.mjs`, **pure** and tested in Node: it deduplicates, does
not import what `--resume` would not resume, shows a row-by-row preview, writes a safety copy before
touching the registry, and **deletes nothing**. The good list is recomputed by the server on every
call: the client says *which* ones it wants among those the server has just found, and the server
does the intersection.

## Phone and PWA


- The list is a drawer; it **always opens in chat** (the terminal is something you go looking for,
  not where you want to land), and the home is the first thing you see;
- **menus are anchored to their button here too**, with the same three rules as the wide screen and
  44px targets. The sheet that rose from the bottom is gone: it was the cure for the symptom — the
  menus ended up on the left, so one as wide as the screen was made, where the defect could not be
  seen. At 390px the same rule holds as at 1440, and the menu stays inside;
- the header and the panel's secondary navigation **wrap** instead of scrolling sideways: a row that
  scrolls hides the last items behind an edge that does not say there is more (at 390
  "Administration" ended at x=396, six pixels off the screen);
- the bulk action bar has 44px targets, and selection is touched row by row;
- the writing field follows `visualViewport`, so it **does not end up under the Android keyboard**;
- focus is not taken by itself on a narrow screen: the keyboard would appear on its own;
- installable (manifest + service worker). The service worker caches **only the shell**: never
  APIs, websockets, MCP or authorization pages. Without a network the app opens and says so, with a
  button to retry; when the network returns it reconnects by itself.

## Regenerating icons and checks

```bash
node tools/make-pwa-icons.mjs     # the 192/512 icons, hand-written in PNG (no dependencies)
node tools/check-contrast.mjs     # the contrast ratios of the two themes
node --test test/markdown.test.mjs test/conversation.test.mjs test/ordering.test.mjs
```

## Trying the interface for real

It is not a unit test suite, and it does not run on every commit: you launch it when you want the
answer to "does it work, pressing the buttons?".

```bash
node tools/ui-check.mjs             # 35 checks, 520 conversations in 24 projects
node tools/ui-admin-check.mjs       # 18 checks, the panel
node tools/bench-rounds.mjs 10      # ten rounds in a row of both, for repeatability
node tools/bench-solo.mjs           # every check **alone**, on a new registry
node tools/ui-check.mjs --only "a section"   # or just one, by hand
```

**There is nothing to prepare beforehand and nothing to clean up afterwards.** The bench builds its
own world in `tools/bench.mjs`: a throwaway folder, a freshly seeded registry, a server on a port
the system chooses, the fake TUI. At the end it shuts the server down from its shutdown route (which
also closes the PTYs), takes down the tree if that is not enough, and removes the folder.

Three rules, and each answers a defect actually seen:

1. **No `~/.cc-remote`.** The registry lives in the test folder and everything next to it follows —
   `projects.json` learned this at its own expense, having filled up with 64 test entries, all
   written by a bench that believed it was isolated.
2. **Identical data every round.** It is re-seeded on every run, it does not reuse the previous one.
   (Instants are relative to "now", so the *shape* of the data is the same at every hour: a "last 7
   days" filter takes the same rows this morning and this evening.)
3. **One bench, one registry.** The two benches no longer step on each other: each has its own server
   and its own registry, and the order in which they are launched does not matter.

It was not like this before, and the consequence was that **the bench modified the registry it was
running on** — archives, pins, renames, moves into sections. Two rounds in a row gave two different
numbers, and the second failure had nothing to do with the code. A bench that depends on what the
previous round left behind is not a bench: it is a chronicle. `tools/bench-rounds.mjs` is the answer
to the question that matters — ten rounds, and it says if two differ.

The clicks are **real** mouse events (`Input.dispatchMouseEvent`), not `element.click()`: it is the
only way to notice what is *on top* of a button. The first two things it found were exactly this —
the last filter outside the visible area, and a section that disappeared — plus a chat that opened
empty when the process did not start.

`ui-check.mjs` does **35 checks** with real clicks: list with 520 conversations, filters and counts,
opening and closing projects, opening a chat, conversation and project menus, star, section, rename,
hide/restore, search, search in messages, archive, the two themes, the terminal, the phone at 390px
(44px targets included) and — at the end — **zero console errors and zero failed requests**.

Two things learned writing these checks, and they hold for whoever writes others:

- a check that reads a box after a fixed 800 ms does not test the terminal, it tests the stopwatch:
  you wait for the datum to be there, and if it is not you say so **with the conversation's state**
  (open/imported/state/rows drawn). The bench has a helper for this — `waitFor(expression, what)` —
  and one for the registry, `waitForRegistry(name, predicate, what)`;
- `resetList()` returns the page to a whole state — list in view, no selection on — because a check
  that fails halfway must not make the next five fail for an unrelated reason. **And no step is
  skipped silently**: an `if` that, when the item is not there, continues without saying so is how a
  check lies — that is how "a section groups" stayed red for a whole round without saying why. The
  menu item is compared with what the registry says, and if they do not match the check falls
  **there**.

Since M6, in addition: **the three authorization modes** — that normal carries no marker, that the
automatic one is amber, that bypass declares itself with the strip, that the worst case has its own
name, and that revoking exposure does **not** turn off the mode — plus the assertion that the three
permission items did **not** return to the `⋯` menu.

### Three tools, and one thing to know

| tool | what it does |
|---|---|
| `tools/ui-shots.mjs` | the same screenshots, always: it is the "before/after" you can look at instead of remembering |
| `tools/ui-probe.mjs` | **measures**: type scale, contrast on rendered nodes, finger targets, keyboard |
| `tools/ui-perf.mjs` | seeds 10/100/500/2000 conversations, starts a server for each, times it |

`ui-perf.mjs` answers with numbers, and they must be read for what they say. Measured on the
page-shell with isolated benches (November 2026, two rounds):

| conversations | open | search | change page |
|---|---|---|---|
| 10 | 115–119 ms | 20–28 ms | 17–18 ms |
| 100 | 115 ms | 15 ms | 26 ms |
| 500 | 165 ms | 13 ms | 19 ms |
| 1000 | 215–229 ms | 17–20 ms | 7–11 ms |
| 2000 | 370–376 ms | 29–33 ms | 9–13 ms |

**It is not flat.** The open time grows with the number of conversations, because the page draws
**all** the registry rows: at 2000 it is 370 ms, about 250 ms more than at 10, and still under half
a second. The owner's registry has **84** conversations, and there the page opens in ~115 ms.

The M6 measurement — "flat up to 2000, 109–121 ms" — was made on the **column shell**, where the
list was a box inside a column and not a whole page: it is not comparable, and it is worth saying so
instead of quoting it as if it were. What is known now is that growth follows the number of drawn
rows, and that the point where virtualisation would be needed is around thousands of conversations —
not hundreds. The search filter, on the other hand, is flat: 13–33 ms from 10 to 2000.