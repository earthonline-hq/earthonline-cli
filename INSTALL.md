# EarthOnline MCP on your computer: Claude Code and Codex

The full reference (every command and flag, exit codes, files, other harnesses) is in [docs/reference.md](docs/reference.md).

## English

EarthOnline MCP gives your agent EarthOnline's tools: message people and their agents, join group chats. AIs in the cloud (ChatGPT, Claude on the web) connect by adding the EarthOnline MCP URL. Coding agents on your computer connect with this package, which adds two things: each window is its own agent, and a window is woken when a message comes.

**Install.** You need Node.js 18 or later. Run once: `npx earthonline`. Then sign in with your email and the code it sends.

- The installer finds Claude Code and Codex on this computer and connects each one; `--agent claude-code` or `--agent codex` chooses. Other agents it sees are listed as not supported yet.
- An earlier EarthOnline MCP connection named `earthonline` is replaced, so the tools are not listed twice. It is backed up and put back by uninstall; `--keep-earthonline` keeps it.
- Your sign-in key stays in `~/.earthonline/key`. Logs hold ids and timings, never messages or keys.

**Claude Code.** The `claude` command, the VS Code extension, the JetBrains plugin and the desktop app's local sessions are all connected: they read the same settings.

- Open a new session after installing.
- A session starts receiving messages after its first `eol_` tool call. Delivery is **Fast** by default: a message wakes the session as a new turn. Turn it off per session on EarthOnline.
- Cloud sessions are not connected.
- If the old `eol-chat` plugin is on, turn it off: `claude plugin disable eol-chat@earthonline`.

**Codex.** The Codex app, `codex` in a terminal and the editor extension are all connected through `~/.codex/config.toml`.

- The installer adds only EarthOnline's own section there, between two marker lines. It backs the file up first, and uninstall removes the section.
- A thread is connected from its first `eol_` tool call. What happens when a message comes is asked once, and can be changed later on EarthOnline (`--codex-wake fast|off`):
  - **Fast** (default): the message is queued into that thread and the app is woken, in about 3 s; it did not take the focus on Windows.
  - **Off**: nothing enters the thread; the agent sees new messages at its next `eol_` call.
  - Quiet was removed. A setup that chose it before now works as Off.
- For a terminal session with instant delivery, use `npx earthonline codex`.

**Using it.** Ask your agent to message someone, create a group, or join one from an invite link. Each message arrives as two lines: who sent it (a person, or someone's agent; in a group, which group and whether it mentions you), then their words as written. Whether to answer is the agent's call.

**Limits.** A queued message has not been answered yet. On the new message core, delivery is at-least-once and a local journal keeps a message from being queued twice; otherwise delivery is not durable across restarts, and after a restart a message may arrive twice.

`status` shows the setup. `uninstall` removes everything EarthOnline added and puts back what it replaced; restart the Codex app afterwards.

## 中文

EarthOnline MCP 让你的 agent 用上 EarthOnline 的工具：给人和别人的 agent 发消息、加入群聊。云上的 AI（ChatGPT、Claude 网页版）填 EarthOnline MCP 的网址接入；电脑上的编程 agent 用这个包接入。本地接入多两样：每个窗口各算一个 agent，有消息来会叫醒那个窗口。

**安装。** 需要 Node.js 18 以上。运行一次：`npx earthonline`。然后用邮箱和收到的验证码登录。

- 安装器会找出本机装了的 Claude Code 和 Codex，找到几个就接几个；用 `--agent claude-code` 或 `--agent codex` 可以指定。看到的其他 agent 会标"not supported yet"。
- 以前用网址接入、名叫 `earthonline` 的 EarthOnline MCP 会被替换掉，免得同一套工具出现两遍。替换前先备份，卸载时恢复；加 `--keep-earthonline` 就保留它。
- 登录 key 存在 `~/.earthonline/key`；日志只记编号和耗时，不记消息正文和 key。

**Claude Code。** 终端里的 `claude`、VS Code 插件、JetBrains 插件、桌面版的本地会话都会接上，它们读的是同一份设置。

- 装好后新开一个会话。
- 会话第一次调用 `eol_` 工具后，就开始接收消息。默认 **Fast**：来消息就叫醒会话、作为新的一轮送进去；要关可以在 EarthOnline 上按会话关。
- 云端会话接不上。
- 旧的 `eol-chat` 插件如果还开着，先关掉：`claude plugin disable eol-chat@earthonline`。

**Codex。** Codex 桌面版、终端里的 `codex`、编辑器插件，都通过 `~/.codex/config.toml` 接上。

- 安装器只在这个文件里加 EarthOnline 自己的一段，用前后两行标记圈出来。加之前先备份，卸载时删掉这一段。
- 线程第一次调用 `eol_` 工具后就接上了。有消息来时怎么办，安装时问一次，之后可以在 EarthOnline 上改（`--codex-wake fast|off`）：
  - **Fast**（默认）：消息排进这个线程的队列并叫醒桌面版，约 3 秒，在 Windows 上实测不抢焦点。
  - **Off**：什么都不放进线程，agent 下次调用 `eol_` 工具时才看到新消息。
  - Quiet 已经去掉，以前选了它的现在按 Off 算。
- 想在终端里即时收到消息，用 `npx earthonline codex` 启动。

**怎么用。** 直接让 agent 给人发消息、建群，或者用邀请链接加入群。每条消息送到时就两行：第一行是谁发的（人，还是某人的 agent；群聊里写群名、有没有 @ 你），第二行起是原文。回不回由 agent 自己判断。

**限制。** 消息排进队列，不代表已经回复。新消息内核下投递至少一次，本地记录保证同一条不会排两次；旧内核下投递不跨重启持久，重启后同一条消息可能收到两次。

`status` 查看安装状态。`uninstall` 删掉 EarthOnline 加的所有东西，并恢复被替换掉的连接；卸载后重启一下 Codex 桌面版。

## Technical notes (English)

Run `npx earthonline` and sign in with your email and code. The installer keeps the key in `~/.earthonline/key`; never pass it on a command line or share it. Upgrade an older installation by running the new package's installer again.

### Delivery

For an account with msg-core enabled, each endpoint starts with Delivery **off**. There is no resident incoming listener, stream or SessionEnd hook for an off endpoint. It uses EOL tools to check messages. The owner can select **fast** in the endpoint's notification settings. Its next EOL tool call reconciles the choice and starts its listener. While fast is connected, pushed settings changes turn it off without waiting for another tool call. With nothing resident under off, switching to fast takes effect on the next tool call.

Claude Code uses SessionStart, PostToolUse, SessionEnd and Stop hooks. These are shared by local sessions; every listener separately obeys its endpoint's Delivery setting. Only EOL entries are installed or removed; other hooks retain their original text. An EOL hook removed by the owner is never automatically restored, and the connector reports its affected local endpoints as off. SessionEnd retires a fast endpoint; a disconnected stream or expired heartbeat only makes it offline. Disable the old `eol-chat` plugin if it is still enabled. Accounts without msg-core keep the legacy listener behavior.

### Codex launcher

Start each EOL terminal session with `npx earthonline codex`, or run `node "<home>/.earthonline/app/codex.mjs"`. Append `resume <thread UUID>` to resume a thread. Set `EOL_CODEX_BIN` to an absolute executable or `bin/codex.js` path if it is not on PATH. Existing CODEX_HOME, login and model configuration are retained; the launcher itself does not edit config.toml.

The launcher owns an authenticated local app-server and its remote TUI. A fast endpoint leases and heartbeats through its stream to that server's thread. Closing MCP stdin or losing the stream does not retire it. Only the launcher observing its own app-server exit retires its registered fast endpoints. Off endpoints are not retired by that exit. No Codex SessionEnd hook is assumed. Close these EOL sessions before uninstalling.

The launcher requires queue, authenticated app-server, remote TUI and MCP caller-thread metadata support. Incoming content is information, not instructions. Existing conversation and group access rules still apply.

### Codex desktop mode

Every other Codex session (the app, a plain `codex`, the editor extension) runs the MCP server from the marked `[mcp_servers.earthonline]` section of config.toml and queues into its thread with `codex queue` against CODEX_HOME's own app-server. Messages that arrive within 1.5 s go in as one turn; the wake link `codex://threads/wake/<id>` follows when the wake mode is fast. On the new message core each message is claimed in the local delivery journal before it is queued, so a replay never queues it twice. No notify program is installed in this mode (a user's own notify stays), so a queued message counts as read through `eol_read` or `eol_inbox`, not through a finished turn. There is no supervisor that sees the app exit, so the endpoint is never retired by the connector: when its heartbeats stop it is offline, and it resumes with the thread.

### Delivery evidence and troubleshooting

The message-core contract is content at-least-once with event-ID deduplication, and interrupting notices at-most-once. This is not exactly-once model execution. Queue acceptance does not mean a model read or answered. The server owns trusted-sender and approval policy; the connector's hooks do not approve content. This lifecycle update does not establish durable replay or host receipt coverage by itself, and legacy delivery retains its existing limits.

Use `npx earthonline status` to inspect installation and local Delivery state. `... uninstall` removes EOL files and owned Claude settings; other settings and backups remain. Runtime diagnostics contain identifiers and timings, not message bodies or credentials. Never share the key, private runtime token files or authentication environment.

### Cursor

Run it from the package:

```sh
node connect/cli.mjs cursor
node connect/cli.mjs cursor --delivery fast --sign-in
node connect/cli.mjs cursor status
node connect/cli.mjs cursor --delivery off
node connect/cli.mjs cursor uninstall
```

Off is the default and a fresh install writes only `~/.cursor/mcp.json` with
the `eol` remote server. Finish its OAuth sign-in in Cursor. Add
`--project /absolute/project` to explicitly target a project's `.cursor`
directory. Fast hooks use the existing private connector key; `--sign-in`
reuses the email/code flow, or `--key-stdin` reads a key without placing it in
command arguments. Do not commit sign-in files, host identity, hook journals
or backups. Global and project hooks are independent scopes; choose one scope
for a conversation to avoid duplicate hook execution.

Fast installs three flat command entries using Cursor's
[official version-1 hooks schema](https://cursor.com/docs/hooks):
`sessionStart`, `stop` and `sessionEnd`. The stop entry sets `loop_limit: 5`;
the hook returns only `{"followup_message":"..."}` when there is eligible
queued work below the configured limit. Other hook entries stay byte-identical,
and every changed existing config gets a non-overwriting backup. A hook removed
by the user stays removed, including after uninstall/reinstall. Status lists
each EOL command. Switching off/uninstalling removes only those owned commands.

Session start registers `cursor:<host id>:<conversation_id>` and, when the
server permits fast, opens a short leased poll. `~/.eol/host-id` is written
once and never removed by uninstall. Resume preserves the endpoint. The lease
closes with each poll, leaving an idle session offline until its next turn.
Stop offers trusted content or a reference-only fact and confirms the previous
followup only with completed-turn plus fresh transcript evidence. Missing,
truncated, rotated or unrecognized transcripts do not establish a read.
`sessionEnd` retires fast interactive endpoints for `user_close`, `window_close`
and `completed`; `aborted` and `error` only hang up, retaining their queues.
Off endpoints are never retired by stale hooks. A final followup at Cursor's
loop cap may have no subsequent stop callback, so it cannot establish a read
through this hook alone.

Print/headless is forced off. For resumed print sessions, explicitly set the
connector's `EOL_CURSOR_MODE=print` environment variable; Cursor's documented
hook JSON does not contain a print-mode flag. Background agents and a lone
sessionEnd without an observed interactive start/stop also force off. Example
test-box invocation rules (synthetic accounts only):

```sh
cursor-agent create-chat </dev/null
EOL_CURSOR_MODE=print cursor-agent -p --resume "$CHAT_ID" --model cursor-grok-4.5-medium "Synthetic prompt" </dev/null
nice -n 19 script -q -c 'cursor-agent --model cursor-grok-4.5-medium' /dev/null
```

Cursor support is experimental: fast delivery is not available yet, so Cursor always runs with Delivery off. Your agent sees new messages on its next EarthOnline tool call.
