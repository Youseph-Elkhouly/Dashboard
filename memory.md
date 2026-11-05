# AgentManager project memory

Last updated: 2026-11-05

## Purpose and user preferences

AgentManager is a local dashboard for browsing Claude and Codex conversations across selected project folders, sending follow-up prompts, reading replies, and approving proposed file edits.

- Keep the interface compact, minimal, and mostly monochrome.
- Working cards use light yellow, Completed cards light green, and pending approvals flash red.
- Show real session data. Do not introduce fabricated chats or sample agents.
- Keep follow-ups headless. Terminal keystroke injection and macOS Terminal automation were abandoned.
- For Codex sessions already open elsewhere, connect to their existing server when possible. Do not create a competing writer or silently fork a replacement conversation.
- Manual approval should show each proposed file diff before that operation is applied. Include a running session change history; an entire prompt's changes are not collected upfront in a staging workspace.
- Ordinary prompts and verified read-only actions should proceed. Unsupported file-writing operations must be blocked with a visible explanation.
- Keep communication direct. Do the authorized work and distinguish implemented code from live verification.

## Run and restart

From the project root:

```sh
node server.js
```

The default URL is `http://localhost:4178`. `PORT` overrides the port.

After backend changes, stop the running dashboard with **Ctrl+C** in its Terminal and start it again. Then hard-refresh Chrome with **Cmd+Shift+R**. Refreshing Chrome alone does not reload Node's backend code.

`EADDRINUSE` means another process still owns the port. Inspect the current listener rather than reusing an old PID:

```sh
lsof -nP -iTCP:4178 -sTCP:LISTEN
```

Never terminate another Codex process as an automatic way to acquire its session.

## Main files

| File | Responsibility |
| --- | --- |
| `server.js` | Plain Node HTTP server, transcript adapters, project selection, send queues, send status, approvals, and static files |
| `index.html` | Dashboard UI, floating chat windows, transcript polling, composer, image attachments, send status, and diff review |
| `codex-connection.js` | Persistent JSON-RPC connection to the existing Codex app-server through its proxy |
| `proxy-websocket.js` | HTTP Upgrade and WebSocket framing over the raw Codex proxy streams |
| `approval-hook.js` | PreToolUse bridge used by dashboard-launched Claude processes; also contains legacy global Codex hook passthrough |
| `imported-projects.json` | Persisted selected workspace folders |
| `agent-modes.json` | Persisted permission-mode overrides by session ID |
| `tests/codex-connection.test.js` | Simulated shared-server turn and approval lifecycle tests |
| `tests/proxy-websocket.test.js` | Byte-level handshake and WebSocket transport tests |
| `context handoff.md` | Older, detailed project history; some historical implementation descriptions are superseded |
| `graphify-out/` | Existing codebase graph; may lag behind current source |

## Discovery and UI

- Chats appear only after a folder is selected. Match session launch, turn, and recorded tool working directories to that folder or its descendants.
- Claude history comes from `~/.claude/projects/<encoded-cwd>/<session>.jsonl`.
- Codex history comes from `~/.codex/sessions/.../rollout-*.jsonl` in the current adapter. Newer provider persistence formats may require further adapter work.
- Transcripts can exceed a gigabyte. Keep list reads bounded and cached; do not load and parse every full transcript on each poll.
- The browser polls agent state every second. Open chats refresh when transcript modification time advances.
- Conversation history is paginated. Chat, Details, and Files are separate window views.
- Send status lives outside transcript rendering, so status updates cannot overwrite fresh messages with an old cached chat snapshot.

## Follow-up flow

1. The browser posts a prompt and optional images to `POST /api/agents/:id/send`.
2. The server creates a run ID and queues prompts sequentially for the selected session.
3. Claude uses `claude --print --resume=<id>` with structured output and an invocation-specific approval hook.
4. Codex uses `codex app-server proxy` to connect to the shared owner, initializes the protocol, resumes/subscribes to the exact selected thread, waits for an existing active turn, and submits one `turn/start`.
5. `GET /api/sends/:runId` exposes status, streamed Codex output, and the final result. The browser shows the actual reply or a specific error and refreshes transcript history.

Queue acceptance and a zero process exit code are not proof of a provider reply. Require nonempty assistant output and successful provider completion. Preserve explicit authentication, transport, timeout, and provider failures.

Do not automatically retry an uncertain submission after connection loss. It may already have reached the provider. Tell the user to check history before sending again.

Run status, queues, approvals, and change history are currently in memory. Backend restarts lose this state; durable recovery is not implemented.

## Codex errors that drove the current design

### Active writer conflict

`codex exec resume` failed with `thread-store conflict: ... already has an active writer` when the selected thread was open in another Codex runtime. The shared-server adapter replaces that path. Do not restore per-prompt Codex resume subprocesses as an automatic fallback.

### Initialization timeout

The first proxy adapter incorrectly sent newline-delimited JSON directly into `codex app-server proxy`. The proxy forwards raw socket bytes, and the Unix control socket requires a WebSocket HTTP Upgrade handshake.

`proxy-websocket.js` now performs and validates the upgrade, masks client frames, handles fragmented and extended-length replies, responds to ping, and cleans up handshake failures. JSON-RPC `initialize` is sent only after the upgrade succeeds.

The installed Codex CLI inspected during this work was `0.166.0`. Check the current installed CLI/schema when changing protocol fields.

Official protocol reference: <https://developers.openai.com/codex/app-server>

## Manual approval

- Codex Manual turns request a read-only sandbox, `on-request` approval, and the user as reviewer. Confirm these settings before submitting the prompt; fail clearly if the owner cannot confirm enforcement.
- Native proposed `fileChange` items supply the diffs for the dashboard review. Allow sends a one-shot `accept`; Deny sends `decline`. Do not grant session-wide approval.
- Bind approvals to the exact thread, turn, item, and server request. Another client's decision, connection loss, expiry, or turn completion must clear stale approvals.
- Broad write grants and unsupported operations are declined. Report the reason in send status or change history.
- Claude's hook previews recognized Edit/Write/MultiEdit inputs and blocks unpreviewable writes. Known read tools and simple permitted read-only commands may proceed.
- Live verification that real filesystem writes remain unapplied until approval is still outstanding. Simulated protocol tests do not establish this guarantee by themselves.

## Verification status and remaining work

Last completed checks:

```sh
node --test tests/*.test.js
node --check server.js
node --check codex-connection.js
```

All 11 protocol/transport tests passed. Browser JavaScript also passed a syntax check after extraction to a temporary file.

Real attempts from the agent sandbox returned:

- Codex: `Operation not permitted` connecting to the app-server control socket.
- Claude: `Not logged in · Please run /login` with `authentication_failed`.
- Localhost access and signaling the user's dashboard process were blocked by sandbox permissions.

These observations describe the agent execution environment; they do not prove the same restrictions apply to a server launched directly from the user's Terminal.

Still required from the running, updated dashboard:

- Send a real Codex follow-up while the same session remains open elsewhere; verify exactly one new user turn and one actual provider reply without a writer conflict.
- Verify a real Claude follow-up and its authentication behavior in the server's environment.
- Verify a real file edit stays unapplied until Allow, and Deny leaves it unchanged.
- Verify another client's approval resolution, busy-thread queueing, and connection failure in the actual browser flow.

Do not describe these live checks as passed until observed. Record future confirmed outcomes here and keep this root memory file current when architecture or user preferences change.
