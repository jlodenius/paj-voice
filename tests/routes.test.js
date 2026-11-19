import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';

const desk = { input: 'private-desk-input', output: 'private-headphones' };
const headset = { input: 'old-bluez-node', output: 'old-bluez-sink',
  inputDevice: 'bluez_card.private-headset', outputDevice: 'bluez_card.private-headset' };
const devices = [
  { name: desk.input, class: 'Audio/Source' }, { name: desk.output, class: 'Audio/Sink' },
  { name: 'new-bluez-input', class: 'Audio/Source', device: headset.inputDevice, bluetooth: true },
  { name: 'new-bluez-output', class: 'Audio/Sink', device: headset.outputDevice, bluetooth: true },
];
const tick = () => new Promise(resolve => setImmediate(resolve));
function routes() {
  const saved = { version: 2, active: 'desk', routes: { desk, headset } };
  const f = fixture({ loadDevices: () => ({ version: 1, ...saved.routes[saved.active] }),
    loadRoutes: () => structuredClone(saved), saveRoute: (_file, name, selection, expected) => {
      if (expected) assert.deepEqual(saved.routes[name], expected);
      if (selection) saved.routes[name] = selection;
      saved.active = name;
    }, saveRouteBinding: (_file, name, selection, expected, activate) => {
      assert.deepEqual(saved, expected);
      saved.routes[name] = selection;
      if (activate) saved.active = name;
    } });
  f.pi.exec = async () => ({ code: 0, stdout: JSON.stringify(devices) });
  return { ...f, saved };
}
async function arm(f) { await f.command('on'); f.workers[0].args.onEvent({ type: 'ready' }, f.controller.state().generation); }
function ready(f, index = f.workers.length - 1) {
  const worker = f.workers[index];
  worker.args.onEvent({ type: 'ready' }, f.controller.state().generation);
}
function invoke(f, name, token = f.controller.state(), signal) {
  return f.tools.get('voice_route').execute(`route-${name}`, { name,
    generation: token.generation, epoch: token.epoch }, signal);
}

test('named setup and off/muted route selection never open or unmute capture', async () => {
  const f = routes();
  f.ctx.ui.select = async (_title, labels) => labels[0];
  await f.command('setup travel');
  assert.equal(f.saved.active, 'desk');
  assert.deepEqual(f.saved.routes.travel, { ...desk, speakerMode: true });
  await f.command('route headset');
  assert.equal(f.saved.active, 'headset');
  assert.equal(f.workers.length, 0);
  await arm(f);
  await f.command('mute');
  await f.command('route desk');
  assert.equal(f.controller.state().muted, true);
  assert.equal(f.workers.length, 1);
  await f.command('off');
});

test('public command/tool list only names and switch announces only after exact route readiness', async () => {
  const f = routes();
  await arm(f);
  await f.event('agent_start');
  const before = f.controller.state();
  const listed = await invoke(f);
  assert.deepEqual(listed.details, { current: 'desk', routes: ['desk', 'headset'] });
  const pending = invoke(f, 'headset');
  await tick();
  assert.equal(f.workers[0].closed, true);
  assert.equal(f.controller.state().processing, true);
  assert.equal(f.controller.state().generation, before.generation);
  assert.equal(f.controller.state().starting, true);
  assert.equal(f.frames.some(frame => frame.text === 'headset ready.'), false);
  assert.equal(f.workers[1].args.config.audio.inputDevice, headset.inputDevice);
  ready(f);
  const result = await pending;
  assert.equal(result.details.status, 'ready');
  assert.equal(f.frames.some(frame => frame.text === 'headset ready.'), true);
  assert.equal(f.messages.length, 0);
  const context = await f.event('context', { messages: [] });
  const modelContext = JSON.stringify(context);
  for (const privateId of Object.values(headset)) assert.equal(modelContext.includes(privateId), false);
  assert.match(modelContext, /headset/);
  f.audio({ type: 'addressed', id: 'newer-user-turn' });
  const stale = await invoke(f, 'desk', before);
  assert.equal(stale.details.status, 'stale');
  await f.command('off');
});

test('unknown, unavailable and ambiguous routes preserve the original active route', async () => {
  for (const variant of ['unknown', 'missing', 'ambiguous']) {
    const f = routes();
    await arm(f);
    if (variant === 'missing') f.pi.exec = async () => ({ code: 0, stdout: '[]' });
    if (variant === 'ambiguous') f.pi.exec = async () => ({ code: 0,
      stdout: JSON.stringify([...devices, { name: 'another-source', class: 'Audio/Source', device: headset.inputDevice }]) });
    const result = await invoke(f, variant === 'unknown' ? 'nonexistent' : 'headset');
    assert.equal(result.details.status, variant === 'unknown' ? 'unknown' : 'unavailable');
    assert.equal(f.workers.length, 1);
    assert.equal(f.workers[0].closed, false);
    assert.equal(f.controller.state().enabled, true);
    await f.command('off');
  }
});

test('Bluetooth alias selection uses backend metadata, not a physical device name prefix', async t => {
  const f = routes();
  t.after(() => f.command('off'));
  f.saved.routes.headset = { ...headset, inputDevice: 'renamed-headset', outputDevice: 'renamed-headset' };
  f.pi.exec = async () => ({ code: 0, stdout: JSON.stringify([
    { name: 'new-input', class: 'Audio/Source', device: 'renamed-headset', bluetooth: true },
    { name: 'new-output', class: 'Audio/Sink', device: 'renamed-headset', bluetooth: true },
  ]) });
  await arm(f);
  const pending = invoke(f, 'headset');
  await tick();
  ready(f);
  assert.equal((await pending).details.status, 'ready');
});

test('an exact ALSA endpoint stays selectable when its card has other endpoints', async t => {
  const f = routes();
  t.after(() => f.command('off'));
  f.saved.routes.desk = { ...desk, inputDevice: 'alsa_card.chosen', outputDevice: 'alsa_card.chosen' };
  f.saved.active = 'headset';
  f.pi.exec = async () => ({ code: 0, stdout: JSON.stringify([
    { name: desk.input, class: 'Audio/Source', device: 'alsa_card.chosen' },
    { name: desk.output, class: 'Audio/Sink', device: 'alsa_card.chosen' },
    { name: 'other-port', class: 'Audio/Sink', device: 'alsa_card.chosen' },
  ]) });
  await arm(f);
  const pending = invoke(f, 'desk');
  await tick();
  ready(f);
  assert.equal((await pending).details.status, 'ready');
  assert.equal(f.workers[1].args.config.audio.output, desk.output);
});

test('post-close failure restores only the exact previous selection, and rollback failure closes audio', async () => {
  for (const failRollback of [false, true]) {
    const f = routes();
    await arm(f);
    const pending = invoke(f, 'headset');
    await tick();
    f.workers[1].args.onEvent({ type: 'error', message: 'private failed device' });
    await tick();
    assert.deepEqual(f.workers[2].args.config.audio, { ...desk, echoCancellation: 'none' });
    if (failRollback) f.workers[2].args.onEvent({ type: 'error' });
    else ready(f);
    const result = await pending;
    assert.deepEqual(result.details.recovered, !failRollback);
    assert.equal(result.details.status, 'failed');
    assert.equal(JSON.stringify(result).includes('private failed device'), false);
    assert.equal(f.controller.state().enabled, !failRollback);
    assert.equal(f.saved.active, 'desk');
    if (failRollback) assert.ok(f.workers.every(worker => worker.closed));
    await f.command('off');
  }
});

test('switch transitions serialize and old native speech/recognition frames cannot change current state', async () => {
  const f = routes();
  await arm(f);
  const token = f.controller.state();
  const pending = invoke(f, 'headset');
  const second = await f.command('route desk');
  await tick();
  assert.ok(f.notices.some(([message]) => message.includes('busy')));
  const old = f.workers[0];
  for (const frame of [{ type: 'ready' }, { type: 'addressed', id: 'old' },
    { type: 'utterance', id: 'old', text: 'Do not execute' }, { type: 'speech_start', id: 'old' },
    { type: 'speech_end', id: 'old', completed: true }]) old.args.onEvent(frame, token.generation);
  assert.equal(f.controller.state().starting, true);
  assert.equal(f.messages.length, 0);
  ready(f);
  await pending;
  assert.equal(f.saved.active, 'headset');
  await f.command('off');
});

test('off, mute, session replacement, dispose and tool abort cancel asynchronous route starts', async () => {
  for (const cancellation of ['off', 'mute', 'session_start', 'session_shutdown', 'abort']) {
    const f = routes();
    await arm(f);
    const abort = new AbortController();
    const pending = invoke(f, 'headset', f.controller.state(), abort.signal);
    await tick();
    if (cancellation === 'abort') abort.abort();
    else if (cancellation.startsWith('session')) await f.event(cancellation);
    else await f.command(cancellation);
    ready(f, 1);
    const result = await pending;
    assert.equal(result.details.status, 'cancelled');
    assert.equal(f.controller.state().enabled, false);
    assert.equal(f.workers.length, 2);
    assert.ok(f.workers.every(worker => worker.closed));
    assert.equal(f.frames.some(frame => frame.text === 'headset ready.'), false);
    assert.equal(f.saved.active, 'desk');
    await f.command('off');
  }
});

test('off during preflight cannot cause late capture start', async () => {
  const f = routes();
  await arm(f);
  let resolve;
  f.pi.exec = () => new Promise(done => { resolve = done; });
  const pending = invoke(f, 'headset');
  await f.command('off');
  resolve({ code: 0, stdout: JSON.stringify(devices) });
  assert.equal((await pending).details.status, 'cancelled');
  assert.equal(f.workers.length, 1);
});

test('changed route definitions cannot close current audio during preflight or commit mismatched audio', async t => {
  for (const stage of ['preflight', 'readiness']) {
    const f = routes();
    t.after(() => f.command('off'));
    await arm(f);
    let release;
    if (stage === 'preflight') f.pi.exec = () => new Promise(resolve => { release = resolve; });
    const pending = invoke(f, 'headset');
    await tick();
    f.saved.routes.headset = { ...headset, inputDevice: 'another-private-device' };
    if (stage === 'preflight') release({ code: 0, stdout: JSON.stringify(devices) });
    else ready(f);
    await tick();
    if (stage === 'readiness' || f.workers.length > 1) ready(f);
    const result = await pending;
    assert.equal(f.saved.active, 'desk');
    assert.equal(result.details.status, stage === 'preflight' ? 'changed' : 'failed');
    if (stage === 'preflight') assert.equal(f.workers[0].closed, false);
    else assert.equal(result.details.recovered, true);
    assert.equal(f.frames.some(frame => frame.text === 'headset ready.'), false);
    await f.command('off');
  }
});

test('a spoken request can continue speaking after its intentional route handoff', async t => {
  const f = routes();
  t.after(() => f.command('off'));
  await arm(f);
  f.audio({ type: 'addressed', id: 'route-request' });
  f.audio({ type: 'utterance', id: 'route-request', text: 'Switch to headset and continue.' });
  const messages = [{ role: 'user', content: f.messages[0][0] }];
  await f.event('context', { messages });
  const pending = invoke(f, 'headset');
  await tick();
  ready(f);
  await pending;
  const context = await f.event('context', { messages });
  const policy = context.messages.find(message => message.customType === 'paj-voice-context').content;
  const current = f.controller.state();
  assert.ok(policy.includes(`epoch=${current.epoch}.`));
  const result = await f.tools.get('voice_speak').execute('continued-answer', {
    text: 'Continuing your request.', generation: current.generation, epoch: current.epoch });
  assert.equal(result.details.status, 'queued');
  await f.command('off');
});

test('capture IDs may repeat after switches and desk return without losing or replaying requests', async t => {
  const f = routes();
  t.after(() => f.command('off'));
  await arm(f);
  for (const [index, route] of ['headset', 'desk', null].entries()) {
    f.audio({ type: 'addressed', id: 'e1-t1' });
    f.audio({ type: 'utterance', id: 'e1-t1', text: `Request ${index + 1}` });
    assert.equal(f.messages.length, index + 1);
    if (route) {
      const pending = invoke(f, route);
      await tick();
      ready(f);
      await pending;
    }
  }
  assert.equal(new Set(f.messages.map(([text]) => text.split('\\n')[0])).size, 3);
});

test('command handoffs preserve an eligible in-flight spoken answer without reviving interrupted answers', async t => {
  for (const interrupted of [false, true]) {
    const f = routes();
    t.after(() => f.command('off'));
    await arm(f);
    f.audio({ type: 'addressed', id: 'in-flight' });
    f.audio({ type: 'utterance', id: 'in-flight', text: 'Tell me the result.' });
    await f.event('context', { messages: [{ role: 'user', content: f.messages[0][0] }] });
    if (interrupted) f.audio({ type: 'addressed', id: 'newer-speech' });
    const pending = f.command('route headset');
    await tick();
    const during = await f.event('context', { messages: [{ role: 'user', content: f.messages[0][0] }] });
    assert.ok(during.messages.some(message => message.customType === 'paj-voice-context'));
    ready(f);
    await pending;
    await f.event('message_end', { message: { role: 'assistant', stopReason: 'stop',
      content: [{ type: 'text', text: 'The work is done.' }] } });
    assert.equal(f.frames.some(frame => frame.text === 'The work is done.'), !interrupted);
  }
});

test('a newly generated answer during handoff is delivered once after readiness, never after off', async t => {
  for (const cancelled of [false, true]) {
    const f = routes();
    t.after(() => f.command('off'));
    await arm(f);
    f.audio({ type: 'addressed', id: 'ongoing-request' });
    f.audio({ type: 'utterance', id: 'ongoing-request', text: 'What is the result?' });
    const messages = [{ role: 'user', content: f.messages[0][0] }];
    await f.event('context', { messages });
    const pending = f.command('route headset');
    await tick();
    await f.event('context', { messages });
    await f.event('message_end', { message: { role: 'assistant', stopReason: 'stop',
      content: [{ type: 'text', text: 'Your result is ready.' }] } });
    await f.event('agent_settled');
    assert.equal(f.frames.some(frame => frame.text === 'Your result is ready.'), false);
    if (cancelled) await f.command('off');
    ready(f);
    await pending;
    assert.equal(f.frames.filter(frame => frame.text === 'Your result is ready.').length, cancelled ? 0 : 1);
  }
});

test('answers during preflight use still-ready audio and do not become missing-summary fallbacks', async t => {
  for (const outcome of ['unavailable', 'success', 'rollback']) {
    const f = routes();
    t.after(() => f.command('off'));
    await arm(f);
    f.audio({ type: 'addressed', id: 'preflight-answer' });
    f.audio({ type: 'utterance', id: 'preflight-answer', text: 'What is the result?' });
    await f.event('context', { messages: [{ role: 'user', content: f.messages[0][0] }] });
    let release;
    f.pi.exec = () => new Promise(resolve => { release = resolve; });
    const pending = f.command('route headset');
    await f.event('message_end', { message: { role: 'assistant', stopReason: 'stop',
      content: [{ type: 'text', text: 'Your result is ready.' }] } });
    await f.event('agent_settled');
    assert.equal(f.frames.filter(frame => frame.text === 'Your result is ready.').length, 1);
    assert.equal(f.frames.some(frame => frame.key === 'fallback'), false);
    release({ code: 0, stdout: JSON.stringify(outcome === 'unavailable' ? [] : devices) });
    await tick();
    if (outcome === 'rollback') {
      f.audio({ type: 'error' });
      await tick();
      ready(f);
    } else if (outcome === 'success') ready(f);
    await pending;
    assert.equal(f.frames.filter(frame => frame.text === 'Your result is ready.').length, 1);
  }
});

test('route companions still stop audio on post-ready native errors and capture overflow', async t => {
  for (const failure of ['error', 'overflow']) {
    const f = routes();
    t.after(() => f.command('off'));
    await arm(f);
    const pending = invoke(f, 'headset');
    await tick();
    ready(f);
    await pending;
    if (failure === 'error') f.audio({ type: 'error', message: 'private-device-id' });
    else for (let index = 0; index < 5; index++) f.audio({ type: 'addressed', id: `overflow-${index}` });
    assert.equal(f.controller.state().enabled, false);
    assert.equal(f.workers.at(-1).closed, true);
  }
});

test('private storage errors cannot leak hardware IDs or interrupt ordinary model context', async () => {
  let broken = false;
  const f = fixture({ loadRoutes() {
    if (broken) throw new Error('Malformed JSON containing private-headset-hardware-id');
    return { version: 2, active: 'desk', routes: { desk, headset } };
  } });
  await arm(f);
  broken = true;
  const result = await invoke(f, 'headset');
  assert.equal(result.details.status, 'unavailable');
  const context = await f.event('context', { messages: [] });
  assert.equal(JSON.stringify([result, context]).includes('private-headset-hardware-id'), false);
  assert.equal(f.controller.state().enabled, true);
  await f.command('off');
});
