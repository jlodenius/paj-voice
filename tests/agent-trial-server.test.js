import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createTrialServer } from '../src/agent-trial-server.js';

async function fixture(t) {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'voice-trial-test-'));
  const requests = [], reasons = [], onsets = [];
  const server = await createTrialServer({ sessionId: 'pinned', runtimeDir,
    onOnset: value => onsets.push(value), onUtterance: value => requests.push(value),
    onClose: reason => reasons.push(reason) });
  const peer = connect(server.socketPath);
  peer.on('error', () => {});
  await once(peer, 'connect');
  let buffer = '';
  const frames = [], waiters = [], stages = [];
  peer.setEncoding('utf8');
  peer.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
      waiters.shift()?.();
    }
  });
  const next = async () => {
    while (true) {
      if (!frames.length) await new Promise(resolve => waiters.push(resolve));
      const frame = frames.shift();
      if (frame.type !== 'reply_status') return frame;
      stages.push(frame);
    }
  };
  const send = frame => peer.write(JSON.stringify(frame) + '\n');
  t.after(async () => { peer.destroy(); server.close(); await rm(runtimeDir, { recursive: true, force: true }); });
  const hello = async () => {
    send({ type: 'hello', version: 1, sessionId: 'pinned' });
    assert.deepEqual(await next(), { type: 'hello', version: 1, sessionId: 'pinned' });
    send({ type: 'arm', seconds: 90 });
    assert.equal((await next()).type, 'armed');
  };
  return { server, peer, send, next, hello, requests, reasons, onsets, stages };
}

test('private exact-session channel preserves older decodes and rejects stale/duplicate speech', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  assert.equal((await stat(f.server.socketPath)).mode & 0o777, 0o600);
  await f.hello();
  f.send({ type: 'onset', generation: 1 });
  f.send({ type: 'onset', generation: 2 });
  f.send({ type: 'utterance', sequence: 1, generation: 1, text: 'first request' });
  assert.equal((await f.next()).sequence, 1);
  f.send({ type: 'utterance', sequence: 2, generation: 2, text: 'addition during processing' });
  assert.equal((await f.next()).sequence, 2);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.onsets, [1, 2]);
  assert.equal(f.server.answer(1, 'Stale answer'), false);
  assert.equal(f.server.answer(2, 'Current answer'), true);
  assert.equal((await f.next()).text, 'Current answer');
  assert.ok(f.stages.some(frame => frame.reason === 'stale' && frame.generation === 1));
  assert.equal(f.server.answer(2, 'Duplicate answer'), false);
  const closed = once(f.peer, 'close');
  f.send({ type: 'utterance', sequence: 2, generation: 2, text: 'duplicate must not be submitted' });
  await closed;
  assert.equal(f.requests.length, 2);
});

test('wrong session cannot arm or submit anything', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  const closed = once(f.peer, 'close');
  f.send({ type: 'hello', version: 1, sessionId: 'different' });
  await closed;
  assert.equal(f.requests.length, 0);
});

test('oversized frames fail closed and disconnect cannot reopen the old channel', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  await f.hello();
  const closed = once(f.peer, 'close');
  f.peer.write('x'.repeat(8193));
  await closed;
  assert.equal(f.server.answer(1, 'Late answer'), false);
  assert.equal(f.requests.length, 0);
});
