const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {PassThrough,Writable}=require('node:stream');
const {ProxyWebSocket}=require('../proxy-websocket');
function fixture(timeout=1000){
 const child=new EventEmitter(),writes=[];child.stdout=new PassThrough();
 child.stdin=new Writable({write(chunk,_,done){writes.push(Buffer.from(chunk));done()}});
 child.kill=()=>{child.killed=true};
 const ws=new ProxyWebSocket(child,timeout);ws.on('error',()=>{});
 const response=()=>{
  const key=/Sec-WebSocket-Key: (.+)\r\n/.exec(writes[0].toString())[1];
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  return Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
 };
 return {child,ws,writes,response};
}
function frame(text,opcode=1,fin=true){
 const payload=Buffer.from(text),header=Buffer.alloc(payload.length<126?2:payload.length<=65535?4:10);
 header[0]=(fin?128:0)|opcode;
 if(payload.length<126)header[1]=payload.length;
 else if(payload.length<=65535){header[1]=126;header.writeUInt16BE(payload.length,2)}
 else {header[1]=127;header.writeBigUInt64BE(BigInt(payload.length),2)}
 return Buffer.concat([header,payload]);
}
test('HTTP upgrade tolerates chunked headers and decodes a frame in the same packet',async()=>{
 const h=fixture(),messages=[];h.ws.on('message',m=>messages.push(m));const ready=h.ws.start();
 const data=Buffer.concat([h.response(),frame('{"id":1,"result":{}}')]);
 h.child.stdout.write(data.subarray(0,20));h.child.stdout.write(data.subarray(20));await ready;
 assert.deepEqual(messages,[{id:1,result:{}}]);h.ws.send({method:'initialized'});
 assert.equal(h.writes[1][0],129);assert(h.writes[1][1]&128);
});
test('rejects invalid upgrade and kills only its proxy',async()=>{
 const h=fixture();const ready=h.ws.start();h.child.stdout.write('HTTP/1.1 403 Forbidden\r\n\r\n');
 await assert.rejects(ready,/upgrade rejected/);assert(h.child.killed);
});
test('handshake timeout cleans up proxy',async()=>{
 const h=fixture(10);await assert.rejects(h.ws.start(),/handshake timed out/);assert(h.child.killed);
});
test('handles fragmented JSON, ping/pong and extended-length replies',async()=>{
 const h=fixture(),messages=[];h.ws.on('message',m=>messages.push(m));const ready=h.ws.start();h.child.stdout.write(h.response());await ready;
 h.child.stdout.write(frame('{"text":',1,false));h.child.stdout.write(frame('ping',9));h.child.stdout.write(frame('"hello"}',0,true));
 assert.deepEqual(messages,[{text:'hello'}]);assert.equal(h.writes.at(-1)[0]&15,10);
 const text='a'.repeat(70000),large=frame(JSON.stringify({text}));
 h.child.stdout.write(large.subarray(0,500));h.child.stdout.write(large.subarray(500));assert.equal(messages[1].text,text);
});
