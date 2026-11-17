import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceController } from '../src/controller.js';

function fixture() {
  let sequence = 0;
  const sent = [];
  const controller = createVoiceController({ uuid: () => `delivery-${++sequence}`,
    send: frame => sent.push(frame), submit() {} });
  controller.start('session');
  const event = frame => controller.event(frame, controller.state().generation);
  event({ type: 'ready' });
  const speak = text => controller.api.speak({ ...controller.state(), text }).id;
  return { controller, event, speak, sent };
}

test('delivery distinguishes queued, started and explicitly completed software playback', () => {
  const f = fixture();
  const id = f.speak('The checks passed.');
  assert.equal(f.controller.playback()[0].status, 'queued');
  f.event({ type: 'speech_start', id });
  assert.equal(f.controller.playback()[0].status, 'started');
  f.event({ type: 'speech_end', id, completed: true });
  assert.equal(f.controller.playback()[0].status, 'completed');
  assert.equal(f.controller.playback()[0].started, true);
  f.event({ type: 'addressed', id: 'new-request' });
  assert.equal(f.controller.playback()[0].status, 'completed');
  f.controller.dispose();
});

test('interruption retains queued and partially started replies but ignores late completion', () => {
  for (const started of [false, true]) {
    const f = fixture();
    const id = f.speak('Here are the shorter receipt options.');
    if (started) f.event({ type: 'speech_start', id });
    f.event({ type: 'addressed', id: 'continuation' });
    f.event({ type: 'speech_end', id, completed: true });
    assert.deepEqual(f.controller.playback().map(record => [record.status, record.started, record.reason]),
      [['interrupted', started, 'new_speech']]);
    assert.equal(f.sent.filter(frame => frame.type === 'speak').length, 1);
    f.controller.dispose();
  }
});

test('discarded or unconfirmed end frames never claim completed playback', () => {
  for (const completed of [false, undefined]) {
    const f = fixture();
    const id = f.speak('A response.');
    f.event({ type: 'speech_end', id, completed });
    assert.equal(f.controller.playback()[0].status, 'interrupted');
    assert.equal(f.controller.playback()[0].reason, 'not_completed');
    f.controller.dispose();
  }
});

test('manual stop remains distinct, snapshots are isolated, and history is bounded and session-local', () => {
  const f = fixture();
  for (let index = 0; index < 20; index++) f.speak(`Reply ${index}.`);
  assert.equal(f.controller.playback().length, 16);
  assert.equal(f.controller.playback()[0].text, 'Reply 4.');
  f.controller.silence();
  assert.ok(f.controller.playback().every(record => record.reason === 'manual_stop'));
  f.controller.playback()[0].text = 'Modified snapshot.';
  assert.equal(f.controller.playback()[0].text, 'Reply 4.');
  const old = f.controller.state().generation;
  f.controller.stop();
  assert.deepEqual(f.controller.playback(), []);
  f.controller.start('another-session');
  f.event({ type: 'ready' });
  f.controller.event({ type: 'speech_end', id: 'delivery-2', completed: true }, old);
  assert.deepEqual(f.controller.playback(), []);
  f.controller.dispose();
});
