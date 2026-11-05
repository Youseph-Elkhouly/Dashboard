const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const crypto = require('crypto');
const { CodexConnection } = require('../codex-connection');

function harness(options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const sent = [];
  const emit = message => {
    const payload=Buffer.from(JSON.stringify(message));
    const header=Buffer.alloc(payload.length<126?2:4);header[0]=0x81;
    if(payload.length<126) header[1]=payload.length;else {header[1]=126;header.writeUInt16BE(payload.length,2)}
    child.stdout.write(Buffer.concat([header,payload]));
  };
  let upgraded=false;

  child.stdin = new Writable({ write(chunk, _, done) {
    if(!upgraded){
      assert.match(chunk.toString(),/^GET \/ HTTP\/1.1\r\n/);
      const key=/Sec-WebSocket-Key: (.+)\r\n/.exec(chunk.toString())[1];
      const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      upgraded=true;done();
      queueMicrotask(()=>child.stdout.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`));return;
    }
    assert(chunk[1]&128,'client messages must be masked WebSocket frames');
    let size=chunk[1]&127,offset=2;
    if(size===126){size=chunk.readUInt16BE(2);offset=4}
    else if(size===127){size=Number(chunk.readBigUInt64BE(2));offset=10}
    const mask=chunk.subarray(offset,offset+4),payload=Buffer.from(chunk.subarray(offset+4));
    assert.equal(size,payload.length);for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];
    const message = JSON.parse(payload.toString()); sent.push(message); done();
    if (!message.method || message.id == null) return;
    queueMicrotask(() => {
      const result = message.method === 'initialize' ? {}
        : message.method === 'thread/resume' ? { thread: { id: 'thread', status: { type: 'idle' } }, sandbox: { type: 'readOnly' }, approvalPolicy: 'on-request', approvalsReviewer: 'user' }
        : message.method === 'turn/start' ? { turn: { id: 'turn' } } : {};
      if (message.method === 'thread/resume' && options.badPolicy) result.sandbox.type = 'workspaceWrite';
      emit({ id: message.id, result });
    });
  }});
  const connection = new CodexConnection({ spawnProcess: (command, args) => {
    assert.equal(command, 'codex'); assert.deepEqual(args, ['app-server', 'proxy']); return child;
  }, ...options });
  const send = () => connection.send({ id: 'thread', cwd: '/tmp', mode: 'manual' }, 'hello', []);
  const started = async () => { while (!sent.some(m => m.method === 'turn/start')) await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };
  const event = (method, params = {}) => emit({ method, params: { threadId: 'thread', turnId: 'turn', ...params } });
  const done = () => event('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  return { child, sent, emit, connection, send, started, event, done };
}

test('shares proxy, submits once, streams reply, awaits terminal turn event', async () => {
  const h = harness(); const result = h.send(); await h.started();
  h.event('item/agentMessage/delta', { itemId: 'reply', delta: 'Hello' });
  h.event('item/completed', { item: { id: 'reply', type: 'agentMessage', text: 'Hello provider' } });
  h.done(); assert.deepEqual(await result, { ok: true, output: 'Hello provider' });
  assert.equal(h.sent.filter(m => m.method === 'turn/start').length, 1);
  assert.equal(h.sent.find(m => m.method === 'turn/start').params.sandboxPolicy.type, 'readOnly');
});

test('edit requests carry preview, require Allow, and cannot be answered twice', async () => {
  let request; const h = harness({ onApproval: r => { request = r; } });
  const result = h.send(); await h.started();
  h.event('item/started', { item: { id: 'edit', type: 'fileChange', changes: [{ path: '/tmp/example', diff: '-before\n+after' }] } });
  h.emit({ id: 200, method: 'item/fileChange/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'edit' } });
  await new Promise(r => setImmediate(r)); assert.equal(request.changes[0].diff, '-before\n+after');
  assert(!h.sent.some(m => m.id === 200));
  h.connection.decide(request.key, true);
  assert.equal(h.sent.find(m => m.id === 200).result.decision, 'accept');
  assert.throws(() => h.connection.decide(request.key, true), /no longer pending/);
  h.event('item/completed', { item: { id: 'reply', type: 'agentMessage', text: 'Applied' } }); h.done(); await result;
});

test('Deny maps to decline and another client can resolve pending approval', async () => {
  let request; const resolved=[];
  const h = harness({ onApproval: r => { request=r; }, onResolved: key => resolved.push(key) });
  const result=h.send(); await h.started();
  h.event('item/started',{item:{id:'edit',type:'fileChange',changes:[{path:'a',diff:'-a\n+b'}]}});
  const approval=id=>h.emit({id,method:'item/fileChange/requestApproval',params:{threadId:'thread',turnId:'turn',itemId:'edit'}});
  approval(200);await new Promise(r=>setImmediate(r));h.connection.decide(request.key,false);
  assert.equal(h.sent.find(m=>m.id===200).result.decision,'decline');
  approval(201);await new Promise(r=>setImmediate(r));h.event('serverRequest/resolved',{requestId:201});
  await new Promise(r=>setImmediate(r));assert.deepEqual(resolved,['201']);
  assert.throws(()=>h.connection.decide('201',true),/no longer pending/);h.done();await result;
});

test('manual policy mismatch blocks prompt before submission', async () => {
  const h = harness({ badPolicy: true });
  await assert.rejects(h.send(), /Manual approval enforcement/);
  assert(!h.sent.some(m=>m.method==='turn/start'));
});

test('empty completed turns are failures', async () => {
  const h=harness();const result=h.send();await h.started();h.done();
  assert.match((await result).error,/without an assistant reply/);
});

test('disconnect is explicit and does not resubmit', async () => {
  const h=harness();const result=h.send();await h.started();h.child.emit('close',1);
  assert.match((await result).error,/Delivery may have occurred/);
  assert.equal(h.sent.filter(m=>m.method==='turn/start').length,1);
});

test('unsupported write requests fail safely with visible reason', async () => {
  const h=harness();const result=h.send();await h.started();
  h.emit({id:200,method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn'}});
  await new Promise(r=>setImmediate(r));assert.equal(h.sent.find(m=>m.id===200).result.decision,'decline');h.done();
  assert.match((await result).error,/unsupported operation/);
});
