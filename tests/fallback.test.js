import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';

const headset = { input: 'headset-input', output: 'headset-output' };
const laptop = { input: 'built-in-mic', output: 'built-in-speakers', speakerMode: true };
function configured(t, enabled = true) {
  const saved = { version: 2, active: 'headset', routes: { headset, laptop },
    ...(enabled ? { fallback: 'laptop' } : {}) };
  const writes = [];
  const f = fixture({ loadRoutes: () => structuredClone(saved),
    loadDevices: () => ({ version: 1, ...saved.routes[saved.active] }),
    saveRoute(_file, name) { writes.push('preferred'); saved.active = name; },
    saveFallback(_file, name, selection) {
      writes.push('fallback');
      if (name) {
        saved.routes[name] = { ...(selection ?? saved.routes[name]), speakerMode: true };
        saved.fallback = name;
      } else delete saved.fallback;
    } });
  t.after(() => f.command('off'));
  return { ...f, saved, writes };
}
const plain = value => value.replace(/\x1b\[[\d;]*m/gu, '');

test('private fallback settings never select the preferred route or open audio', async t => {
  const f = configured(t, false);
  await f.command('fallback laptop');
  assert.equal(f.saved.active, 'headset');
  assert.equal(f.saved.fallback, 'laptop');
  assert.deepEqual(f.writes, ['fallback']);
  assert.equal(f.workers.length, 0);
  await f.command('fallback off');
  assert.equal(f.saved.fallback, undefined);
  assert.equal(f.saved.routes.laptop.speakerMode, true);
  f.pi.exec = async () => ({ code: 0, stdout: JSON.stringify([
    { name: 'built-in-mic', class: 'Audio/Source', device: 'built-in-card' },
    { name: 'built-in-speakers', class: 'Audio/Sink', device: 'built-in-card' },
  ]) });
  f.ctx.ui.select = async (_title, choices) => choices[0];
  await f.command('fallback setup reserve');
  assert.equal(f.saved.active, 'headset');
  assert.equal(f.saved.fallback, 'reserve');
  assert.equal(f.saved.routes.reserve.input, 'built-in-mic');
  assert.equal(f.saved.routes.reserve.output, 'built-in-speakers');
  assert.equal(f.workers.length, 0);
  assert.equal(f.writes.includes('preferred'), false);
});

test('arming snapshots configured endpoints and discloses speaker safety and manual return', async t => {
  const f = configured(t);
  let dialog;
  f.ctx.ui.confirm = async (_title, text) => { dialog = text; return true; };
  await f.command('on');
  const config = f.workers[0].args.config;
  assert.equal(config.audio.fallback.name, 'laptop');
  assert.equal(config.audio.fallback.input, laptop.input);
  assert.equal(config.audio.fallback.output, laptop.output);
  assert.match(dialog, /fallback laptop/);
  assert.match(dialog, /recognition during Voice readouts/);
  assert.match(dialog, /explicit route switch or rearm/);
  f.audio({ type: 'ready' });
  await f.command('fallback off');
  assert.equal(f.saved.fallback, 'laptop');
  assert.equal(f.workers.length, 1);
  assert.equal(f.workers[0].closed, false);
});

test('fallback is active runtime state, not a saved preference change, and speaker capture is truthfully gated', async t => {
  const f = configured(t);
  await f.command('on');
  f.audio({ type: 'ready' });
  const generation = f.controller.state().generation;
  f.audio({ type: 'availability', input: true, output: true, fallback: true, speakerMode: true, listening: true });
  assert.equal(f.controller.state().generation, generation);
  assert.equal(f.saved.active, 'headset');
  assert.deepEqual(f.writes, []);
  const result = await f.tools.get('voice_route').execute('list', f.controller.state());
  assert.equal(result.details.current, 'laptop');
  assert.equal(result.details.preferred, 'headset');
  assert.equal(result.details.usingFallback, true);
  const widget = f.widgets.at(-1).component.render(100).map(plain).join('\n');
  assert.match(widget, /Audio: laptop \(fallback\).*Preferred: headset/);
  assert.match(widget, /SPEAKER MODE/);
  f.audio({ type: 'capture_state', listening: false });
  assert.equal(f.controller.state().inputAvailable, true);
  assert.equal(f.controller.state().listening, false);
  f.audio({ type: 'addressed', id: 'echo' });
  f.audio({ type: 'utterance', id: 'echo', text: 'Own speech must not become a request.' });
  assert.equal(f.messages.length, 0);
  f.audio({ type: 'capture_state', listening: true });
  f.audio({ type: 'addressed', id: 'fresh' });
  f.audio({ type: 'utterance', id: 'fresh', text: 'A fresh user request.' });
  assert.equal(f.messages.length, 1);
});

test('startup fallback is disclosed and late guard events cannot bypass off or mute', async t => {
  const f = configured(t);
  await f.command('on');
  f.audio({ type: 'ready', fallback: true, speakerMode: true, listening: false });
  assert.equal(f.controller.state().usingFallback, true);
  assert.equal(f.controller.state().listening, false);
  assert.ok(f.notices.some(([text]) => /preferred route is unavailable/i.test(text)));
  const worker = f.workers[0];
  await f.command('mute');
  worker.args.onEvent({ type: 'capture_state', listening: true }, worker.args.generation);
  worker.args.onEvent({ type: 'availability', input: true, output: true, fallback: true }, worker.args.generation);
  assert.equal(f.controller.state().listening, false);
  assert.equal(worker.closed, true);
});

test('initial partial readiness never claims that missing configured endpoints are available', async t => {
  const f = configured(t);
  await f.command('on');
  f.audio({ type: 'ready', input: false, output: false, fallback: false, listening: false });
  const state = f.controller.state();
  assert.equal(state.enabled, true);
  assert.equal(state.inputAvailable, false);
  assert.equal(state.outputAvailable, false);
  assert.equal(state.listening, false);
  assert.equal(state.eyesFree, false);
  assert.match(f.widgets.at(-1).component.render(100).map(plain).join('\n'), /AUDIO SUSPENDED/);
});

test('availability recognition pauses fence any capture even when its endpoint remains available', async t => {
  const f = configured(t);
  await f.command('on'); f.audio({ type: 'ready' });
  f.audio({ type: 'addressed', id: 'partial' });
  f.audio({ type: 'availability', input: true, output: true, fallback: true,
    speakerMode: true, listening: false });
  f.audio({ type: 'utterance', id: 'partial', text: 'Must not submit after recognition paused.' });
  assert.equal(f.controller.state().listening, false);
  assert.equal(f.messages.length, 0);
});

test('fallback setup cannot replace the saved preferred route binding', async t => {
  const f = configured(t, false);
  let enumerations = 0;
  f.pi.exec = async () => { enumerations++; return { code: 0, stdout: '[]' }; };
  await f.command('fallback setup headset');
  assert.equal(enumerations, 0);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.saved.routes.headset, headset);
});

test('speaker-safe preferred routes do not require automatic fallback to remain echo guarded', async t => {
  const f = configured(t, false);
  f.saved.active = 'laptop';
  await f.command('on');
  assert.equal(f.workers[0].args.config.audio.speakerMode, true);
  assert.equal(f.workers[0].args.config.audio.fallback, undefined);
  f.audio({ type: 'ready', speakerMode: true, listening: false });
  assert.equal(f.controller.state().speakerMode, true);
  assert.equal(f.controller.state().usingFallback, false);
});

test('fallback settings confirmation is fenced by off/session changes', async t => {
  const f = configured(t, false);
  let resolve;
  f.ctx.ui.confirm = () => new Promise(done => { resolve = done; });
  const pending = f.command('fallback laptop');
  await f.command('off');
  resolve(true);
  await pending;
  assert.deepEqual(f.writes, []);
  assert.equal(f.workers.length, 0);
});
