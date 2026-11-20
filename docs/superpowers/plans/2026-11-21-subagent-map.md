# Subagent Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full-editor "Subagents" tab per chat showing the delegation tree (lead → subagents → nested) with models, live timers and latest steps, a live chat pane per agent with steer/stop, and a lead that delegates to ★ models on its own in every chat.

**Architecture:** `extension.js` keeps merging omp's subagent frames into `this.subagents`, now also subscribing at level `events` to learn which subagent made which `task` call (for nesting) and to refresh an open pane. A new `subagent-map.js` owns one `WebviewPanel` per chat and turns `chat.mapState()` into posts; `media/map.js` + `media/map.css` draw the tree and the pane. The ★ model guidance moves from the "Split across subagents" prompt into the system prompt.

**Tech Stack:** VS Code extension API (CommonJS, no bundler), plain DOM in the webview, `node --test` with the fake `vscode` in `test/helper.js`.

**Spec:** `docs/superpowers/specs/2026-11-21-subagent-map-design.md`

## Global Constraints

- No new dependencies. Webview scripts load only from `media/` with the nonce CSP used by `ChatProvider.html()`.
- All UI text in English in code, Vietnamese in `l10n/vi.json`; the webview translates through `media/l10n.js` `watch()`.
- Steps per node: 3 latest plus "+N steps". Pane on the right at tab width ≥ 900 px, else at the bottom with a draggable height.
- The map never opens or takes focus by itself.
- Pane refresh: at most every ~700 ms per open agent, trailing call kept.
- omp honours one `--append-system-prompt`: ANNOUNCE_STEPS and the ★ guidance share it.

## Review Focus

1. A subagent frame arrives before its parent's `task` call was seen (or the event level is unsupported) → the node shows under the lead, never lost.
2. A busy run (several agents streaming text deltas) → `subagent_event` frames other than `task` tool starts are dropped without posting anything.
3. The map tab closed while agents run, then reopened → shows the current state at once.
4. Steering an agent that finished between click and send → the error appears in the pane's chat, not only in the main chat.
5. A chat tab closed → its map tab closes too (no orphan panel posting to a dead chat).

---

### Task 1: The lead knows the ★ pool in every chat

**Files:**
- Modify: `extension.js` (`spawn()` args ~779, `delegatePrompt()` ~1358)
- Test: `test/tabs-memory.test.js:111-148`

**Interfaces:**
- Produces: `ChatProvider.delegationGuide(): string` ('' when the pool has < 2 models); `ChatProvider.systemPromptArgs(cfg): string[]` (0 or 1 `--append-system-prompt=` arg). `delegatePrompt()` returns `DELEGATE_PLAN` only.

- [ ] **Step 1:** In the existing plan/delegate test, change the assertions: after `overlayArgs()` with ★ models, `provider.systemPromptArgs(cfg)` has one arg containing `Split work into subagent tasks when it helps; you decide.`, `` `model` field `` and `- deepseek/deepseek-v4-flash — the current model\n- deepseek/deepseek-v4-pro\n- openrouter/x/y:free (Y) — free\n`, plus ANNOUNCE_STEPS' `# Keeping the user informed`; with `announceSteps: false` it still has the guide; with no ★ models and `announceSteps: false` it is `[]`. The delegate prompt no longer matches `` `model` field ``.
- [ ] **Step 2:** `npm test` → the changed test fails (`systemPromptArgs is not a function`).
- [ ] **Step 3:** Implement: the guide is today's text after `DELEGATE_PLAN` in `delegatePrompt()`, prefixed with `# Delegating\nSplit work into subagent tasks when it helps; you decide. `; `spawn()` computes `overlayArgs()` before `systemPromptArgs()` (the guide reads `this.taskPool`).
- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5:** Commit `feat: lead model knows the ★ pool in every chat`.

### Task 2: Subagent tree data

**Files:**
- Modify: `extension.js` (`spawn()` subscription ~833, `onRecord` ~1220, `onSubagent` ~450, `send()` ~2197, `onStatusEvent` ~426, `newSession` ~2242)
- Test: Create `test/subagent-map.test.js`

**Interfaces:**
- Produces on each record in `this.subagents`: `parentAgent: string|null` (id of the subagent that made the spawning `task` call; null = the lead), `steps: {tool, args}[]` (oldest first, ≤ 5, args ≤ 120 chars), `startedAt: number`, `endedAt: number|null`.
- Produces `ChatProvider.lead: {task, model, startedAt, endedAt}|null` (task = first line of your latest non-command message, model = `ompChat.model`), cleared with `this.subagents`.
- Produces `ChatProvider.mapState(): {lead, agents: record[], now}` and `ChatProvider.onSubagentEvent(payload)`; `this.taskCalls: Map<toolCallId, subagentId>`.
- Calls `this.map?.update()` after every change and `this.map?.agentActivity(id)` on each event/progress of agent `id` (Task 3 defines both; guard with `?.`).

- [ ] **Step 1:** Write `subagent-map.test.js`: activate via `helper.js`; `send` a message `Add login\nmore` (stub `client`); feed lifecycle `started` for A (`parentToolCallId: 'c1'`) and B (`'c2'`), a `subagent_event` `{id: A, event: {type: 'tool_execution_start', toolName: 'task', toolCallId: 'a-t1'}}`, lifecycle `started` for A1 (`parentToolCallId: 'a-t1'`), progress for A with `recentTools: [{tool:'read',args:'b.ts'},{tool:'grep',args:'x'}]`, `resolvedModel: 'deepseek/v4'`, `toolCount: 9`; then a lifecycle for C whose `parentToolCallId` is unknown. Assert `mapState()`: `lead.task === 'Add login'`; A.parentAgent null, A1.parentAgent === A, C.parentAgent null; A.steps → `[{tool:'grep',args:'x'},{tool:'read',args:'b.ts'}]`, A.model `deepseek/v4`, A.tools 9; after `completed` for B, `B.endedAt` is a number. A `subagent_event` with `type: 'message_update'` posts nothing new.
- [ ] **Step 2:** `npm test` → fails.
- [ ] **Step 3:** Implement. Subscription level `events`, falling back to `progress` when omp rejects it.
- [ ] **Step 4:** `npm test` → pass.
- [ ] **Step 5:** Commit `feat: subagent tree data (nesting, steps, timing)`.

### Task 3: The map tab and the agent chat pane

**Files:**
- Create: `subagent-map.js`, `media/map.js`, `media/map.css`
- Modify: `extension.js` (webview messages ~704-720, `subagentTranscript()` ~474, commands ~2490, tab dispose ~2387), `media/main.js` (card 👁 ~404, Agents bar ~442, remove `showSubagentTranscript` ~456 and its `case`), `package.json` + `package.nls*.json` (command `ompChat.subagentMap`, "Subagent map"), `l10n/vi.json`, `README.md`
- Test: `test/subagent-map.test.js`

**Interfaces:**
- Consumes: `chat.mapState()`, `chat.subagentControl(kind, id, text)`, `chat.title`, `chat.html`-style CSP.
- Produces: `class SubagentMap { constructor(chat); open(focusId?); update(); agentActivity(id); dispose() }` exported from `subagent-map.js`; `ChatProvider.openMap(id?)` (creates `this.map` lazily, reveals); `ChatProvider.transcriptData(id): Promise<{id, agent, status, messages}>` (the body of today's `subagentTranscript`, returning instead of posting).
- Webview → extension messages: `{type:'ready'}`, `{type:'select', id}`, `{type:'steer', id, text}`, `{type:'stop', id}`. Extension → webview: `{type:'state', ...mapState()}`, `{type:'transcript', id, agent, status, messages}`, `{type:'error', id, text}`.

- [ ] **Step 1:** Extend the test: with a fake `createWebviewPanel` (records `postMessage`, exposes `onDidReceiveMessage` callback), `provider.openMap('A')` creates one panel titled `Subagents · OMP Chat`; a second `openMap()` reveals it (no new panel); `ready` posts a `state` with 4 agents; `select A` with `client.request` answering `get_subagent_messages` posts a `transcript` for A; two `agentActivity(A)` calls within 700 ms make one more request, not two; `steer` calls `steer_subagent`, and a rejected request posts `{type:'error', id:'A'}` to the map; disposing the chat disposes the panel.
- [ ] **Step 2:** `npm test` → fails.
- [ ] **Step 3:** Implement `subagent-map.js` (panel in `ViewColumn.Active`, `retainContextWhenHidden`, `localResourceRoots: media`, same CSP/nonce pattern, l10n dictionary inlined like `html()`), `ChatProvider.openMap`, and wire messages (`openMap` from the chat webview, `ompChat.subagentMap` command → `current().openMap()`).
- [ ] **Step 4:** Implement `media/map.js` / `map.css`: lead node on top, children recursively under `parentAgent`; node = status icon, agent, model pill (colour from a 6-colour palette by hash of the provider prefix), timer (`now`-corrected `startedAt`, ticking once a second in the webview, frozen at `endedAt`), task, last 3 `steps` + "+N steps" (`tools - 3`), finished → "Done · N steps · time". Click → select (highlight + `select`). Pane: header (status, agent, model, timer, Stop while running, ✕), messages (first user = task card, later user = "you" bubble, assistant text as markdown via the vendored markdown-it, tool calls as `⎿ name detail`), local pending steers shown until a transcript contains them, input hidden when not running. Layout: CSS grid, `@media (min-width: 900px)` → pane right, else bottom with a drag handle.
- [ ] **Step 5:** `main.js`: 👁 posts `{type:'openMap', id}`; Agents bar header gets an "Open map" button posting `{type:'openMap'}`; delete the transcript sheet.
- [ ] **Step 6:** `npm test` + `node --check` on the new files → pass. Render check: open the map with a fake state in the harness used for screenshots, or in VS Code, at 1200 px and 600 px wide.
- [ ] **Step 7:** README section "Subagent map", Vietnamese strings, commit `feat: subagent map tab with live agent chat`.
