const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { ProxyWebSocket } = require('./proxy-websocket');

// Connects to the existing owner; never starts another Codex writer.
class CodexConnection extends EventEmitter {
  constructor({ spawnProcess = spawn, onApproval, onResolved } = {}) {
    super();
    this.spawnProcess = spawnProcess;
    this.onApproval = onApproval;
    this.onResolved = onResolved;
    this.pending = new Map();
    this.serial = 0;
    this.runs = new Map();
    this.requests = new Map();
  }
  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.open().catch(err => { this.ready = null; throw err; });
    return this.ready;
  }
  async open() {
    const child = this.spawnProcess('codex', ['app-server', 'proxy'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    const disconnect = error => {
      if (this.child !== child) return;
      this.child = null; this.transport = null; this.ready = null;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
      this.pending.clear();
      for (const run of this.runs.values()) run.finish({ ok: false, output: run.output, error: `${error.message}. Delivery may have occurred; check history before sending again.` });
      for (const key of this.requests.keys()) this.onResolved?.(key, 'Connection lost');
      this.requests.clear();
    };
    child.on('error', err => disconnect(new Error(`Cannot connect to Codex owner: ${err.message}`)));
    child.on('close', () => disconnect(new Error(`Codex owner connection closed${stderr.trim() ? `: ${stderr.trim()}` : ''}`)));
    child.stdin.on('error', err => disconnect(new Error(`Codex connection write failed: ${err.message}`)));
    const transport = new ProxyWebSocket(child);
    transport.on('message', message => this.receive(message));
    transport.on('error', err => disconnect(new Error(`Codex transport failed: ${err.message}`)));
    try { await transport.start(); }
    catch (err) { throw new Error(`Codex WebSocket handshake failed: ${err.message}${stderr.trim() ? `: ${stderr.trim()}` : ''}`); }
    this.transport = transport;
    try {
      await this.rpc('initialize', { clientInfo: { name: 'agentmanager', title: 'AgentManager', version: '1.0.0' } });
      this.write({ method: 'initialized' });
    } catch (err) { transport.fail(err); throw err; }
  }
  write(message) {
    if (!this.child) throw new Error('Codex owner is not connected');
    this.transport.send(message);
  }
  rpc(method, params) {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out; submission will not be retried automatically`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }
  receive(message) {
    if (!message.method) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else request.resolve(message.result);
      return;
    }
    const p = message.params || {};
    if (message.method === 'serverRequest/resolved') {
      const key = String(p.requestId);
      if (this.requests.has(key)) { this.requests.delete(key); this.onResolved?.(key, 'Resolved by server or another client'); }
    }
    const run = this.runs.get(p.threadId);
    if (!run) {
      if (message.id != null) this.write({ id: message.id, error: { code: -32601, message: 'No dashboard turn owns this request' } });
      return;
    }
    if (!run.turnId) { run.backlog.push(message); return; }
    this.turnEvent(run, message);
  }
  turnEvent(run, message) {
    const p = message.params || {};
    if ((p.turnId || p.turn?.id) !== run.turnId) return;
    if (message.method === 'item/agentMessage/delta') {
      run.deltas.set(p.itemId, (run.deltas.get(p.itemId) || '') + (p.delta || ''));
      run.output = [...run.deltas.values()].join('\n\n'); run.progress?.(run.output);
    }
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = p.item || {};
      if (item.type === 'fileChange') run.files.set(item.id, item);
      if (message.method === 'item/completed' && item.type === 'agentMessage') {
        run.deltas.set(item.id, item.text || '');
        run.output = [...run.deltas.values()].join('\n\n'); run.progress?.(run.output);
      }
    }
    if (message.id != null) {
      const key = String(message.id);
      if (message.method !== 'item/fileChange/requestApproval' || p.grantRoot) {
        if (['item/fileChange/requestApproval', 'item/commandExecution/requestApproval'].includes(message.method)) this.write({ id: message.id, result: { decision: 'decline' } });
        else this.write({ id: message.id, error: { code: -32602, message: 'Dashboard requires a specific proposed file diff; broad write permissions and unsupported requests are blocked' } });
        run.blocked = 'An unsupported operation was blocked; use a file edit with a proposed diff.';
        run.progress?.(run.output, run.blocked);
        return;
      }
      const changes = run.files.get(p.itemId)?.changes || [];
      if (!changes.length || changes.some(change => typeof change.diff !== 'string')) {
        this.write({ id: message.id, result: { decision: 'decline' } });
        run.blocked = 'File edit blocked because Codex did not provide a complete diff.';
        run.progress?.(run.output, run.blocked); return;
      }
      this.requests.set(key, { rpcId: message.id, threadId: p.threadId, turnId: p.turnId });
      this.onApproval?.({ key, threadId: p.threadId, turnId: p.turnId, itemId: p.itemId, changes });
    }
    if (message.method === 'turn/completed') {
      const status = p.turn.status;
      run.finish(status === 'completed' && run.output.trim()
        ? { ok: true, output: run.output, ...(run.blocked ? { warning: run.blocked } : {}) }
        : { ok: false, output: run.output, error: p.turn.error?.message || run.blocked || (status === 'completed' ? 'Codex completed without an assistant reply' : `Codex turn ${status}`) });
    }
  }
  decide(key, allow) {
    const request = this.requests.get(key);
    if (!request) throw new Error('Approval is no longer pending');
    this.write({ id: request.rpcId, result: { decision: allow ? 'accept' : 'decline' } });
    this.requests.delete(key);
  }
  async send(agent, message, images, progress) {
    await this.connect();
    // Check the shared owner's live state without claiming another writer.
    const resumed = await this.rpc('thread/resume', { threadId: agent.id, excludeTurns: true });
    if (resumed.thread?.id !== agent.id) throw new Error('Codex owner returned a different thread; no prompt submitted');
    const idleDeadline = Date.now() + 15 * 60 * 1000;
    let thread = resumed.thread;
    while (thread?.status?.type === 'active' || thread?.turns?.some(turn => turn.status === 'inProgress')) {
      if (Date.now() > idleDeadline) throw new Error('Selected Codex thread is still busy; prompt was not submitted');
      progress?.('', 'Waiting for the active Codex turn to finish');
      await new Promise(resolve => setTimeout(resolve, 1000));
      thread = (await this.rpc('thread/read', { threadId: agent.id, includeTurns: false })).thread;
    }
    const manual = ['manual', 'default'].includes(agent.mode || 'manual');
    // Read-only sandbox blocks command writes; native file approval permits only the reviewed patch.
    const sandboxPolicy = manual || agent.mode === 'plan' ? { type: 'readOnly' } : { type: 'workspaceWrite', writableRoots: [agent.cwd], networkAccess: false };
    if (manual) {
      const checked = await this.rpc('thread/resume', { threadId: agent.id, excludeTurns: true, sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user' });
      if (checked.sandbox?.type !== 'readOnly' || checked.approvalPolicy !== 'on-request' || checked.approvalsReviewer !== 'user') throw new Error('Codex owner cannot confirm Manual approval enforcement; no prompt submitted');
    }
    return new Promise(resolve => {
      const run = { turnId: null, backlog: [], files: new Map(), deltas: new Map(), output: '', progress };
      const timer = setTimeout(() => run.finish({ ok: false, output: run.output, error: 'Codex response timed out; check history before sending again' }), 15 * 60 * 1000);
      run.finish = result => {
        if (this.runs.get(agent.id) !== run) return;
        clearTimeout(timer); this.runs.delete(agent.id);
        for (const [key, request] of this.requests) if (request.threadId === agent.id && request.turnId === run.turnId) {
          this.requests.delete(key); this.onResolved?.(key, 'Turn ended');
        }
        resolve(result);
      };
      this.runs.set(agent.id, run);
      this.rpc('turn/start', { threadId: agent.id, cwd: agent.cwd, input: [...(message ? [{ type: 'text', text: message }] : []), ...images.map(image => ({ type: 'localImage', path: image.path }))], sandboxPolicy, approvalPolicy: agent.mode === 'plan' ? 'never' : 'on-request', approvalsReviewer: 'user' })
        .then(result => { run.turnId = result.turn.id; for (const event of run.backlog) this.turnEvent(run, event); run.backlog = []; })
        .catch(err => run.finish({ ok: false, error: err.message, output: run.output }));
    });
  }
}
module.exports = { CodexConnection };
