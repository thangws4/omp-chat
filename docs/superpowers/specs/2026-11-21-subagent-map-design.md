# Subagent map: design

Date: 2026-11-21 · Status: approved in chat, waiting for the written review

## Why

When the lead model hands work to subagents, omp-chat shows one flat card per subagent, each with a single "doing now" line. You cannot see who delegated to whom, which model runs what, how long each job has taken, or what an agent has done so far. Correcting an agent mid-run means a small input box on its card, and reading its work means a read-only transcript you have to refresh. The user wants what Claude Code's extension gives: a live tree of the agents and their steps, plus a way to watch one agent and steer it in time. They also want the lead model to spread work over the models they starred (★, possibly from different providers) on its own, not only after "Split across subagents" on a plan.

## Goals

1. **Subagent map tab:** an editor tab that fills the whole editor area and shows the run as a tree diagram:
   - the lead model at the top: its model, the current task, and the total time
   - a node for each subagent beneath the agent that spawned it (nested agents under their parent): status (running / done / failed / stopped), the model it runs on, coloured per provider, the task it was given, a live run-time counter, and its 3 latest steps followed by "+N steps"
   - a finished node collapses to "Done · N steps · time"
2. **Agent chat pane:** clicking a node highlights it and opens that agent's chat inside the same tab:
   - **on the right when the tab is wide, sliding up from the bottom when it is narrow**, switching on its own as the tab is resized
   - contents: the task it was given, what the agent says, and each tool step, **updated live** (no refresh button) and following the newest step
   - an input box at the bottom to send it an instruction while it runs (steer), and the messages you sent shown in the conversation
   - a Stop button, and ✕ to close the pane and give the whole tab back to the map
   - when the agent has finished, the input is hidden and the pane only shows what happened
3. **The lead delegates by itself:** in every chat, not only after "Split across subagents", the lead model knows which ★ models it may hand tasks to and picks one per task to suit the work. It decides by itself whether to split the work at all.

## Non-goals

- No change to how subagents run, are approved or are stopped in omp.
- The in-chat subagent cards and the "Subagents · N running" bar stay as they are, apart from the entry points listed below.
- No history of past runs in the map. It shows the current run, kept until your next message.

## Anti-goals (failure even if it works)

- The map tab steals focus or opens by itself while you type.
- A busy run (several agents streaming) makes the chat panel or VS Code sluggish.
- The lead calls a model the user did not star, or ignores ★ and delegates everything to the current model.

## Decisions

Decided by the user:
- the tab fills the whole editor area, it is not a panel inside the chat
- a tree diagram (mock-up A) combined with an agent chat pane (mock-up C); the pane sits on the right or at the bottom depending on the tab width
- 3 latest steps per node plus "+N steps"
- the lead model decides on its own when to split and which ★ model to use

Claude's calls (the user can overrule):
- **Opening the tab:** an "Open map" button on the "Subagents · N running" bar, an `OMP Chat: Subagent map` command, and the existing 👁 button on a subagent card (it opens the map with that agent's pane) instead of the read-only transcript sheet. The tab never opens by itself.
- **One map per chat:** each chat tab (multi-chat) has its own map tab, titled `Subagents · <chat title>`. Opening it again reveals the existing tab.
- **Nothing ran yet:** with no subagents, the map shows the lead node and a line saying the lead will delegate when a task suits it.
- **Width breakpoint:** pane on the right at a tab width of 900 px or more, otherwise at the bottom with a draggable height.
- **Provider colour:** taken from the model id's provider prefix, from a small fixed palette; the same provider always gets the same colour.
- **The lead's task:** the first line of your latest message; its time counts from when you sent it until the turn ends.
- **After a VS Code reload:** the map starts empty (subagent records live in memory only) and fills with the next run.

## How (facts the builder needs)

### Data from omp

- omp's RPC already sends `subagent_lifecycle` and `subagent_progress`; the extension subscribes with `set_subagent_subscription` at level `progress` (`extension.js`, `onSubagent`). The progress record (`AgentProgress`) carries `recentTools` (newest first, at most 5, `{tool, args}`), `toolCount`, `durationMs`, `resolvedModel`, `lastIntent`, `currentTool` and `currentToolArgs`.
- **Parent of a nested agent:** each payload has `parentToolCallId`, the id of the `task` tool call that spawned it. For top-level agents it is a call of the lead (already used to place the cards under their task row). For nested agents it is a call made **inside another subagent**. omp sends nested agents' frames to the root session (shared `subagentEventBus`). To map a call id to the subagent that made it, raise the subscription to level `events`: `subagent_event` frames (`{id, event}`) carry each subagent's own session events, including tool-call starts with their `toolCallId`. Record `toolCallId → subagent id` for `task` calls and drop the other events early, so the stream costs little.
- **Live chat:** while a pane is open, refetch `get_subagent_messages` for that agent when a `subagent_event` or progress frame for it arrives, at most every ~700 ms (trailing call so the last state shows). Reuse `subagentTranscript()`'s simplification (task / assistant text and tool calls / tool output). It already falls back to the agent's session file after a respawn.
- **Steer and stop:** reuse `subagentControl('steer' | 'stop', id, text)`. A steer message is added to the pane straight away as "you" and stays there, since omp's message list may not echo it.

### The tab

- A `vscode.WebviewPanel` in the editor area, with its own small script and CSS under `media/` (the map and the pane). It shares `media/l10n.js` and codicons with the chat panel. All strings go through the existing l10n (add Vietnamese to `l10n/vi.json`).
- The chat provider (one per chat) owns its map panel: it posts the subagent records (it already merges them in `this.subagents`) plus the lead's model, task and start time, and forwards the pane's steer / stop / open-agent messages back to its methods.
- The run-time counters tick in the webview (start time + elapsed), not through a message per second.

### The lead delegates by itself

- `overlayArgs()` already enables `task.perCallModel` and names the ★ pool (`taskModelPool()`: current model plus ★, at most 8) as model roles when the pool has 2 or more models.
- With such a pool, append the model-choice guidance that `delegatePrompt()` builds today (the pool with free / plan tags, "strongest for design and tricky debugging, faster or cheaper for search, docs, small edits", "say which model did each task") to the system prompt, prefixed with "Split work into subagent tasks when it helps; you decide." omp honours only one `--append-system-prompt`, so join it with `ANNOUNCE_STEPS` into a single flag.
- "Split across subagents" keeps sending its own prompt (`DELEGATE_PLAN`), now without repeating the model list.
- The pool is snapshotted at agent start, as today. Starring or unstarring a model takes effect at the next start: say so in the favourites UI if it does not already.

## Left to the builder

- Exact node and pane styling within the mock-ups (`.superpowers/brainstorm/*/content/diagram-ac.html`) and VS Code theme colours.
- How the tree lays out many siblings (wrapping or horizontal scroll), as long as the lead stays on top and children stay under their parent.
- Whether the "+N steps" line opens the pane (recommended) or does nothing.

## Check

The smallest runnable check that proves it: a test (like `test/*.test.js`) feeding lifecycle, progress and `subagent_event` frames for a lead → A → A1 and lead → B run into the provider, asserting the tree it posts to the map (parents, models, step counts), and that the system-prompt flag contains the ★ pool when there are 2 or more starred models and is absent otherwise.
