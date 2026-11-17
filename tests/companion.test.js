import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { startCompanion } from '../src/companion.js';

function run(script, callbacks = {}) {
  return startCompanion({ config: {}, generation: 'g',
    onEvent() {}, startupMs: 2000, ...callbacks,
    spawnProcess(_command, _args, options) { return spawn(process.execPath, ['-e', script], options); },
  });
}

test('inherited pipes bind configuration to the selected generation without any listener', { timeout: 5000 }, async () => {
  let worker;
  const received = new Promise((resolve, reject) => {
    worker = run(`process.stdin.once('data',chunk=>{ const frame=JSON.parse(chunk); process.stdout.write(JSON.stringify({type:'ready',received:frame})+'\\n'); });`,
      { onEvent: (frame, generation) => resolve({ frame, generation }), onExit: message => { if (message) reject(new Error(message)); } });
  });
  try {
    const { frame, generation } = await received;
    assert.equal(generation, 'g');
    assert.equal(frame.received.type, 'configure');
    assert.equal(frame.received.generation, 'g');
    assert.equal(Object.hasOwn(frame.received.config, 'python'), false);
    assert.ok(frame.received.config.cacheDir.endsWith('/paj-voice'));
  } finally { worker.close(); }
});

test('malformed, oversized and non-object frames fail closed', { timeout: 10000 }, async () => {
  for (const line of ['invalid', '[]', 'x'.repeat(70000)]) {
    let worker, delivered = 0;
    const exited = new Promise(resolve => {
      worker = run(`process.stdin.once('data',()=>{ process.stdout.write(${JSON.stringify(line)}+'\\n'); });`,
        { onEvent: () => delivered++, onExit: resolve });
    });
    await exited;
    assert.equal(delivered, 0);
    worker.close();
  }
});

test('startup timeout terminates an unready worker', { timeout: 5000 }, async () => {
  let worker;
  const message = await new Promise(resolve => {
    worker = run('process.stdin.resume();', { startupMs: 30, onExit: resolve });
  });
  assert.match(message, /ready in time/);
  worker.close();
});

test('missing executable produces an actionable local runtime failure', { timeout: 5000 }, async () => {
  const message = await new Promise(resolve => {
    startCompanion({ config: {}, executable: '/no/such/local/voice-runtime', generation: 'g',
      onEvent() {}, onExit: resolve, startupMs: 500 });
  });
  assert.match(message, /Cannot start local voice runtime/);
});

function fakeChild() {
  const child = new EventEmitter();
  child.signals = [];
  child.kill = signal => { child.signals.push(signal); };
  for (const name of ['stdin', 'stdout', 'stderr']) child[name] = new EventEmitter();
  Object.assign(child.stdin, { writable: true, destroyed: false, writableLength: 0, write() {}, end() {} });
  child.stdout.setEncoding = child.stderr.setEncoding = () => {};
  return child;
}

test('backpressure overflow closes once without recursive shutdown writes', () => {
  const child = fakeChild(), failures = [];
  const worker = startCompanion({ config: {}, generation: 'g', onEvent() {},
    onExit: message => failures.push(message), spawnProcess: () => child });
  child.stdin.writableLength = 65536;
  assert.equal(worker.send({ type: 'stop' }), false);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.match(failures[0], /queue overflowed/);
  worker.close();
  child.emit('exit', 0);
  assert.equal(failures.length, 1);
});

test('startup failure retains forced termination until the child actually exits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeChild(), failures = [];
  startCompanion({ config: {}, generation: 'g', onEvent() {}, startupMs: 10,
    onExit: message => failures.push(message), spawnProcess: () => child });
  t.mock.timers.tick(10);
  assert.match(failures[0], /ready in time/);
  assert.deepEqual(child.signals, ['SIGTERM']);
  t.mock.timers.tick(2000);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  child.emit('exit', 0);
  assert.equal(failures.length, 1);
});

test('callback closure stops processing the rest of an already-buffered frame batch', () => {
  const child = fakeChild(), frames = [];
  const worker = startCompanion({ config: {}, generation: 'g',
    onEvent: frame => { frames.push(frame); worker.close(); }, spawnProcess: () => child });
  child.stdout.emit('data', '{"type":"ready"}\n{"type":"addressed","id":"late"}\n');
  assert.equal(frames.length, 1);
  child.emit('exit', 0);
});

test('stream errors fail closed instead of throwing unhandled error events', () => {
  for (const stream of ['stdin', 'stdout', 'stderr']) {
    const child = fakeChild(), failures = [];
    startCompanion({ config: {}, generation: 'g', onEvent() {},
      onExit: message => failures.push(message), spawnProcess: () => child });
    child[stream].emit('error', new Error('broken pipe'));
    assert.equal(failures.length, 1);
    assert.deepEqual(child.signals, ['SIGTERM']);
    child.emit('exit', 0);
  }
});
