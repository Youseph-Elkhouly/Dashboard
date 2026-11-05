#!/usr/bin/env node
// PreToolUse hook used two ways:
//
// 1. Claude: injected per-invocation via `--settings` only on the subprocess
//    AgentManager itself spawns when you hit Send. Never installed globally.
// 2. Codex: installed in ~/.codex/hooks.json globally (Codex has no
//    per-invocation hook flag). AGENTMANAGER_SESSION_ID is only set on
//    subprocesses AgentManager spawns, so every other Codex session (every
//    normal interactive one) falls through untouched to the existing
//    Vibe Island bridge below — this script changes nothing for those.
//
// Either way: ask AgentManager's own server for a decision and block until
// it answers, then report that decision back in the exact shape each CLI
// expects (hookSpecificOutput.permissionDecision, plus exit code 2 on deny
// as a fallback signal in case the JSON shape goes unrecognized).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PORT = process.env.AGENTMANAGER_PORT || '4178';
const AGENT_TYPE = process.env.AGENTMANAGER_AGENT_TYPE || 'unknown';
const SESSION_ID = process.env.AGENTMANAGER_SESSION_ID || '';
const POLL_MS = 1000;
const TIMEOUT_MS = 280000; // stay under the ~290-300s hook timeout configured on both sides

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function httpJson(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: 'localhost', port: PORT, path: reqPath, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, res => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(out || '{}')); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function reportAndExit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason }
  }));
  process.exit(decision === 'allow' ? 0 : 2);
}

async function passThroughToVibeIsland() {
  const bridge = path.join(os.homedir(), '.vibe-island', 'bin', 'vibe-island-bridge');
  if (fs.existsSync(bridge)) {
    const res = spawnSync(bridge, ['--source', 'codex'], { stdio: 'inherit' });
    process.exit(res.status == null ? 0 : res.status);
  }
  process.exit(0); // bridge missing — fail open, never break a normal session
}

async function main() {
  if (!SESSION_ID) return passThroughToVibeIsland();

  let input;
  try { input = JSON.parse(await readStdin()); } catch { return reportAndExit('deny', 'AgentManager: could not parse hook input'); }

  const toolName = input.tool_name || input.toolName || 'unknown';
  const toolInput = input.tool_input || input.toolInput || {};
  const cwd = input.cwd || '';

  let created;
  try {
    created = await httpJson('POST', '/api/approvals', { sessionId: SESSION_ID, agentType: AGENT_TYPE, toolName, toolInput, cwd });
  } catch {
    return reportAndExit('deny', 'AgentManager: dashboard server unreachable');
  }
  if (!created.id) return reportAndExit('deny', 'AgentManager: failed to register approval request');

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));
    let status;
    try { status = await httpJson('GET', `/api/approvals/${created.id}`); } catch { continue; }
    if (status.status === 'allow') return reportAndExit('allow', status.reason || 'Approved via AgentManager');
    if (status.status === 'deny') return reportAndExit('deny', status.reason || 'Denied via AgentManager');
  }
  return reportAndExit('deny', 'AgentManager: approval timed out');
}

main();
