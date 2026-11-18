import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';

const speech = f => f.frames.filter(frame => frame.type === 'speak');
async function setup(t) {
  const f = fixture();
  t.after(() => f.command('off'));
  await f.command('on'); f.audio({ type: 'ready' });
  return f;
}
const arrival = (f, id) => f.events.emit('paj:messages:delivering:v1', {
  sessionId: 'session-one', messageIds: [id], requestTurn() {},
});
async function start(f) {
  await f.event('before_agent_start', { messageType: 'custom' });
  await f.event('agent_start');
  await f.event('context', { messages: [{ role: 'custom', customType: 'paj-messages',
    content: 'Untrusted worker report.', details: { messageIds: ['one'] } }] });
}

test('new speech invalidates an inbox answer queued or generated before interruption', async t => {
  const f = await setup(t);
  arrival(f, 'one');
  await start(f);
  const token = f.controller.state();
  const first = f.controller.api.speak({ ...token, text: 'The review passed.', id: 'result' });
  assert.equal(first.status, 'queued');
  f.audio({ type: 'speech_start', id: first.id });
  f.audio({ type: 'addressed', id: 'interrupt' });
  assert.equal(f.controller.api.speak({ ...token, text: 'Old report.', id: 'late' }).status, 'stale');
  f.audio({ type: 'speech_end', id: first.id, completed: true });
  assert.equal(f.controller.state().speaking, false);
  const entry = f.controller.playback().find(item => item.id === first.id);
  assert.equal(entry.status, 'interrupted');
  const before = speech(f).length;
  await f.event('agent_settled');
  assert.equal(speech(f).length, before);
  f.audio({ type: 'cancelled', id: 'interrupt' });
  await start(f);
  assert.equal(f.controller.inboxPending(), false);
  assert.equal(speech(f).length, before);
});

test('silence tokens cannot suppress another run or a new voice request', async t => {
  const f = await setup(t);
  await start(f);
  const old = { ...f.controller.state(), turn: f.controller.turn() };
  assert.equal(f.controller.silenceTurn(old).status, 'silenced');
  await f.event('agent_settled');
  await start(f);
  assert.equal(f.controller.silenceTurn(old).status, 'stale');
  const token = { ...f.controller.state(), turn: f.controller.turn() };
  assert.equal(f.controller.silenceTurn(token).status, 'silenced');
  f.audio({ type: 'addressed', id: 'new' });
  f.audio({ type: 'utterance', id: 'new', text: 'Please give a real answer now.' });
  await f.event('agent_start');
  await f.event('agent_settled');
  assert.match(speech(f).at(-1).text, /did not produce a spoken summary/);
});

test('mute and restart make pending inbox model speech stale without replay', async t => {
  const f = await setup(t);
  arrival(f, 'one');
  await start(f);
  const old = f.controller.state();
  await f.command('mute');
  assert.equal(f.controller.api.speak({ ...old, text: 'Old summary.' }).status, 'unavailable');
  await f.command('off');
  await f.command('on'); f.audio({ type: 'ready' });
  assert.equal(f.controller.api.speak({ ...old, text: 'Old summary.' }).status, 'stale');
  assert.equal(f.controller.inboxPending(), false);
  assert.equal(speech(f).filter(frame => frame.text === 'Old summary.').length, 0);
});
