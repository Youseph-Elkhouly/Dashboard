const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, execFile, spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { CodexConnection } = require('./codex-connection');

const PORT = process.env.PORT || 4178;
const WORKING_MS = 15 * 1000; // fallback only when a transcript has no lifecycle marker
const NEEDS_APPROVAL_IDLE_MS = 12 * 1000; // how long a send can go quiet before we assume it's blocked on an approval

// Chats only appear after their working folder is explicitly selected.
const IMPORTED_PROJECTS_PATH = path.join(__dirname, 'imported-projects.json');

function loadImportedProjects() {
  try {
    const raw = JSON.parse(fs.readFileSync(IMPORTED_PROJECTS_PATH, 'utf8'));
    return new Set(Array.isArray(raw) ? raw.filter(p => typeof p === 'string').map(canonicalPath) : []);
  } catch {
    return new Set();
  }
}
const importedProjects = loadImportedProjects();

function saveImportedProjects() {
  try { fs.writeFileSync(IMPORTED_PROJECTS_PATH, JSON.stringify([...importedProjects])); }
  catch (err) { console.error('Failed to persist selected folders:', err.message); }
}

function canonicalPath(candidate) {
  try { return fs.realpathSync(candidate); }
  catch { return path.resolve(candidate); }
}

function isUnderSelectedFolder(cwd) {
  const resolvedCwd = canonicalPath(cwd);
  for (const folder of importedProjects) {
    const resolvedFolder = canonicalPath(folder);
    if (resolvedCwd === resolvedFolder || resolvedCwd.startsWith(resolvedFolder + path.sep)) return true;
  }
  return false;
}

function matchingWorkspaceDirectory(agent) {
  if (agent.cwd && isUnderSelectedFolder(agent.cwd)) return canonicalPath(agent.cwd);
  const matchingDirectories = (agent.relatedWorkdirs || [])
    .map(canonicalPath)
    .filter(directory => isUnderSelectedFolder(directory));
  return matchingDirectories.sort((a, b) => b.length - a.length)[0] || null;
}

function collectToolWorkdirs(input, baseCwd, directories) {
  const add = value => {
    if (typeof value !== 'string' || !value.trim()) return;
    let candidate = value.trim().replace(/^~(?=$|[/\\])/, os.homedir());
    if (candidate.startsWith('$HOME/')) candidate = path.join(os.homedir(), candidate.slice(6));
    directories.add(canonicalPath(path.isAbsolute(candidate) ? candidate : path.resolve(baseCwd || os.homedir(), candidate)));
  };
  const visit = value => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        if (/^(workdir|working_directory|workingDirectory|cwd)$/i.test(key)) add(nested);
        else visit(nested);
      }
      return;
    }
    if (typeof value !== 'string') return;
    const patterns = [
      /(?:workdir|working_directory|workingDirectory|cwd)\s*[:=]\s*["']([^"']+)["']/gi,
      /["'](?:workdir|working_directory|workingDirectory|cwd)["']\s*:\s*["']([^"']+)["']/gi
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(value))) add(match[1]);
    }
  };
  if (typeof input === 'string') {
    try { visit(JSON.parse(input)); } catch { visit(input); }
  } else {
    visit(input);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function truncate(str, n) {
  if (!str) return '';
  const flat = str.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}

function titleFromPrompt(value) {
  const line = String(value || '').split(/\r?\n/)
    .map(part => part.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^#+\s*/, '').trim())
    .find(Boolean);
  if (!line) return 'Untitled chat';
  const sentence = line.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || line;
  return truncate(sentence.replace(/[`*_~]/g, ''), 72);
}

function relativeTime(ageMs) {
  const s = Math.floor(ageMs / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function stateFromAge(ageMs) {
  if (ageMs < WORKING_MS) return 'Working';
  return 'Done';
}

// --- Sending a prompt into a live session + the approval queue that gates it ---
//
// Headless resume (`claude --resume`, `codex exec resume`) runs with no
// terminal, so there's nothing to approve a tool call. Each spawned
// subprocess is handed a PreToolUse hook (see approval-hook.js) that blocks
// and asks here instead. pendingApprovals is the live queue; inFlightSends
// tracks the subprocess itself so the dashboard can show "Working" the
// instant you hit Send, before any tool call (or hook) has happened yet.
const pendingApprovals = new Map(); // id -> { id, sessionId, agentType, toolName, toolInput, cwd, createdAt, status, reason }
const changeHistory = new Map(); // sessionId -> [{ id, path, diff, status, createdAt }]
const inFlightSends = new Map(); // sessionId -> { pid, startedAt, agentType }
const sendQueues = new Map(); // sessionId -> { agent, messages, running }
const sendRuns = new Map(); // runId -> { status, result, updatedAt }
const codexConnection = new CodexConnection({
  onApproval(request) {
    const id = crypto.randomUUID();
    const preview = { path: request.changes.map(c => c.path).join(', '), diff: request.changes.map(c => `${c.path}\n${c.diff}`).join('\n\n') };
    pendingApprovals.set(id, { id, sessionId: request.threadId, agentType: 'codex', toolName: 'File changes', toolInput: {}, preview, createdAt: Date.now(), status: 'pending', reason: '', rpcKey: request.key });
    const history = changeHistory.get(request.threadId) || [];
    history.push({ id, path: preview.path, diff: preview.diff, status: 'proposed', createdAt: Date.now() });
    changeHistory.set(request.threadId, history.slice(-100));
  },
  onResolved(key, reason) {
    for (const approval of pendingApprovals.values()) if (approval.rpcKey === key && approval.status === 'pending') {
      approval.status = 'resolved'; approval.reason = reason;
      const change = (changeHistory.get(approval.sessionId) || []).find(c => c.id === approval.id);
      if (change) change.status = 'resolved';
    }
  }
});
// approval-hook.js gives up and self-reports 'deny' to its own CLI after its
// own ~280s timeout, but that happens entirely on the hook's stdout — it never
// tells us, so our copy of the request would otherwise sit 'pending' (and the
// dashboard would keep showing "needs approval" for an agent that's long
// since exited) until this sweep finally clears it. Keep this just above the
// hook's timeout so a dead/orphaned request doesn't outlive the agent by long.
const APPROVAL_STALE_MS = 5 * 60 * 1000;

// --- Per-agent permission mode — lets the dashboard auto-decide a PreToolUse
// request instead of always queueing it for a manual click. Named after
// Claude Code's own permission-mode vocabulary since that's what users
// already expect; applied to Codex too via the same tool-name heuristic.
// Persisted to disk (keyed by session id, which is stable across restarts)
// so a chosen mode survives the dashboard process restarting.
const AGENT_MODES_PATH = path.join(__dirname, 'agent-modes.json');
const VALID_MODES = new Set(['default', 'manual', 'auto', 'acceptEdits', 'bypassPermissions', 'plan']);

function loadAgentModes() {
  try {
    const raw = JSON.parse(fs.readFileSync(AGENT_MODES_PATH, 'utf8'));
    return new Map(Object.entries(raw).filter(([, mode]) => VALID_MODES.has(mode)));
  } catch {
    return new Map();
  }
}
const agentModes = loadAgentModes(); // sessionId -> mode

function saveAgentModes() {
  try {
    fs.writeFileSync(AGENT_MODES_PATH, JSON.stringify(Object.fromEntries(agentModes)));
  } catch (err) {
    console.error('Failed to persist agent modes:', err.message);
  }
}

function getAgentMode(id) { return agentModes.get(id) || 'default'; }

const EDIT_TOOL_NAMES = new Set(['edit', 'multiedit', 'write', 'notebookedit', 'apply_patch']);
const READONLY_TOOL_NAMES = new Set(['read', 'glob', 'grep', 'ls', 'webfetch', 'todoread', 'todowrite', 'bashoutput']);
function classifyTool(toolName, input = {}) {
  const n = String(toolName || '').toLowerCase();
  if (['bash', 'exec_command', 'shell', 'shell_command'].includes(n)) {
    const command = input.command || input.cmd || '';
    if (typeof command === 'string' && !/[;&|<>`$\n]/.test(command) && /^(?:pwd|ls|cat|rg|head|tail|wc|git (?:status|diff|log|show))(?:\s|$)/.test(command.trim())) return 'readonly';
  }
  if (EDIT_TOOL_NAMES.has(n) || n.includes('patch')) return 'edit';
  if (READONLY_TOOL_NAMES.has(n) || n.includes('read') || n.includes('grep') || n.includes('glob') || n.includes('list')) return 'readonly';
  return 'other';
}
function makeFilePreview(toolName, input, cwd) {
  const name = String(toolName || '').toLowerCase();
  if (name.includes('patch')) {
    const patch = typeof input === 'string' ? input : input.patch || input.input || '';
    if (typeof patch !== 'string' || !patch.startsWith('*** Begin Patch') || !patch.includes('*** End Patch')) return null;
    const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m => m[1]);
    if (!paths.length) return null;
    return { path: paths.join(', '), diff: patch, previewable: true };
  }
  const file = input.file_path || input.path;
  if (!file || !['edit', 'write', 'multiedit', 'notebookedit'].includes(name)) return null;
  const absolute = path.resolve(cwd || process.cwd(), file);
  let before = '';
  try { before = fs.readFileSync(absolute, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') return null; }
  let after = before;
  if (name === 'write') after = input.content;
  else {
    const edits = name === 'multiedit' ? input.edits : [input];
    if (!Array.isArray(edits)) return null;
    for (const edit of edits) {
      if (typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string' || !edit.old_string || !after.includes(edit.old_string)) return null;
      after = edit.replace_all ? after.split(edit.old_string).join(edit.new_string) : after.replace(edit.old_string, edit.new_string);
    }
  }
  if (typeof after !== 'string') return null;
  const a = before.split('\n'), b = after.split('\n');
  const diff = [`--- a/${file}`, `+++ b/${file}`, ...a.map(line => `-${line}`), ...b.map(line => `+${line}`)].join('\n');
  return { path: file, diff, previewable: true };
}
// Decide a freshly-registered approval automatically when the agent's mode
// says so. Returns { status, reason } — status stays 'pending' when the
// mode doesn't cover this case, preserving today's manual-approval behavior.
function autoDecide(mode, toolName, input = {}) {
  if (mode === 'bypassPermissions') return { status: 'allow', reason: 'Auto-approved — agent is in Full auto mode' };
  if (mode === 'auto') return { status: 'allow', reason: 'Passed through — agent Auto mode applies its own sandbox and approval policy' };
  const toolClass = classifyTool(toolName, input);
  if ((mode === 'manual' || mode === 'default') && toolClass === 'readonly') return { status: 'allow', reason: 'Read-only action allowed' };
  if ((mode === 'manual' || mode === 'default') && toolClass === 'other') return { status: 'deny', reason: 'Cannot safely preview this operation. Use Read/Grep/Glob for inspection and Edit/Write/apply_patch for file changes.' };
  if (mode === 'acceptEdits' && toolClass === 'edit') return { status: 'allow', reason: 'Auto-approved — agent is in Accept edits mode' };
  if (mode === 'plan') {
    return toolClass === 'readonly'
      ? { status: 'allow', reason: 'Auto-approved — read-only in Plan mode' }
      : { status: 'deny', reason: 'Denied — agent is in Plan mode (read-only)' };
  }
  return { status: 'pending', reason: '' };
}

setInterval(() => {
  const now = Date.now();
  for (const [id, a] of pendingApprovals) {
    if (a.status === 'pending' && now - a.createdAt > APPROVAL_STALE_MS && a.rpcKey) {
      try { codexConnection.decide(a.rpcKey, false); } catch {}
      const change = (changeHistory.get(a.sessionId) || []).find(c => c.id === a.id);
      if (change) change.status = 'expired';
    }
    if (a.status !== 'pending' || now - a.createdAt > APPROVAL_STALE_MS) pendingApprovals.delete(id);
  }
}, 30 * 1000);

function findPendingApproval(sessionId) {
  for (const a of pendingApprovals.values()) {
    if (a.sessionId === sessionId && a.status === 'pending') return a;
  }
  return null;
}

const APPROVAL_HOOK_PATH = path.join(__dirname, 'approval-hook.js');

// --- Voice dictation for the chat composer — fully local, no API key, no
// per-request cost. whisper-cli only accepts 16kHz mono WAV, so the browser's
// webm/opus recording is converted with ffmpeg first.
const WHISPER_MODEL_PATH = path.join(__dirname, 'models', 'ggml-base.en.bin');

function transcribeAudio(webmBuffer) {
  return new Promise((resolve, reject) => {
    const stamp = crypto.randomUUID();
    const webmPath = path.join(os.tmpdir(), `agentmanager-dictate-${stamp}.webm`);
    const wavPath = path.join(os.tmpdir(), `agentmanager-dictate-${stamp}.wav`);
    const cleanup = () => { fs.unlink(webmPath, () => {}); fs.unlink(wavPath, () => {}); fs.unlink(`${wavPath}.txt`, () => {}); };
    fs.writeFile(webmPath, webmBuffer, err => {
      if (err) return reject(err);
      execFile('ffmpeg', ['-y', '-i', webmPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath], { timeout: 30000 }, ffmpegErr => {
        if (ffmpegErr) { cleanup(); return reject(new Error('Could not convert recorded audio')); }
        execFile('whisper-cli', ['-m', WHISPER_MODEL_PATH, '-f', wavPath, '--no-timestamps', '-otxt'], { timeout: 60000 }, whisperErr => {
          if (whisperErr) { cleanup(); return reject(new Error('Local transcription failed')); }
          fs.readFile(`${wavPath}.txt`, 'utf8', (readErr, text) => {
            cleanup();
            if (readErr) return reject(new Error('No transcript produced'));
            resolve(text.trim());
          });
        });
      });
    });
  });
}

function codexPermissionArgs(mode) {
  if (mode === 'bypassPermissions') return ['--dangerously-bypass-approvals-and-sandbox'];
  if (mode === 'plan') return ['-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"'];
  // Auto, Accept edits, and Manual approval all keep the workspace sandbox.
  // The AgentManager hook applies the finer per-tool behavior for each mode.
  return ['-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="on-request"'];
}

// Pasted-image attachments: decoded to a temp file so Codex's `-i` flag can
// reference them by path, and so Claude's base64 is already on hand for the
// stream-json content block below. Cleaned up once the resume process exits.
function extFromMime(mimeType) {
  const m = /^image\/(png|jpeg|jpg|gif|webp)$/i.exec(mimeType || '');
  if (!m) return 'png';
  return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
}
function saveImageAttachment(mimeType, base64) {
  const filePath = path.join(os.tmpdir(), `agentmanager-img-${crypto.randomUUID()}.${extFromMime(mimeType)}`);
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return { path: filePath, mimeType: mimeType || 'image/png', base64 };
}

function parseClaudeStreamOutput(raw) {
  const pieces = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'result' && typeof event.result === 'string') pieces.push(event.result);
      else if (event.type === 'assistant') {
        for (const block of event.message?.content || []) if (block.type === 'text' && block.text) pieces.push(block.text);
      }
    } catch {}
  }
  return [...new Set(pieces)].join('\n').trim() || String(raw || '').trim();
}

function parseProviderReply(provider, raw) {
  let reply = '';
  for (const line of raw.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (provider === 'claude') {
        if (event.type === 'result' && !event.is_error && typeof event.result === 'string') reply = event.result;
      } else if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        reply += (reply ? '\n\n' : '') + (event.item.text || '');
      }
    } catch {}
  }
  return reply.trim();
}

async function sendPromptToAgent(agent, message, images = [], runId) {
  if (agent.agentType === 'codex') {
    inFlightSends.set(agent.id, { startedAt: Date.now(), agentType: 'codex' });
    try {
      return await codexConnection.send(agent, message, images, (output, detail) => {
        const run = sendRuns.get(runId);
        if (run) { run.output = output; run.detail = detail || ''; run.updatedAt = Date.now(); }
      });
    } finally {
      inFlightSends.delete(agent.id);
      for (const image of images) fs.unlink(image.path, () => {});
    }
  }
  if (!agent.cwd) return { ok: false, error: 'No working directory known for this agent' };
  const mode = agent.mode || 'default';
  const env = Object.assign({}, process.env, {
    AGENTMANAGER_PORT: String(PORT),
    AGENTMANAGER_AGENT_TYPE: agent.agentType,
    AGENTMANAGER_SESSION_ID: agent.id
  });
  let child;
  let stdinPayload = null;
  if (agent.agentType === 'claude') {
    const claudeMode = mode === 'default' ? 'manual' : mode;
    const hookSettings = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${APPROVAL_HOOK_PATH}"`, timeout: 290 }] }] }
    });
    if (images.length) {
      // Headless --print has no attach-file flag, but --input-format stream-json
      // accepts the same user-message content-block shape as the Messages API,
      // so images ride along as base64 blocks instead of a bare text arg.
      const content = [
        ...(message ? [{ type: 'text', text: message }] : []),
        ...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.base64 } }))
      ];
      stdinPayload = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
      child = spawn('claude', ['--print', `--resume=${agent.id}`, '--permission-mode', claudeMode, '--setting-sources', 'project,local', '--settings', hookSettings,
        '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
        { cwd: agent.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      child = spawn('claude', ['--print', `--resume=${agent.id}`, '--permission-mode', claudeMode, '--setting-sources', 'project,local', '--settings', hookSettings, '--output-format', 'stream-json', '--verbose', '--', message],
        { cwd: agent.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    }
  } else {
    return { ok: false, error: `Sending not supported for agent type "${agent.agentType}"` };
  }

  return new Promise(resolve => {
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-20000); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
    inFlightSends.set(agent.id, { pid: child.pid, startedAt: Date.now(), agentType: agent.agentType });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inFlightSends.delete(agent.id);
      for (const img of images) fs.unlink(img.path, () => {});
      resolve(result);
    };
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const output = parseProviderReply(agent.agentType, stdout);
      const providerError = stdout.split(/\r?\n/).map(line => { try { const e = JSON.parse(line); return e.is_error ? e.result : e.type === 'error' ? e.message : e.type === 'turn.failed' ? e.error?.message : ''; } catch { return ''; } }).filter(Boolean).join('\n');
      finish(code === 0 && output && !providerError
        ? { ok: true, output }
        : code === 0 ? { ok: false, output: '', error: providerError || 'Provider exited without returning an assistant reply.' }
        : { ok: false, error: `Resume process exited (${signal || code})${(providerError || stderr.trim()) ? `: ${(providerError || stderr.trim()).slice(-1200)}` : ''}`, output });
    });
    child.once('error', err => finish({ ok: false, error: err.message, output: stdout.trim() }));
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish({ ok: false, error: 'Provider did not finish within 15 minutes.', output: parseProviderReply(agent.agentType, stdout) }); }, 15 * 60 * 1000);
    child.stdin?.on('error', err => finish({ ok: false, error: `Could not deliver prompt: ${err.message}` }));
    if (stdinPayload) child.stdin.end(stdinPayload);
  });
}

function enqueuePromptForAgent(agent, message, images = []) {
  const runId = crypto.randomUUID();
  let queue = sendQueues.get(agent.id);
  if (!queue) {
    queue = { items: [], running: false };
    sendQueues.set(agent.id, queue);
  }
  const queued = queue.running || queue.items.length > 0;
  sendRuns.set(runId, { status: queued ? 'queued' : 'running', result: null, updatedAt: Date.now() });
  queue.items.push({ agent, message, images, runId });
  if (!queue.running) void drainPromptQueue(agent.id);
  return { ok: true, queued, runId };
}

async function drainPromptQueue(sessionId) {
  const queue = sendQueues.get(sessionId);
  if (!queue || queue.running) return;
  queue.running = true;
  while (queue.items.length) {
    const item = queue.items.shift();
    const run = sendRuns.get(item.runId);
    if (run) { run.status = 'running'; run.updatedAt = Date.now(); }
    let result;
    try { result = await sendPromptToAgent(item.agent, item.message, item.images, item.runId); }
    catch (err) { result = { ok: false, error: err.message }; inFlightSends.delete(sessionId); }
    if (run) { run.status = result.ok ? 'completed' : 'failed'; run.result = result; run.updatedAt = Date.now(); }
    if (!result.ok) console.error(`Follow-up failed for session ${sessionId}: ${result.error}`);
  }
  queue.running = false;
  if (sendQueues.get(sessionId) === queue) sendQueues.delete(sessionId);
}

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, run] of sendRuns) if (['completed', 'failed'].includes(run.status) && run.updatedAt < cutoff) sendRuns.delete(id);
}, 60 * 1000);

function walkFiles(rootDir, maxDepth, matches) {
  const files = [];
  function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < maxDepth) walk(full, depth + 1);
      else if (entry.isFile() && matches(entry.name)) files.push(full);
    }
  }
  walk(rootDir, 0);
  return files;
}

// Session transcripts can be huge (some of this machine's Codex rollouts are
// 100MB-1GB+). The dashboard list only ever needs the first/last handful of
// messages, so reading+parsing a whole gigabyte file on every 4s poll is
// what made the initial load (and every load after it) brutally slow.
// Read bounded head/tail chunks instead, and cache per-file by mtime+size so
// unchanged files — the vast majority on every poll — cost nothing at all.
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;
const listContentCache = new Map(); // filePath -> { mtimeMs, size, data }

function readBoundedText(filePath, size) {
  if (size <= HEAD_BYTES + TAIL_BYTES) return fs.readFileSync(filePath, 'utf8');
  const fd = fs.openSync(filePath, 'r');
  try {
    const headBuf = Buffer.alloc(HEAD_BYTES);
    fs.readSync(fd, headBuf, 0, HEAD_BYTES, 0);
    const tailBuf = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, tailBuf, 0, TAIL_BYTES, size - TAIL_BYTES);
    let head = headBuf.toString('utf8');
    head = head.slice(0, head.lastIndexOf('\n') + 1);
    let tail = tailBuf.toString('utf8');
    const firstNl = tail.indexOf('\n');
    tail = firstNl === -1 ? '' : tail.slice(firstNl + 1);
    return head + tail;
  } finally {
    fs.closeSync(fd);
  }
}

function getListContent(filePath, parseFn) {
  const stat = fs.statSync(filePath);
  const cached = listContentCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { data: cached.data, stat };
  }
  const text = readBoundedText(filePath, stat.size);
  const data = parseFn(text);
  listContentCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, data });
  return { data, stat };
}

const gitBranchCache = new Map();
function resolveGitBranch(cwd) {
  if (!cwd) return null;
  if (gitBranchCache.has(cwd)) return gitBranchCache.get(cwd);
  let branch = null;
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (out && out !== 'HEAD') branch = out;
  } catch { branch = null; }
  gitBranchCache.set(cwd, branch);
  return branch;
}

function finalizeAgent({ id, agentType, cwd, relatedWorkdirs, branch, projectFolderFallback, activityText, promptText, titleText, mtimeMs, filePath, fileSizeBytes, startedAt, model, detectedMode, activityState }) {
  const ageMs = Date.now() - mtimeMs;
  const projectFolder = cwd ? path.basename(cwd) : projectFolderFallback;
  const label = branch || id.slice(0, 8);
  const metaLine = escapeHtml(`$ ${agentType} · branch ${branch || 'main'}`);
  return {
    id,
    name: id.slice(0, 8),
    title: titleFromPrompt(titleText),
    agentType,
    project: projectFolder,
    repo: `${projectFolder} / ${label}`,
    state: activityState || stateFromAge(ageMs),
    cwd,
    relatedWorkdirs,
    branch,
    filePath,
    fileSizeBytes,
    startedAt: startedAt || null,
    model: model || null,
    mtimeMs,
    detectedMode: detectedMode || null,
    time: relativeTime(ageMs),
    lines: [
      metaLine,
      `<span class="bright">${escapeHtml(activityText)}</span>`,
      `<span class="promptline">${escapeHtml(promptText)}</span>`
    ]
  };
}

// --- Claude Code adapter: ~/.claude/projects/<encoded-path>/<session>.jsonl ---

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function extractClaudeText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textBlock = content.find(c => c && c.type === 'text' && typeof c.text === 'string');
    if (textBlock) return textBlock.text;
    const toolUse = content.find(c => c && c.type === 'tool_use');
    if (toolUse) return `Running ${toolUse.name}…`;
  }
  return '';
}

// Claude's own real-time permission mode (what the session is actually
// running under right now — changed via Shift+Tab mid-session, or a launch
// flag) gets written onto every "user" entry as `permissionMode`. Anchored
// on the *last* occurrence (unlike cwd/branch) since this is meant to track
// current state, not where the session started.
function claudeModeToDetected(mode) {
  if (!mode || mode === 'manual') return null;
  return mode;
}

function parseClaudeContent(raw) {
  const lines = raw.split('\n').filter(Boolean);
  let cwd = null, gitBranch = null, startedAt = null, model = null, firstUserText = '', lastUserText = '', lastAssistantText = '', lastError = null, lastPermissionMode = null, activityState = null;
  const relatedWorkdirs = new Set();

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!startedAt && entry.timestamp) startedAt = entry.timestamp;
    if (entry.cwd) relatedWorkdirs.add(canonicalPath(entry.cwd));
    if (entry.cwd && !cwd) cwd = entry.cwd;
    if (entry.gitBranch && !gitBranch) gitBranch = entry.gitBranch;
    if (entry.type === 'user' && entry.message) {
      const text = extractClaudeText(entry.message.content);
      if (text) { if (!firstUserText) firstUserText = text; lastUserText = text; activityState = 'Working'; }
      if (entry.permissionMode) lastPermissionMode = entry.permissionMode;
    }
    if (entry.type === 'assistant' && entry.message) {
      const text = extractClaudeText(entry.message.content);
      if (text) lastAssistantText = text;
      if (entry.message.stop_reason === 'tool_use') activityState = 'Working';
      else if (entry.message.stop_reason) activityState = 'Done';
      lastError = entry.error || null;
      if (entry.message.model && entry.message.model !== '<synthetic>') model = entry.message.model;
    }
    if (entry.type === 'system' && entry.subtype === 'turn_duration') activityState = 'Done';
  }
  return { cwd, relatedWorkdirs: [...relatedWorkdirs], gitBranch, startedAt, model, firstUserText, lastUserText, lastAssistantText, lastError, detectedMode: claudeModeToDetected(lastPermissionMode), activityState };
}

function buildClaudeAgent(filePath) {
  let result;
  try { result = getListContent(filePath, parseClaudeContent); } catch { return null; }
  const { data, stat } = result;
  const { cwd, relatedWorkdirs, gitBranch, startedAt, model, firstUserText, lastUserText, lastAssistantText, lastError, detectedMode, activityState } = data;

  const branch = gitBranch || resolveGitBranch(cwd);
  const activityText = lastError ? `⚠ ${lastError}` : (lastAssistantText ? truncate(lastAssistantText, 80) : 'Waiting for activity…');
  const promptText = lastUserText ? `› ${truncate(lastUserText, 80)}` : '› (no prompt yet)';

  return finalizeAgent({
    id: path.basename(filePath, '.jsonl'),
    agentType: 'claude',
    cwd,
    branch,
    projectFolderFallback: 'Unknown project',
    activityText,
    promptText,
    titleText: firstUserText || lastUserText || lastAssistantText,
    mtimeMs: stat.mtimeMs,
    filePath,
    fileSizeBytes: stat.size,
    startedAt,
    model,
    relatedWorkdirs,
    detectedMode,
    activityState
  });
}

function listClaudeAgents() {
  const files = walkFiles(CLAUDE_PROJECTS_DIR, 1, name => name.endsWith('.jsonl'));
  return files.map(buildClaudeAgent).filter(Boolean);
}

function formatTranscriptValue(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function displayToolName(name) {
  const aliases = { exec_command: 'Bash', shell_command: 'Bash', write_stdin: 'Bash', apply_patch: 'File edit' };
  return aliases[name] || String(name || 'Tool').replace(/[_-]+/g, ' ');
}

function shellOutputPaths(command) {
  if (typeof command !== 'string') return [];
  if (/\bapply_patch\b/.test(command)) return [];
  const found = new Set();
  const token = '(?:"([^"]+)"|\'([^\']+)\'|([^\\s;&|]+))';
  const patterns = [];
  if (/\b(?:curl|wget)\b/.test(command)) patterns.push(new RegExp(`(?:^|\\s)(?:-o|--output|--output-document)\\s+${token}`, 'g'));
  patterns.push(new RegExp(`\\btee\\s+(?:-[a-zA-Z]+\\s+)*${token}`, 'g'));
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(command))) {
      const filePath = match.slice(1).find(Boolean);
      if (filePath && filePath !== '/dev/null') found.add(filePath);
    }
  }
  for (const line of command.split(/\r?\n/)) {
    if (!/^\s*(?:cat|printf|echo)\b/.test(line)) continue;
    const redirect = new RegExp(`>{1,2}\\s*${token}`, 'g');
    let match;
    while ((match = redirect.exec(line))) {
      const filePath = match.slice(1).find(Boolean);
      if (filePath && filePath !== '/dev/null') found.add(filePath);
    }
  }
  return [...found];
}

function extractClaudeMessages(raw) {
  const messages = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if ((entry.type !== 'user' && entry.type !== 'assistant') || !entry.message) continue;
    const content = entry.message.content;
    if (typeof content === 'string') {
      if (content) messages.push({ role: entry.type, text: content, ts: entry.timestamp || null });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
        messages.push({ role: entry.type, text: block.text, ts: entry.timestamp || null });
      } else if (block?.type === 'image') {
        messages.push({ role: 'tool', label: 'Image attachment', text: '[Image attached]', ts: entry.timestamp || null });
      } else if (entry.type === 'assistant' && block?.type === 'tool_use') {
        messages.push({ role: 'tool', label: `${displayToolName(block.name)} · Tool call`, text: formatTranscriptValue(block.input || {}), ts: entry.timestamp || null });
      } else if (entry.type === 'user' && block?.type === 'tool_result') {
        const result = Array.isArray(block.content)
          ? block.content.map(item => item?.text || '').filter(Boolean).join('\n')
          : formatTranscriptValue(block.content);
        messages.push({ role: 'tool', label: block.is_error ? 'Tool error' : 'Tool result', text: result || '[No text output]', ts: entry.timestamp || null });
      }
    }
  }
  return messages;
}

// --- Codex adapter: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ---

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

function extractCodexText(content) {
  if (!Array.isArray(content)) return '';
  return content.filter(c => c && (c.type === 'input_text' || c.type === 'output_text') && typeof c.text === 'string')
    .map(c => c.text).join('\n');
}

// Codex records its effective permission policy and turn lifecycle in the
// transcript. Granular policies that disable sandbox/rule prompts are Auto;
// never or full access is the stronger Full auto mode.
function codexPolicyToDetected(approvalPolicy, sandboxType) {
  if (sandboxType === 'danger-full-access') return 'bypassPermissions';
  if (sandboxType === 'read-only') return 'plan';
  if (sandboxType === 'workspace-write' && ['on-request', 'never'].includes(approvalPolicy)) return 'auto';
  const granular = approvalPolicy && typeof approvalPolicy === 'object' ? approvalPolicy.granular : null;
  if (sandboxType === 'workspace-write' && granular && granular.sandbox_approval === false && granular.rules === false) return 'auto';
  return null;
}

function parseCodexContent(raw) {
  const lines = raw.split('\n').filter(Boolean);
  let cwd = null, sessionId = null, startedAt = null, model = null, firstUserText = '', lastUserText = '', lastAssistantText = '', lastApprovalPolicy = null, lastSandboxType = null, activityState = null;
  const relatedWorkdirs = new Set();

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!startedAt && entry.timestamp) startedAt = entry.timestamp;
    const payload = entry.payload;
    if (!payload) continue;

    if (entry.type === 'session_meta') {
      if (!cwd && payload.cwd) cwd = payload.cwd;
      if (payload.cwd) relatedWorkdirs.add(canonicalPath(payload.cwd));
      if (!sessionId && (payload.session_id || payload.id)) sessionId = payload.session_id || payload.id;
    }
    if (entry.type === 'turn_context') {
      if (!cwd && payload.cwd) cwd = payload.cwd;
      if (payload.cwd) relatedWorkdirs.add(canonicalPath(payload.cwd));
      if (payload.approval_policy) lastApprovalPolicy = payload.approval_policy;
      if (payload.sandbox_policy && payload.sandbox_policy.type) lastSandboxType = payload.sandbox_policy.type;
      if (payload.model) model = payload.model;
    }

    if (entry.type === 'response_item' && ['custom_tool_call', 'function_call'].includes(payload.type)) {
      collectToolWorkdirs(payload.input || payload.arguments, cwd, relatedWorkdirs);
    }

    if (entry.type === 'response_item' && payload.type === 'message') {
      const text = extractCodexText(payload.content);
      if (text) {
        if (payload.role === 'user' && !text.startsWith('# AGENTS.md')) { if (!firstUserText) firstUserText = text; lastUserText = text; }
        if (payload.role === 'assistant') lastAssistantText = text;
      }
    }
    if (entry.type === 'event_msg' && payload.type === 'task_complete' && payload.last_agent_message) {
      lastAssistantText = payload.last_agent_message;
    }
    if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') activityState = 'Working';
    if (entry.type === 'event_msg' && payload.type === 'task_started') activityState = 'Working';
    if (entry.type === 'event_msg' && (payload.type === 'task_complete' || payload.type === 'turn_aborted')) activityState = 'Done';
  }
  return { cwd, relatedWorkdirs: [...relatedWorkdirs], sessionId, startedAt, model, firstUserText, lastUserText, lastAssistantText, detectedMode: codexPolicyToDetected(lastApprovalPolicy, lastSandboxType), activityState };
}

function buildCodexAgent(filePath) {
  let result;
  try { result = getListContent(filePath, parseCodexContent); } catch { return null; }
  const { data, stat } = result;
  const { cwd, relatedWorkdirs, sessionId, startedAt, model, firstUserText, lastUserText, lastAssistantText, detectedMode, activityState } = data;

  const id = sessionId || path.basename(filePath, '.jsonl');
  const branch = resolveGitBranch(cwd);
  const activityText = lastAssistantText ? truncate(lastAssistantText, 80) : 'Waiting for activity…';
  const promptText = lastUserText ? `› ${truncate(lastUserText, 80)}` : '› (no prompt yet)';

  return finalizeAgent({
    id,
    agentType: 'codex',
    cwd,
    branch,
    projectFolderFallback: 'Unknown project',
    activityText,
    promptText,
    titleText: firstUserText || lastUserText || lastAssistantText,
    mtimeMs: stat.mtimeMs,
    filePath,
    fileSizeBytes: stat.size,
    startedAt,
    model,
    relatedWorkdirs,
    detectedMode,
    activityState
  });
}

function listCodexAgents() {
  const files = walkFiles(CODEX_SESSIONS_DIR, 4, name => name.endsWith('.jsonl'));
  return files.map(buildCodexAgent).filter(Boolean);
}

function extractCodexMessages(raw) {
  const messages = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const payload = entry.payload;
    if (!payload || entry.type !== 'response_item') continue;
    if (payload.type === 'message') {
      const text = extractCodexText(payload.content);
      if (!text || payload.channel === 'analysis' || (payload.role === 'user' && text.startsWith('# AGENTS.md'))) continue;
      if (payload.role === 'user' || payload.role === 'assistant') {
        messages.push({ role: payload.role, text, ts: entry.timestamp || null });
      }
    } else if (['function_call', 'custom_tool_call'].includes(payload.type)) {
      messages.push({ role: 'tool', label: `${displayToolName(payload.name)} · Tool call`, text: formatTranscriptValue(payload.arguments || payload.input || {}), ts: entry.timestamp || null });
    } else if (['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
      messages.push({ role: 'tool', label: 'Tool result', text: formatTranscriptValue(payload.output), ts: entry.timestamp || null });
    }
  }
  return messages;
}

// Add more adapters here as new agent CLIs are detected on disk — each just
// needs a listX() that finds session files and a buildXAgent() that returns
// the shape produced by finalizeAgent().
const ADAPTERS = [listClaudeAgents, listCodexAgents];

function getAgents() {
  if (importedProjects.size === 0) return [];
  const agents = ADAPTERS.flatMap(list => {
    try { return list(); } catch { return []; }
  }).map(agent => {
    agent.projectDirectory = matchingWorkspaceDirectory(agent);
    if (agent.projectDirectory) {
      agent.project = path.basename(agent.projectDirectory) || 'Selected folder';
      const branch = resolveGitBranch(agent.projectDirectory) || agent.branch;
      agent.branch = branch;
      agent.repo = `${agent.project} / ${branch || agent.id.slice(0, 8)}`;
    }
    return agent;
  }).filter(agent => agent.projectDirectory);
  for (const agent of agents) {
    // An explicit dashboard override always wins; otherwise fall back to
    // whatever the session's own transcript says it's really running under
    // right now, rather than silently defaulting to "manual".
    const savedMode = agentModes.get(agent.id);
    // Legacy "default" entries predate live mode detection; don't let one mask
    // the session's current Auto/Full auto setting. A new explicit "manual"
    // override remains available from the dashboard selector.
    agent.mode = savedMode && savedMode !== 'default' ? savedMode : (agent.detectedMode || 'manual');
    const approval = findPendingApproval(agent.id);
    if (approval) {
      agent.state = 'Waiting';
      agent.pendingApproval = { id: approval.id, toolName: approval.toolName, toolInput: approval.toolInput, preview: approval.preview, reason: approval.reason };
    } else if (inFlightSends.has(agent.id)) {
      agent.state = 'Working';
    }
    agent.changeHistory = changeHistory.get(agent.id) || [];
  }
  agents.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return agents;
}

// File paths are streamed from the session's edit/write tool calls and cached
// incrementally as each transcript grows.
const changedFilesCache = new Map();
const changedFilesInFlight = new Map();

function extractClaudeEdits(raw) {
  const edits = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'assistant' || !entry.message) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (!c || c.type !== 'tool_use') continue;
      const input = c.input || {};
      if (c.name === 'Edit' && input.file_path && typeof input.old_string === 'string') {
        edits.push({ filePath: input.file_path, kind: 'updated' });
      } else if (c.name === 'MultiEdit' && input.file_path && Array.isArray(input.edits)) {
        if (input.edits.length) edits.push({ filePath: input.file_path, kind: 'updated' });
      } else if (c.name === 'Write' && input.file_path && typeof input.content === 'string') {
        edits.push({ filePath: input.file_path, kind: 'created or replaced' });
      } else if (c.name === 'Bash' && typeof input.command === 'string') {
        shellOutputPaths(input.command).forEach(filePath => edits.push({ filePath, kind: 'written by shell' }));
      }
    }
  }
  return edits;
}

function unescapeJsString(s) {
  return s.replace(/\\(n|t|r|"|'|\\)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', '"': '"', "'": "'", '\\': '\\' }[c]));
}

function parseApplyPatchBody(body) {
  const results = [];
  let current = null;
  for (const line of body.split('\n')) {
    const m = /^\*\*\* (Update File|Add File|Delete File): (.+)$/.exec(line);
    if (m) {
      if (current) results.push(current);
      current = { filePath: m[2].trim(), kind: m[1] === 'Add File' ? 'created' : m[1] === 'Delete File' ? 'deleted' : 'updated' };
      continue;
    }
    if (!current || line.startsWith('***') || line.startsWith('@@')) continue;
  }
  if (current) results.push(current);
  return results;
}

function extractCodexEdits(raw) {
  const edits = [];
  const callRe = /apply_patch\(\s*"((?:\\.|[^"\\])*)"\s*\)/g;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const payload = entry.payload;
    if (!payload || entry.type !== 'response_item' || !['custom_tool_call', 'function_call'].includes(payload.type)) continue;
    const input = payload.input || payload.arguments;
    const inputText = typeof input === 'string' ? input : JSON.stringify(input || {});
    let command = inputText;
    try {
      const parsed = typeof input === 'string' ? JSON.parse(input) : input;
      command = parsed?.command || parsed?.cmd || inputText;
    } catch {}
    shellOutputPaths(command).forEach(filePath => edits.push({ filePath, kind: 'written by shell' }));
    if (!inputText.includes('apply_patch')) continue;
    let m;
    callRe.lastIndex = 0;
    while ((m = callRe.exec(inputText))) {
      edits.push(...parseApplyPatchBody(unescapeJsString(m[1])));
    }
  }
  return edits;
}

async function getChangedFiles(agent) {
  if (!agent.filePath) return { files: [] };
  let stat;
  try { stat = fs.statSync(agent.filePath); } catch { return { files: [] } }
  const cached = changedFilesCache.get(agent.id);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.result;
  if (changedFilesInFlight.has(agent.id)) return changedFilesInFlight.get(agent.id);
  const pending = scanChangedFiles(agent, stat, cached);
  changedFilesInFlight.set(agent.id, pending);
  try { return await pending; }
  finally { changedFilesInFlight.delete(agent.id); }
}

async function scanChangedFiles(agent, stat, cached) {
  const canResume = cached && stat.size >= cached.size;
  const byPath = canResume ? new Map(cached.byPath) : new Map();
  const start = canResume ? cached.size : 0;
  const decoder = new StringDecoder('utf8');
  let carry = canResume ? cached.carry : '';
  const consumeLine = line => {
    const edits = agent.agentType === 'codex' ? extractCodexEdits(line) : extractClaudeEdits(line);
    for (const edit of edits) {
      const absolutePath = path.resolve(agent.cwd || path.dirname(agent.filePath), edit.filePath);
      byPath.set(absolutePath, edit.kind);
    }
  };
  try {
    const stream = fs.createReadStream(agent.filePath, { start, end: Math.max(start, stat.size - 1) });
    for await (const chunk of stream) {
      const rows = (carry + decoder.write(chunk)).split('\n');
      carry = rows.pop() || '';
      rows.forEach(consumeLine);
    }
    carry += decoder.end();
  } catch {
    return { files: [] };
  }
  const files = [...byPath].map(([absolutePath, kind]) => {
    const relative = agent.cwd ? path.relative(agent.cwd, absolutePath) : absolutePath;
    return { path: relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' ? relative : absolutePath, kind, exists: fs.existsSync(absolutePath) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const result = { files };
  changedFilesCache.set(agent.id, { mtimeMs: stat.mtimeMs, size: stat.size, carry, byPath, result });
  return result;
}

const TRANSCRIPT_PAGE_BYTES = 512 * 1024;
const TRANSCRIPT_PAGE_MESSAGES = 40;
const TRANSCRIPT_PAGE_SCAN_LIMIT = 4 * 1024 * 1024;

function readTranscriptPage(filePath, stat, before) {
  const fd = fs.openSync(filePath, 'r');
  const messages = [];
  let endOffset = Math.min(stat.size, Number.isSafeInteger(before) ? before : stat.size);
  let scanned = 0;
  let pageCursor = null;
  let reachedPageLimit = false;
  const extract = agentTypeForFile(filePath) === 'codex' ? extractCodexMessages : extractClaudeMessages;

  try {
    while (endOffset > 0 && scanned < TRANSCRIPT_PAGE_SCAN_LIMIT && messages.length < TRANSCRIPT_PAGE_MESSAGES) {
      const chunkStart = Math.max(0, endOffset - TRANSCRIPT_PAGE_BYTES);
      const buf = Buffer.alloc(endOffset - chunkStart);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, chunkStart);
      scanned += bytesRead;
      let lineStart = 0;
      if (chunkStart > 0) {
        const firstNewline = buf.indexOf(0x0a);
        if (firstNewline === -1) {
          endOffset = chunkStart;
          continue;
        }
        lineStart = firstNewline + 1;
      }

      const rows = [];
      while (lineStart < bytesRead) {
        const newline = buf.indexOf(0x0a, lineStart);
        const lineEnd = newline === -1 ? bytesRead : newline;
        if (lineEnd > lineStart) {
          rows.push({ offset: chunkStart + lineStart, line: buf.toString('utf8', lineStart, lineEnd) });
        }
        if (newline === -1) break;
        lineStart = newline + 1;
      }

      for (let i = rows.length - 1; i >= 0; i--) {
        const rowMessages = extract(rows[i].line);
        if (!rowMessages.length) continue;
        messages.unshift(...rowMessages);
        if (messages.length >= TRANSCRIPT_PAGE_MESSAGES) {
          pageCursor = rows[i].offset;
          reachedPageLimit = true;
          break;
        }
      }
      if (reachedPageLimit) break;
      if (chunkStart === 0) {
        endOffset = 0;
      } else {
        const previousLineBoundary = chunkStart + lineStart;
        endOffset = previousLineBoundary < endOffset ? previousLineBoundary : chunkStart;
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  const nextCursor = reachedPageLimit ? pageCursor : (endOffset > 0 ? endOffset : null);
  return { messages, nextCursor, hasMore: nextCursor !== null };
}

function agentTypeForFile(filePath) {
  return filePath.includes(`${path.sep}.codex${path.sep}`) ? 'codex' : 'claude';
}

function getTranscriptMessages(agent, before) {
  if (!agent.filePath) return { messages: [], nextCursor: null, hasMore: false };
  let stat;
  try { stat = fs.statSync(agent.filePath); } catch { return { messages: [], nextCursor: null, hasMore: false }; }
  let page;
  try { page = readTranscriptPage(agent.filePath, stat, before); } catch { return { messages: [], nextCursor: null, hasMore: false }; }
  if (page.nextCursor === 0) {
    page.hasMore = false;
    page.nextCursor = null;
  }
  return {
    ...page,
    metadata: {
      id: agent.id,
      agentType: agent.agentType,
      project: agent.project,
      repo: agent.repo,
      cwd: agent.cwd,
      branch: agent.branch,
      model: agent.model,
      state: agent.state,
      mode: agent.detectedMode || agent.mode,
      startedAt: agent.startedAt,
      lastActivityAt: new Date(stat.mtimeMs).toISOString(),
      projectDirectory: agent.projectDirectory,
      transcriptPath: agent.filePath,
      transcriptBytes: stat.size
    }
  };
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/debug/terminal-windows' && req.method === 'GET') {
    // Keep this diagnostic local: it reports open Terminal tabs and their TTYs.
    const remoteAddress = req.socket.remoteAddress || '';
    if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1' && remoteAddress !== '::ffff:127.0.0.1') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    execFile('osascript', ['-e', 'tell application "Terminal" to get tty of every tab of every window'],
      { timeout: 10000 }, (err, stdout, stderr) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: !err, stdout: stdout || null, error: err ? (stderr || err.message) : null }));
      });
    return;
  }

  if (pathname === '/api/choose-folder' && req.method === 'POST') {
    execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select a folder to show related agent chats")'],
      { timeout: 120000 }, (err, stdout) => {
        const cancelled = err && /User canceled|-128/.test(String(err.message || ''));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(err
          ? { ok: false, cancelled, error: cancelled ? null : 'Could not open folder picker' }
          : { ok: true, path: canonicalPath(stdout.trim()) }));
      });
    return;
  }

  if (pathname === '/api/projects' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([...importedProjects].sort()));
    return;
  }

  if (pathname === '/api/projects' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let data; try { data = JSON.parse(body || '{}'); } catch { data = {}; }
      const raw = typeof data.path === 'string' ? data.path.trim() : '';
      if (!raw) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Path required' }));
        return;
      }
      const expanded = raw.replace(/^~(?=$|[/\\])/, os.homedir());
      const resolved = canonicalPath(path.resolve(expanded));
      let stat;
      try { stat = fs.statSync(resolved); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Folder not found' }));
        return;
      }
      if (!stat.isDirectory()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Not a folder' }));
        return;
      }
      importedProjects.add(resolved);
      saveImportedProjects();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: resolved }));
    });
    return;
  }

  if (pathname === '/api/projects' && req.method === 'DELETE') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let data; try { data = JSON.parse(body || '{}'); } catch { data = {}; }
      if (typeof data.path === 'string') importedProjects.delete(canonicalPath(data.path));
      saveImportedProjects();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (pathname === '/api/agents') {
    const agents = getAgents();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(agents));
    return;
  }

  const messagesMatch = pathname.match(/^\/api\/agents\/([^/]+)\/messages$/);
  if (messagesMatch) {
    const id = decodeURIComponent(messagesMatch[1]);
    const agent = getAgents().find(a => a.id === id);
    if (!agent) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }
    const rawBefore = parsedUrl.searchParams.get('before');
    const before = rawBefore !== null && /^\d+$/.test(rawBefore) ? Number(rawBefore) : undefined;
    const result = getTranscriptMessages(agent, before);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  const modeMatch = pathname.match(/^\/api\/agents\/([^/]+)\/mode$/);
  if (modeMatch && req.method === 'GET') {
    const id = decodeURIComponent(modeMatch[1]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ mode: getAgentMode(id) }));
    return;
  }
  if (modeMatch && req.method === 'POST') {
    const id = decodeURIComponent(modeMatch[1]);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let data; try { data = JSON.parse(body || '{}'); } catch { data = {}; }
      if (!VALID_MODES.has(data.mode)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid mode' }));
        return;
      }
      agentModes.set(id, data.mode);
      saveAgentModes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode: data.mode }));
    });
    return;
  }

  const sendMatch = pathname.match(/^\/api\/agents\/([^/]+)\/send$/);
  if (req.method === 'POST' && sendMatch) {
    const id = decodeURIComponent(sendMatch[1]);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let data; try { data = JSON.parse(body || '{}'); } catch { data = {}; }
      const message = typeof data.message === 'string' ? data.message.trim() : '';
      const rawImages = Array.isArray(data.images) ? data.images.slice(0, 6) : [];
      const images = rawImages
        .filter(img => img && typeof img.data === 'string' && img.data.length < 15 * 1024 * 1024)
        .map(img => saveImageAttachment(img.mimeType, img.data));
      if (!message && images.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Message or image required' }));
        return;
      }
      const agent = getAgents().find(a => a.id === id);
      if (!agent) {
        for (const img of images) fs.unlink(img.path, () => {});
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Agent not found' }));
        return;
      }
      const result = enqueuePromptForAgent(agent, message, images);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  const sendStatusMatch = pathname.match(/^\/api\/sends\/([^/]+)$/);
  if (sendStatusMatch && req.method === 'GET') {
    const run = sendRuns.get(sendStatusMatch[1]);
    res.writeHead(run ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(run || { status: 'missing', result: { ok: false, error: 'Send status expired' } }));
    return;
  }

  if (pathname === '/api/approvals' && req.method === 'GET') {
    const list = [...pendingApprovals.values()].filter(a => a.status === 'pending');
    res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
    return;
  }

  // Internal: called by approval-hook.js (one HTTP round-trip per PreToolUse call
  // on a dashboard-initiated session), never by the frontend directly.
  if (pathname === '/api/approvals' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let data; try { data = JSON.parse(body || '{}'); } catch { data = {}; }
      const id = crypto.randomUUID();
      const sessionId = data.sessionId || '';
      const matchedAgent = getAgents().find(a => a.id === sessionId);
      const mode = matchedAgent ? matchedAgent.mode : getAgentMode(sessionId);
      const preview = makeFilePreview(data.toolName, data.toolInput || {}, data.cwd || matchedAgent?.cwd || '');
      const decided = autoDecide(mode, data.toolName, data.toolInput || {});
      if ((mode === 'manual' || mode === 'default') && classifyTool(data.toolName) === 'edit' && !preview) {
        decided.status = 'deny';
        decided.reason = 'Blocked in Manual approval: a complete file diff could not be generated.';
      }
      pendingApprovals.set(id, {
        id,
        sessionId,
        agentType: data.agentType || 'unknown',
        toolName: data.toolName || 'unknown',
        toolInput: data.toolInput || {},
        preview,
        cwd: data.cwd || '',
        createdAt: Date.now(),
        status: decided.status,
        reason: decided.reason
      });
      if (preview || decided.status === 'deny') {
        const history = changeHistory.get(sessionId) || [];
        history.push({ id, path: preview?.path || data.toolName, diff: preview?.diff || decided.reason, status: decided.status === 'deny' ? 'blocked' : 'proposed', createdAt: Date.now() });
        changeHistory.set(sessionId, history.slice(-100));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
    });
    return;
  }

  const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
  if (approvalMatch && req.method === 'GET') {
    const a = pendingApprovals.get(approvalMatch[1]);
    if (!a) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: a.status, reason: a.reason }));
    return;
  }

  const decideMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/decide$/);
  if (decideMatch && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let data; try { data = JSON.parse(body || '{}'); } catch { data = {}; }
      const a = pendingApprovals.get(decideMatch[1]);
      if (!a) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Not found' }));
        return;
      }
      if (a.status !== 'pending') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: a.reason || 'Approval is no longer pending' }));
        return;
      }
      if (a.rpcKey) {
        try { codexConnection.decide(a.rpcKey, data.decision === 'allow'); }
        catch (err) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
          return;
        }
      }
      a.status = data.decision === 'allow' ? 'allow' : 'deny';
      a.reason = typeof data.reason === 'string' ? data.reason : '';
      const history = changeHistory.get(a.sessionId) || [];
      const change = history.find(item => item.id === a.id);
      if (change) change.status = a.status === 'allow' ? 'approved' : 'denied';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  const filesMatch = pathname.match(/^\/api\/agents\/([^/]+)\/files$/);
  if (filesMatch && req.method === 'GET') {
    const id = decodeURIComponent(filesMatch[1]);
    const agent = getAgents().find(a => a.id === id);
    if (!agent) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }
    getChangedFiles(agent).then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(() => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files: [], error: 'Could not read changed files' }));
    });
    return;
  }

  const openFileMatch = pathname.match(/^\/api\/agents\/([^/]+)\/open-file$/);
  if (openFileMatch && req.method === 'POST') {
    const id = decodeURIComponent(openFileMatch[1]);
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let data; try { data = JSON.parse(body || '{}'); } catch { data = {}; }
      const agent = getAgents().find(a => a.id === id);
      if (!agent) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Agent not found' }));
        return;
      }
      getChangedFiles(agent).then(result => {
        const entry = result.files.find(file => file.path === data.path);
        if (!entry || !entry.exists) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Changed file not found' }));
          return;
        }
        const base = agent.cwd || path.dirname(agent.filePath);
        const absolutePath = path.resolve(base, entry.path);
        execFile('open', ['-a', process.env.AGENTMANAGER_EDITOR || 'Zed', absolutePath], { timeout: 15000 }, err => {
          res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err ? { ok: false, error: `Could not open file in ${process.env.AGENTMANAGER_EDITOR || 'Zed'}` } : { ok: true }));
        });
      }).catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Could not read changed files' }));
      });
    });
    return;
  }

  if (pathname === '/api/transcribe' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      transcribeAudio(Buffer.concat(chunks)).then(text => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, text }));
      }).catch(err => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    });
    return;
  }

  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, path.normalize(filePath).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.png' ? 'image/png' : 'text/plain';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`AgentManager live on http://localhost:${PORT}`);
});
