const crypto = require('crypto');
const { EventEmitter } = require('events');
const MAX = 16 * 1024 * 1024;

// `codex app-server proxy` forwards raw socket bytes. The control socket
// speaks WebSocket over HTTP Upgrade, not app-server's stdio JSONL protocol.
class ProxyWebSocket extends EventEmitter {
  constructor(child, timeoutMs = 15000) {
    super(); this.child = child; this.buffer = Buffer.alloc(0); this.upgraded = false;
    this.fragments = []; this.fragmentSize = 0; this.fragmenting = false; this.closed = false;
    this.key = crypto.randomBytes(16).toString('base64');
    this.ready = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.timer = setTimeout(() => this.fail(new Error('Codex control socket WebSocket handshake timed out')), timeoutMs);
    child.stdout.on('data', chunk => {
      try { this.read(chunk); } catch (err) { this.fail(err); }
    });
    child.on('error', err => this.fail(err));
    child.on('close', () => this.fail(new Error('Codex proxy closed the control socket')));
    child.stdin.on('error', err => this.fail(err));
  }
  start() {
    this.child.stdin.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    return this.ready;
  }
  fail(err) {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer); this.reject(err);
    this.emit('error', err); this.child.kill?.();
  }
  send(message) { this.frame(1, Buffer.from(JSON.stringify(message))); }
  frame(opcode, payload) {
    if (this.closed) throw new Error('Codex control socket is closed');
    const size = payload.length;
    if (size > MAX) throw new Error('Codex WebSocket message exceeds 16 MB');
    const extra = size < 126 ? 0 : size <= 65535 ? 2 : 8;
    const header = Buffer.alloc(2 + extra + 4);
    header[0] = 0x80 | opcode; header[1] = 0x80 | (extra === 0 ? size : extra === 2 ? 126 : 127);
    if (extra === 2) header.writeUInt16BE(size, 2);
    if (extra === 8) header.writeBigUInt64BE(BigInt(size), 2);
    const mask = crypto.randomBytes(4); mask.copy(header, 2 + extra);
    const encoded = Buffer.alloc(size);
    for (let i = 0; i < size; i++) encoded[i] = payload[i] ^ mask[i % 4];
    this.child.stdin.write(Buffer.concat([header, encoded]));
  }
  read(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.upgraded) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) { if (this.buffer.length > 16384) throw new Error('Invalid Codex WebSocket handshake'); return; }
      const headers = this.buffer.subarray(0, end).toString('utf8');
      const accept = crypto.createHash('sha1').update(this.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      const fields = Object.fromEntries(headers.split('\r\n').slice(1).map(line => { const i = line.indexOf(':'); return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()]; }));
      if (!/^HTTP\/1\.[01] 101\b/.test(headers) || fields['sec-websocket-accept'] !== accept || fields.upgrade?.toLowerCase() !== 'websocket') throw new Error(`Codex WebSocket upgrade rejected: ${headers.split('\r\n')[0]}`);
      this.buffer = this.buffer.subarray(end + 4); this.upgraded = true;
      clearTimeout(this.timer); this.resolve();
    }
    while (this.buffer.length >= 2) {
      const first = this.buffer[0], second = this.buffer[1], opcode = first & 15, fin = !!(first & 128);
      if (first & 112 || second & 128) throw new Error('Invalid Codex WebSocket frame');
      let size = second & 127, offset = 2;
      if (size === 126) { if (this.buffer.length < 4) return; size = this.buffer.readUInt16BE(2); offset = 4; }
      else if (size === 127) { if (this.buffer.length < 10) return; const n = this.buffer.readBigUInt64BE(2); if (n > BigInt(MAX)) throw new Error('Codex WebSocket message exceeds 16 MB'); size = Number(n); offset = 10; }
      if (size > MAX || (opcode >= 8 && (!fin || size > 125))) throw new Error('Invalid Codex WebSocket frame size');
      if (this.buffer.length < offset + size) return;
      const payload = this.buffer.subarray(offset, offset + size); this.buffer = this.buffer.subarray(offset + size);
      if (opcode === 8) { this.fail(new Error('Codex closed the WebSocket connection')); return; }
      if (opcode === 9) { this.frame(10, payload); continue; }
      if (opcode === 10) continue;
      if (opcode === 1 && !this.fragmenting) { this.fragments = [payload]; this.fragmentSize = size; }
      else if (opcode === 0 && this.fragmenting) { this.fragments.push(payload); this.fragmentSize += size; }
      else throw new Error('Unsupported Codex WebSocket message');
      if (this.fragmentSize > MAX) throw new Error('Codex WebSocket message exceeds 16 MB');
      this.fragmenting = !fin;
      if (fin) { const text = Buffer.concat(this.fragments).toString('utf8'); this.fragments = []; this.fragmentSize = 0; this.emit('message', JSON.parse(text)); }
    }
  }
}
module.exports = { ProxyWebSocket };
