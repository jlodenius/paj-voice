import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';

async function armed(t, options = {}) {
  const f = fixture(options);
  t.after(() => f.command('off'));
  await f.command('on'); f.audio({ type: 'ready' });
  return f;
}
const availability = (f, input, output) => f.audio({ type: 'availability', input, output });
const speeches = f => f.frames.filter(frame => frame.type === 'speak');

test('output loss preserves armed session, capture and accepted work without replaying old speech on return', async t => {
  const f = await armed(t);
  const before = f.controller.state();
  const old = f.controller.api.speak({ ...before, text: 'An old answer.' });
  f.audio({ type: 'speech_start', id: old.id });
  availability(f, true, false);
  assert.equal(f.controller.state().enabled, true);
  assert.equal(f.controller.state().starting, false);
  assert.equal(f.controller.state().listening, true);
  assert.equal(f.controller.state().outputAvailable, false);
  assert.equal(f.controller.state().eyesFree, false);
  assert.equal(f.controller.state().generation, before.generation);
  assert.equal(f.controller.state().epoch, before.epoch);
  assert.equal(f.workers[0].closed, false);
  f.audio({ type: 'addressed', id: 'while-output-missing' });
  f.audio({ type: 'utterance', id: 'while-output-missing', text: 'Continue the requested task.' });
  assert.equal(f.messages.length, 1);
  const unavailable = { ...f.controller.state(), text: 'A reply during the outage.', id: 'outage-reply' };
  const missing = f.controller.api.speak(unavailable);
  assert.equal(missing.status, 'unavailable');
  availability(f, true, true);
  assert.equal(f.controller.api.speak(unavailable).status, 'duplicate');
  assert.equal(f.controller.state().listening, true);
  assert.equal(speeches(f).filter(frame => frame.text === 'An old answer.').length, 1);
  assert.equal(speeches(f).some(frame => frame.text === 'A reply during the outage.'), false);
  assert.ok(f.controller.playback().some(record => record.reason === 'output_unavailable'));
  assert.equal(f.workers.length, 1);
});

test('speech requested during capture and missing output cannot replay after cancellation and return', async t => {
  const f = await armed(t);
  availability(f, true, false);
  f.audio({ type: 'addressed', id: 'partial' });
  const intent = { ...f.controller.state(), id: 'during-capture', text: 'Old speech must not replay.' };
  assert.equal(f.controller.api.speak(intent).status, 'unavailable');
  f.audio({ type: 'cancelled', id: 'partial', reason: 'empty' });
  availability(f, true, true);
  assert.equal(f.controller.api.speak(intent).status, 'duplicate');
  assert.equal(speeches(f).some(frame => frame.text === intent.text), false);
});

test('input loss cancels partial capture but preserves output and permits only fresh post-recovery speech', async t => {
  const f = await armed(t);
  f.audio({ type: 'addressed', id: 'partial' });
  const before = f.controller.state();
  f.audio({ type: 'cancelled', id: 'partial', reason: 'input_disconnected' });
  availability(f, false, true);
  assert.equal(f.controller.state().enabled, true);
  assert.equal(f.controller.state().listening, false);
  assert.equal(f.controller.state().capturing, false);
  assert.equal(f.controller.state().inputAvailable, false);
  assert.equal(f.controller.state().generation, before.generation);
  assert.equal(f.controller.state().epoch, before.epoch);
  f.audio({ type: 'utterance', id: 'partial', text: 'An incomplete command.' });
  assert.equal(f.messages.length, 0);
  assert.ok(speeches(f).some(frame => /Listening is suspended/.test(frame.text)));
  availability(f, true, true);
  f.audio({ type: 'addressed', id: 'partial' });
  f.audio({ type: 'utterance', id: 'partial', text: 'A replayed old capture.' });
  assert.equal(f.messages.length, 0);
  f.audio({ type: 'addressed', id: 'fresh' });
  f.audio({ type: 'utterance', id: 'fresh', text: 'A complete fresh request.' });
  assert.equal(f.messages.length, 1);
});

test('duplicate availability and return events do not spam or create a new worker', async t => {
  const f = await armed(t);
  availability(f, false, false);
  const notices = f.notices.length, count = speeches(f).length;
  availability(f, false, false);
  assert.equal(f.notices.length, notices);
  assert.equal(speeches(f).length, count);
  availability(f, true, true);
  const returned = speeches(f).length;
  availability(f, true, true);
  assert.equal(speeches(f).length, returned);
  assert.equal(f.workers.length, 1);
  assert.equal(f.messages.length, 0);
});

test('off, mute and stale companion events cannot resurrect suspended audio', async t => {
  for (const command of ['off', 'mute']) {
    const f = await armed(t);
    availability(f, false, false);
    const old = f.workers[0].args;
    await f.command(command);
    old.onEvent({ type: 'availability', input: true, output: true }, old.generation);
    assert.equal(f.controller.state().listening, false);
    assert.equal(f.workers[0].closed, true);
    assert.equal(f.workers.length, 1);
    await f.command(command === 'mute' ? 'unmute' : 'on');
    f.audio({ type: 'ready' });
    const state = f.controller.state();
    old.onEvent({ type: 'availability', input: false, output: false }, old.generation);
    assert.deepEqual(f.controller.state(), state);
  }
});

test('a route returning to suspension does not report readiness or accept late old-worker recovery', async t => {
  const selection = { input: 'laptop', output: 'headphones' };
  const saved = { version: 2, active: 'desk', routes: { desk: selection, headset: selection } };
  const f = await armed(t, { loadRoutes: () => structuredClone(saved),
    saveRoute: (_path, name) => { saved.active = name; } });
  f.pi.exec = async () => ({ code: 0, stdout: JSON.stringify([
    { name: 'laptop', class: 'Audio/Source' }, { name: 'headphones', class: 'Audio/Sink' },
  ]) });
  const old = f.workers[0].args;
  availability(f, true, false);
  const pending = f.tools.get('voice_route').execute('switch', { ...f.controller.state(), name: 'headset' });
  await new Promise(done => setImmediate(done));
  assert.equal(f.workers.length, 2);
  f.audio({ type: 'ready' });
  availability(f, false, false);
  const result = await pending;
  assert.equal(result.details.status, 'suspended');
  assert.equal(saved.active, 'headset');
  availability(f, true, true);
  const state = f.controller.state();
  old.onEvent({ type: 'availability', input: false, output: false }, old.generation);
  assert.deepEqual(f.controller.state(), state);
});

test('arming discloses same-device recovery and continued capture when only output disconnects', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  let confirmation;
  f.ctx.ui.confirm = async (_title, text) => { confirmation = text; return true; };
  await f.command('on');
  assert.match(confirmation, /resume automatically/);
  assert.match(confirmation, /Output loss does not stop the selected microphone/);
  assert.match(confirmation, /Off\/pause.*recovery/);
});

test('missing playback does not wake update-only summaries or accept unsafe alternate capture events', async t => {
  const f = await armed(t);
  availability(f, false, false);
  f.audio({ type: 'addressed', id: 'unavailable' });
  f.audio({ type: 'utterance', id: 'unavailable', text: 'Must not be admitted.' });
  assert.equal(f.messages.length, 0);
  let wake = false;
  f.events.emit('paj:messages:delivering:v1', { sessionId: 'session-one', messageIds: ['offline'],
    requestTurn() { wake = true; } });
  assert.equal(wake, false);
});
