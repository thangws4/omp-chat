# OMP Chat by DT

An AI coding chat for VS Code, in the spirit of Claude Code and GitHub Copilot Chat. It runs the open-source [oh-my-pi](https://github.com/can1357/oh-my-pi) agent (`omp`), which reads your code, edits files and runs commands. It works with low-cost and free models from OpenCode, OpenRouter and DeepSeek, using your own API keys.

- Chat panel with Markdown answers, collapsible thinking, and a compact row for every tool the agent runs
- Asks before it edits files or runs commands, with four approval modes
- Inline diffs for every changed file, plus **Undo**; review in the editor with **Accept** / **Reject** per change
- Sends the open file or your selection with your message; `@` mentions files; paste or drop images
- `/` commands, a model picker, several API keys per provider, and automatic key switching when a limit is hit
- Usage and limits: context fill, 5-hour / weekly / monthly plan windows, free-model quota
- Conversations are saved and resume after a reload

---

## 1. Requirements

| | |
|---|---|
| VS Code | 1.85 or newer |
| [Bun](https://bun.sh) | 1.4.4 or newer (omp runs on Bun) |
| omp | `bun install -g @oh-my-pi/pi-coding-agent` |
| An API key | From one of the providers in [section 3](#3-connect-a-provider) |

You do not have to install Bun or omp by hand: if omp is missing, the panel offers to install it (see [section 2](#2-install)).

## 2. Install

### 2.1 The extension

**From a `.vsix` file** (the usual way to share it):

1. Build the package once, in the extension folder:
   ```bash
   npx @vscode/vsce package --allow-missing-repository --skip-license
   ```
   This creates `omp-chat-0.1.0.vsix`.
2. In VS Code: `Ctrl+Shift+P` → **Extensions: Install from VSIX…** → pick the file.
3. Reload VS Code when asked.

**From source** (to try or change it): open the extension folder in VS Code and press **F5**. A second VS Code window opens with OMP Chat loaded.

### 2.2 omp

Open the **OMP Chat** view (the pixel-cat icon in the Activity Bar). If omp cannot be found, the chat shows:

> omp (oh-my-pi) was not found. OMP Chat needs it to run the agent.  
> **[Install omp] [Set path…] [Retry]**

- **Install omp** opens a terminal and runs the install. You can watch it there and stop it if you want.
  - If Bun is already installed: `bun install -g @oh-my-pi/pi-coding-agent`
  - If not: Bun's official installer runs first (`irm bun.sh/install.ps1 | iex` on Windows, `curl -fsSL https://bun.sh/install | bash` on macOS/Linux), then omp.
- When the terminal is done, click **Retry**. You do not need to restart VS Code: OMP Chat finds a freshly installed omp even if it is not on VS Code's PATH yet.
- **Set path…** is for an omp installed somewhere unusual: enter the full path to the `omp` executable.

To install by hand instead:

```bash
# Windows (PowerShell)
irm bun.sh/install.ps1 | iex
bun install -g @oh-my-pi/pi-coding-agent

# macOS / Linux
curl -fsSL https://bun.sh/install | bash
bun install -g @oh-my-pi/pi-coding-agent
```

Check it with `omp --version`.

## 3. Connect a provider

The first time you open the panel, a **Connect a model provider** form appears at the top of the chat. Pick a provider, paste a key, and optionally give the key a name (for example `work`). Press **Skip** if omp already has a login of its own; you can add keys later from the **…** menu → **Set API Key…**.

| Provider | What you get | Get a key |
|---|---|---|
| **OpenCode Go** | $10/month plan with many models (DeepSeek V4.1 Flash, Kimi, GLM, Qwen, MiniMax…). Limits per 5 hours, week and month | https://opencode.ai/go |
| **OpenCode Zen** | Pay-per-use gateway. Its `-free` models are meant for the OpenCode app: used from other tools such as omp, the free allowance runs out quickly | https://opencode.ai/console |
| **OpenRouter** | Hundreds of models; `:free` models cost nothing (50 requests/day, 1,000 after buying $10 of credits) | https://openrouter.ai/keys |
| **DeepSeek** | DeepSeek's own API, pay per token | https://platform.deepseek.com/api_keys |

OpenCode Go and OpenCode Zen use the same OpenCode key (create it at https://opencode.ai/console with the **Models: Request** permission, plus **Usage: Read** for the usage panel). Every `opencode-go/…` model needs the Go subscription, including the ones whose names end in `-free`; the model list marks them **Go plan**. Prices and free offers change often, so check the provider's page.

After you save a key, OMP Chat switches to a default model of that provider if the current model has no key, and restarts omp so it picks up the key. Your conversation is kept.

## 4. Using the chat

### Asking

Type in the box at the bottom and press **Enter** (**Shift+Enter** for a new line). While the agent works, the send button turns into ■ **Stop** (same spot, like Claude Code); start typing and it turns back into send, which queues your message. **Esc** also stops the agent.

While the agent is working, a new message is **queued**: it waits above the box, marked *Queued*, until the agent can take it, then moves into the conversation. Use ↑ to hand it to the running turn right away, or ✕ to take it back into the box.

When the agent keeps a to-do list, it is pinned above the box (**Todos 2/5**): ✓ done, ⟳ in progress, ○ to do. Click the header to fold it.

The bar under the box is laid out like Claude Code's: on the left the approval mode and the open file; on the right the context ring, the model with its effort (`deepseek-v4-flash · high`), `/` for commands, `@` to mention a file, and send. In a narrow sidebar the labels fold into icons; their tooltips still say everything.

| In the message box | What it does |
|---|---|
| 👁 file name in the bar | The open file is sent with your message. If you select code, it shows the line range and the selected code is sent. Click it to leave the file out (struck through) or put it back; a newly opened file is included again |
| 📌 next to the file name (on hover) | Keeps that file attached to every message, even after you switch files. Pinned files show as their own chips; ✕ removes one. Also: right-click a file in the Explorer (or an editor tab) → **Add File to OMP Chat** |
| `@` | Lists workspace files as you type (`@cal…`). **↑ ↓** to move, **Enter** or **Tab** to insert, **Esc** to close. The `@` button does the same |
| `@problems` | Sends the errors and warnings from VS Code's **Problems** panel with your message |
| `@terminal` | Sends the recent output of the active terminal (copied through the clipboard, which is put back afterwards) |
| `@git` | Sends what you have not committed yet: `git status` and the diff against `HEAD` |
| `@src/` | A folder: omp sends the list of its files. Folders are in the `@` list too |
| `@https://…` | Fetches the page and sends it as text (up to 3 links per message, 20,000 characters each) |
| Images | Paste with **Ctrl+V**, drop onto the box, or use the 🖼 button. Up to 5 per message; large images are scaled down. The model must support images |
| `/` | Lists omp's slash commands, for example `/session`, `/compact`, `/retry`, `/mcp` |
| `!` | Runs the rest as a shell command in the workspace (the box switches to shell mode). See [Terminal](#terminal) |
| `#` | Saves the rest of the line to the project's memory (`AGENTS.md`) instead of sending it. See [Memory](#memory) |
| ↑ / ↓ in an empty box | Brings back the messages you sent before, like a shell. What you are typing is kept if the window reloads |

The suggestions on the start screen (**Explain this file**, **Find and fix bugs**, **Write tests**) send a ready-made request about the open file.

In replies, a file path such as `src/app.ts:42` is a link: click it to open the file at that line. Code blocks have **Insert at cursor** (into the editor you were last in), **Open in new file** and **Copy**.

Under each finished reply: 📋 copies the whole answer as Markdown, followed by what the turn used, for example `13k in · 312 out · $0.0021 · 14s` (tokens sent and received, cost as priced by omp, time).

### From the editor

- Right-click in a file: **Ask OMP Chat** (opens the chat with the file or selection attached), **Explain with OMP Chat** (when code is selected) and **Fix with OMP Chat**.
- On a red or yellow squiggle, the light bulb (**Ctrl+.**) offers **Fix with OMP Chat**: the problems on that line go to the agent.

### Agent status at a glance

You can see what the agent is doing even with the panel closed:

| | Panel title | Activity Bar icon | Status bar |
|---|---|---|---|
| Waiting for you (an approval or question is open) | 🔴 waiting for you | badge ① | **OMP: needs you** (highlighted) |
| Working | 🟡 working | | OMP: working |
| Finished while the panel was hidden | 🔵 done | badge ① | OMP: done |
| Idle | | | hidden |

Click the status bar item to open the chat (with several chats, the one that needs you). Opening the panel clears "done".

### Approvals

The agent can always read files. Whether it must ask before changing anything depends on the mode in the box's toolbar. **Shift+Tab** cycles through them.

| Mode | Asks before |
|---|---|
| **Ask before edits** (default) | Every file change and every command |
| **Ask & remember** | The same, but you can approve a file or folder for the rest of the session |
| **Auto-approve edits** | Commands only |
| **Full auto** | Nothing |
| **Plan (read-only)** | Nothing: every edit and command is refused. The agent studies the code and writes a plan |

In **Plan** mode the agent writes the plan as numbered tasks (what to do, files, how to check it, how hard it is, what it depends on). When the plan is written a card asks **Execute, ask before edits**, **Execute, auto-approve edits**, **Split across subagents** or **Keep planning**. Executing switches to that mode and asks the agent to carry out the plan in the same conversation.

**Split across subagents** makes the agent the lead: each task goes to its own subagent with a self-contained brief, tasks that do not depend on each other run in parallel, and the lead then reviews the changes together, runs the checks and sums up per task. Edits are auto-approved; commands still ask.

Each task runs on the model that suits it, picked from **your models** (★ in the model list) plus the one in use: the strongest for design or tricky debugging, a faster or cheaper one for search, docs or small edits, each with its own effort. OMP Chat allows exactly those models for subagents (omp's `task.perCallModel`, set for this run only; omp's own settings are not changed), and each subagent card shows the model it runs on. Star at least one model besides the current one to use this; changes to your models apply the next time omp starts (executing a plan restarts it).

A request shows as a card in the chat, for example **Allow tool: edit — File: calc.py** with **Approve / Approve edit for this session / Deny**. Once answered it shrinks to one line. Changing the mode restarts omp and keeps the conversation.

**Allowed commands**: commands you trust run without a card, in every mode except Plan. A command's card offers **Always allow** *pattern* (its first two words and anything after, e.g. `npm test*`), which adds the pattern to `ompChat.allowedCommands`; edit that setting to change or remove patterns. A pattern must match the whole command, `*` matching anything. A command with `&&`, `|`, `;`, `$(…)` or `>` always asks, and so does one omp flags as dangerous.

When omp needs a typed answer (a name, a piece of text), the card has a text box; multi-line boxes submit with **Ctrl+Enter**.

### Changes to your files

Every tool the agent runs is a compact row (✓ done, ✕ failed); click it to see the output. Edited files are listed under **N files changed** with the number of added and removed lines:

- **Show changes**: the diff inside the chat
- File name: opens the file for review in the editor. Added and changed lines are highlighted; a line where something was removed shows "−N removed", and hovering it shows the old text. **Accept** / **Reject** above each change keep it or put it back; **Accept all** / **Reject all** at the top settle the whole file. Rejected parts are saved to disk, and the agent is told with your next message. The review lasts until every change is settled (or VS Code reloads).
- Diff button: VS Code's side-by-side diff
- **Undo**: puts the file back as it was before that edit (a file the agent created is deleted). If the file changed again afterwards, OMP Chat asks first. The agent is told about the undo with your next message.

### Subagents

omp can hand parts of a job to **subagents** (its `task` tool): helpers with their own context, such as `scout` (fast read-only exploration), `reviewer`, `security-reviewer`, or agents you define in `.omp/agents/*.md` (project) or `~/.omp/agent/agents/*.md` (yours). They often run in the background while the main agent keeps going.

- Each one gets a **card** under the *Delegated to* row: its type, name, the job, what it is doing right now, time and tool count. The left edge is yellow while it runs, green when done, red if it failed.
- 👁 **View** opens its own conversation (brief, tool calls, outputs, answer); refresh to follow it while it runs.
- 💬 **Steer** sends it an extra instruction; ■ **Stop** cancels just that subagent.
- While any run, a **Subagents** bar sits above the input (click a row to jump to its card) and the status bar reads *OMP: working · N subagents*.

### Terminal

- **Commands the agent runs** show as **Ran** *command* rows. While a command runs, its output streams into the row; when it finishes the row folds (click to open it again). In the default mode the agent asks before running any command.
- **Your own commands**: start a message with `!`, for example `!npm test`. The command runs in the workspace and shows on your side of the chat with its output and exit code (■ stops it). The command and its output become part of the conversation, so the agent sees them with your next message.
- **Run in terminal** (⌨ on any command row or `!` block) runs the same command in VS Code's terminal **OMP Chat**, to watch it or answer its prompts.

### Models

Click the model name in the toolbar to open the model list. Its **Effort** row sets how much the model thinks before answering: `low`, `medium`, `high` (the default) or `max`, as in Claude Code; the choice shows after the model name and applies to the running conversation. Models without reasoning ignore it. Type to filter (`free`, `deepseek`, `kimi`…). Badges say **free**, **Go plan** (needs the OpenCode Go subscription) or **used up** (free allowance spent, with the time until it resets).

**Your models**: the model list in the chat shows only your models (★) plus the one in use. **Manage models…** (last entry of that list, or **…** → **Manage Models…**) shows every model omp can run, with a filter (try `free`, `deepseek`, `kimi`): click ☆ to add a model to your models, **Use** to switch to it. Your models sit on top, where ↑ ↓ set their order and ✕ removes one. Your models are kept across workspaces.

Keyboard in **Manage models…**: **↓** from the filter into the list, **↑ ↓** to move, **Enter** to use a model, **Space** to star or unstar it, **Alt+↑ ↓** to reorder your models, start typing to filter again, **Esc** to close. The filter text is remembered.

Switching models keeps the conversation: the next message continues it on the new model. If the new model's provider has no key yet, OMP Chat asks you to add one first.

### Rewind

Hover over one of your messages and click ↶ to go back to just before it:

- **Rewind conversation**: the conversation continues from before that message, and the message returns to the box so you can edit and resend it.
- **Rewind and restore code**: the same, and every file change the agent made from that message on is undone, newest first. The agent is told which files were restored.

The longer conversation is kept as an earlier chat (🕘). In a reopened conversation, files the agent *created* with the write tool cannot be restored (their earlier state was not recorded); edits can.

### Conversations

- Reloading the window reopens the last conversation of the workspace. If the agent was in the middle of a turn when the window closed, the chat says so and offers **Continue**.
- **+** (title bar) starts a new chat.
- **🕘** (title bar) lists earlier conversations of this workspace; type to filter, **Enter** to open. Their diffs and **Undo** buttons work again. ✏ (**F2**) renames a conversation, 🗑 (**Del**) moves it to the trash.
- **…** → **Export Chat as Markdown** opens the conversation as a Markdown document (your messages, replies, tool calls and shell commands) to save or share.

Conversations are stored by omp in `~/.omp/agent/sessions/`.

When the context window is 80% full, the chat suggests **Compact now** (`/compact`): omp replaces the older part of the conversation with a summary and frees the space.

### Several chats at once

Like running several agents side by side in herdr, you can have more than one chat working at the same time. Each has its own omp and conversation.

- **…** → **Open Chat in New Tab**: a chat in an editor tab, next to your code. Its title shows its state (🟡 working, 🔴 waiting for you, 🔵 done); its tab bar has New chat, Chats and Usage.
- **…** → **New Chat in Git Worktree…**: the same, but the chat works on its own branch, checked out in a separate folder next to the project (`<project>.worktrees/<branch>`), so its edits never touch your files or another chat's. When you close the tab, a worktree with no changes is removed with its branch; one with changes is kept so you can review and merge the branch.
- **…** → **Show All Chats** lists every chat with its state and model; pick one to go to it.
- The status bar sums them up (*OMP: needs you · 2 chats*); clicking it goes to the chat that needs you.
- Tabs come back after a reload with their conversation.
- Settings (model, approval mode, keys) are shared by all chats.

### Notifications

When a chat asks for your answer while it is hidden or VS Code is in the background, or finishes while VS Code is in the background, a VS Code notification says so, with **Open**. Turn it off with `ompChat.notifications`.

### Memory

Start a one-line message with `#` to save a note for the agent instead of sending it, as in Claude Code: `# use pnpm, not npm`. It is added to the project's `AGENTS.md` (or `CLAUDE.md`, if that is the one the project has), which omp reads at the start of every conversation. The current conversation is told right away.

## 5. API keys and limits

### Several keys

**…** → **Set API Key…** opens the key list in the panel. For each provider you can:

- **Add** a key (the newest becomes the active one)
- **Use** another key; omp restarts with it and the conversation continues
- **Rename** (pencil) or **Remove** (bin; click twice to confirm)

When a request fails because a limit or credit ran out (HTTP 429 / 402, "rate limit", "quota"…), OMP Chat moves to the provider's next key, restarts omp on the same conversation and retries the turn with `/retry`. When every key is spent, it offers **Choose another model**, **Manage keys** and **Usage & limits**.

### Usage & limits

Open it with the 📊 button in the title bar or the context ring in the toolbar (with the OpenCode Go plan it also shows `5h 37%`; hover for the numbers).

| Section | Shows |
|---|---|
| This chat | Model calls, tool calls, tokens (in / out / cached), cost, context window fill |
| OpenCode Go plan | 5-hour, weekly and monthly usage with the time until each resets |
| Today (UTC) | OpenRouter free-model requests used out of your daily quota |
| OpenRouter account | Credits used today / this month / in total, key limit |
| DeepSeek account | Balance |
| API keys | Every saved key of the current provider with its own usage, and a **Use** button |

Account figures need the key saved in OMP Chat (keys that only omp knows about cannot be read).

## 6. Plugins, skills and MCP

### Plugins & skills panel

The 🧩 button in the title bar (or **OMP Chat: Plugins & Skills**) lists every skill the agent can use here, grouped by where it comes from: your own skills, the project's, and each installed Claude Code plugin (omp picks those up automatically).

- **Switch a plugin on or off** with its toggle, or open it (›) to switch single skills. A half-filled toggle means some of its skills are on.
- **Filter** by name or description.
- **Apply** restarts the agent with your choice and keeps the conversation. The choice applies to this workspace only; Claude Code's and omp's own settings are not changed.
- **Auto-pick skills for each message**: switched-on skills are always offered to the agent, which chooses among them (as in Claude Code). With auto-pick on, OMP Chat also names up to three skills that match your request (it understands common Vietnamese requests too), and shows *Auto-picked skills: …* in the chat. When the agent opens a skill, its row reads **Using skill** *name*.

### Your own commands

A command is a saved prompt you send by typing `/name`. **…** → **Custom Commands…** (or **Your commands…** at the end of the `/` list) shows them:

- **New command…**: a name, a description, an optional argument hint and the prompt. `$ARGUMENTS` in the prompt is replaced by what you type after the name, so `/review src/app.ts` sends the prompt about that file.
- **Save for** this project (`.omp/commands/<name>.md`, can be committed and shared with your team) or all projects (`~/.omp/agent/commands`).
- Each command has **Use** (puts it in the message box), ✏ (opens the file to edit) and 🗑 (click twice; the file goes to the trash).

Claude Code commands (`.claude/commands/*.md`) are listed and work too.

### MCP servers

**…** → **MCP Servers…** lists the servers in this project (`.omp/mcp.json`) and in your user settings:

- the switch turns a server on or off, ▷ tests the connection, 🗑 removes it (click twice);
- **Add server…** takes a name and either a command (a local server, e.g. `npx -y @modelcontextprotocol/server-filesystem .`) or a URL (a remote server);
- servers start with the agent, so after a change **Restart agent to apply** (the conversation is kept).

Servers that need a browser sign-in (OAuth) have to be authorized once in omp's terminal app.

### Commands

These come from omp and work through `/` commands in the chat:

| Command | |
|---|---|
| `/marketplace add <source>` then `/marketplace install <plugin>` | Plugins from marketplaces; omp reads Claude Code-style marketplaces (`marketplace.json`) and `.claude/plugins` |
| `/plugins list`, `/plugins enable <name>`, `/plugins disable <name>` | Manage installed plugins; `/reload-plugins` reloads them |
| `/skill:<name>` | Run a skill. Skills in `~/.claude/skills` and the project's `.claude/skills` show up automatically |
| `/mcp add`, `/mcp list`, `/mcp test` | MCP servers |

Type `/` to see everything available on your machine.

## 7. Settings

**Language**: the panel, menus and settings follow VS Code's display language. Vietnamese is included (**Configure Display Language** → Tiếng Việt, then reload). Your messages, the agent's replies and code are never translated.


| Setting | Default | |
|---|---|---|
| `ompChat.model` | `openrouter/baidu/ernie-5.5-flash-preview:free` | Model as `provider/model`; the model picker writes this |
| `ompChat.thinkingLevel` | `high` | Effort: `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Also the **Effort** row of the model list; it applies to the running conversation |
| `ompChat.notifications` | `true` | Notify when a chat needs you or finishes while you are elsewhere |
| `ompChat.announceSteps` | `true` | The agent says what it is about to do before it uses tools, gives short updates while it works and sums up at the end, as in Claude Code (added to omp's system prompt; a `--append-system-prompt` in `extraArgs` replaces it) |
| `ompChat.approvalMode` | `always-ask` | `always-ask`, `always-ask-cached`, `write`, `yolo` or `plan` (the toolbar modes above) |
| `ompChat.allowedCommands` | `[]` | Commands that run without asking, e.g. `["npm test*", "git status"]`. See [Approvals](#approvals) |
| `ompChat.ompPath` | `omp` | Path to the omp executable |
| `ompChat.extraArgs` | `[]` | Extra omp command-line arguments |

## 8. Commands and shortcuts

| Command (`Ctrl+Shift+P`) | Also in |
|---|---|
| OMP Chat: Open | Activity Bar icon |
| OMP Chat: New Chat | **+** in the title bar |
| OMP Chat: Show Chats… | **🕘** in the title bar |
| OMP Chat: Usage & Limits | **📊** in the title bar |
| OMP Chat: Plugins & Skills | **🧩** in the title bar |
| OMP Chat: Choose Model… | Model name in the toolbar, or **…** menu |
| OMP Chat: Manage Models… | **…** menu, or "Manage models…" in the model list |
| OMP Chat: Set API Key… | **…** menu |
| OMP Chat: Export Chat as Markdown | **…** menu |
| OMP Chat: Custom Commands… | **…** menu, or the end of the `/` list |
| OMP Chat: MCP Servers… | **…** menu |
| OMP Chat: Add File to OMP Chat | Right-click a file in the Explorer or an editor tab |
| OMP Chat: Ask / Explain / Fix with OMP Chat | Right-click in the editor; Fix also in the light bulb |
| OMP Chat: Stop Agent | **■** / **Esc** |
| OMP Chat: Open Chat in New Tab | **…** menu |
| OMP Chat: New Chat in Git Worktree… | **…** menu |
| OMP Chat: Show All Chats | **…** menu, or the tab's title bar |
| OMP Chat: Go to the Chat That Needs You | Status bar item |

| Key | Anywhere |
|---|---|
| Ctrl+Alt+O (⌘⌥O) | Open the chat |
| Ctrl+Alt+A (⌘⌥A) | In the editor: ask OMP Chat about the file or selection |

Change them in **Keyboard Shortcuts** (search `OMP Chat`).

| Key | In the message box |
|---|---|
| Enter / Shift+Enter | Send / new line |
| `!` at the start | Shell mode: run the message as a command |
| ↑ / ↓ | Earlier messages you sent (in an empty box) |
| Shift+Tab | Next approval mode |
| Esc | Stop the agent (or close an open list) |
| ↑ ↓, Enter, Tab | Move and pick in `/`, `@`, model and chat lists |

## 9. Troubleshooting

| You see | What to do |
|---|---|
| "omp (oh-my-pi) was not found" | Use **Install omp**, then **Retry**; or **Set path…** |
| "401 … invalid" or "No API key found" | The key is wrong or missing: **…** → **Set API Key…** |
| "… needs a *Provider* key" after picking a model | Add a key for that provider; the conversation continues on that model |
| "429", "rate limit", "quota" | OMP Chat switches keys by itself; add another key, wait for the reset shown in **Usage & limits**, or pick another model |
| "Free usage limit reached … (FreeUsageLimitError)" | The OpenCode free allowance of your account is used up. Keys of the same account share it, so OMP Chat does not switch keys; the message says when it resets. Pick another model meanwhile |
| "403 An active OpenCode Go subscription is required" | `opencode-go/…` models need the Go plan. Subscribe, or pick a model from another provider |
| The reply says a file was created, but it is not there | The model only described the change without calling a tool (common with small free models). OMP Chat flags this when it can. Ask again ("use the write tool to create it") or pick a stronger model |
| The model ignores images | Pick a model that accepts images (the model list on the provider's site says so) |
| Nothing happens / blank panel | `Ctrl+Shift+P` → **Developer: Reload Window**. For details, **Developer: Open Webview Developer Tools** → Console |

## 10. Privacy

- API keys are kept in VS Code's encrypted Secret Storage and handed to omp as environment variables. They are sent only to the provider they belong to.
- Your messages, the files the agent reads, and attached images go to the model provider you selected. Check each provider's data policy; some free models may use requests for training.
- Conversations are stored locally by omp in `~/.omp/agent/sessions/`.

## Credits

- Agent: [oh-my-pi](https://github.com/can1357/oh-my-pi)
- Icons: [VS Code Codicons](https://github.com/microsoft/vscode-codicons) (CC BY 4.0), bundled in `media/vendor/codicons`
- Markdown: [markdown-it](https://github.com/markdown-it/markdown-it) (MIT), bundled in `media/vendor`
