import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceController } from '../src/controller.ts';

function fixture() {
  const sent = [], submitted = [], notifications = [], states = [];
  let n = 0;
  const controller = createVoiceController({ uuid: () => `id-${++n}`, send: frame => sent.push(frame),
    submit: params => { submitted.push(params); return { steering: submitted.length > 1 }; },
    notify: (...args) => notifications.push(args), changed: state => states.push(state) });
  const start = controller.start('session-a');
  const event = frame => controller.event(frame, start.generation);
  event({ type: 'ready' });
  const speak = (text = 'Done.', rest = {}) => controller.api.speak({ ...controller.state(), text, ...rest });
  return { controller, sent, submitted, states, notifications, event, speak, generation: start.generation };
}

test('microphone starts only explicitly, never after stop, and readiness gates speech', () => {
  const controller = createVoiceController({ submit() {}, send() {} });
  assert.equal(controller.state().enabled, false);
  const start = controller.start('s');
  assert.equal(controller.state().starting, true);
  assert.equal(controller.api.speak({ text: 'Done.', ...controller.state() }).status, 'unavailable');
  controller.event({ type: 'ready' }, start.generation);
  assert.equal(controller.state().enabled, true);
  controller.stop();
  controller.event({ type: 'ready' }, start.generation);
  assert.equal(controller.state().enabled, false);
});

test('addressed prefix stops old playback, invalidates stale speech and waits for addition', () => {
  const f = fixture();
  const old = f.controller.state();
  f.speak();
  f.event({ type: 'speech_start', id: f.sent.at(-1).id });
  assert.equal(f.controller.state().speaking, true);
  f.event({ type: 'addressed', id: 'utterance-1' });
  assert.equal(f.sent.at(-1).type, 'stop');
  assert.equal(f.controller.state().speaking, false);
  assert.equal(f.controller.api.speak({ text: 'Old answer.', ...old }).status, 'stale');
  assert.equal(f.speak().status, 'listening');
  const duringCapture = f.controller.state();
  f.event({ type: 'utterance', id: 'utterance-1', text: 'Focus on the tests.' });
  assert.equal(f.controller.api.speak({ text: 'Answer produced before the addition.', ...duringCapture }).status, 'stale');
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].text, 'Focus on the tests.');
  assert.equal(f.submitted[0].sessionId, 'session-a');
  assert.equal(f.speak().status, 'queued');
});

test('new requests and steering additions have distinct brief receipts', () => {
  const f = fixture();
  for (const id of ['first', 'addition']) {
    f.event({ type: 'addressed', id });
    f.event({ type: 'utterance', id, text: 'A request.' });
  }
  assert.deepEqual(f.sent.filter(frame => frame.key === 'receipt').map(frame => frame.text),
    ['Got it.', 'Steering received.']);
  f.controller.dispose();
});

test('unaddressed, duplicate, mismatched and disconnected utterances cannot be submitted', () => {
  const f = fixture();
  f.event({ type: 'utterance', id: 'random', text: 'Ignore this.' });
  f.event({ type: 'addressed', id: 'u1' });
  f.event({ type: 'utterance', id: 'wrong', text: 'Ignore this.' });
  f.event({ type: 'utterance', id: 'u1', text: 'Do this.' });
  f.event({ type: 'addressed', id: 'u1' });
  f.event({ type: 'utterance', id: 'u1', text: 'Do this.' });
  assert.equal(f.submitted.length, 1);
  f.controller.stop();
  f.event({ type: 'addressed', id: 'u2' });
  f.event({ type: 'utterance', id: 'u2', text: 'Wrong target.' });
  assert.equal(f.submitted.length, 1);
});

test('overlapping decode results preserve both requests and block audio until all captures resolve', () => {
  const f = fixture();
  f.event({ type: 'addressed', id: 'first' });
  f.event({ type: 'addressed', id: 'second' });
  f.event({ type: 'utterance', id: 'first', text: 'Inspect the tests.' });
  assert.equal(f.submitted.length, 1);
  assert.equal(f.speak().status, 'listening');
  f.event({ type: 'utterance', id: 'second', text: 'Focus on failures.' });
  assert.deepEqual(f.submitted.map(item => item.text), ['Inspect the tests.', 'Focus on failures.']);
  assert.equal(f.speak().status, 'queued');
});

test('mute cancels capture and invalidates outstanding utterances and announcements', () => {
  const f = fixture();
  f.event({ type: 'addressed', id: 'u1' });
  f.controller.mute(true);
  f.event({ type: 'utterance', id: 'u1', text: 'Ignore this.' });
  assert.equal(f.submitted.length, 0);
  assert.equal(f.speak().status, 'unavailable');
  assert.deepEqual(f.sent.at(-1), { type: 'mute', muted: true });
  f.controller.mute(false);
  assert.equal(f.speak().status, 'queued');
});

test('short speech only, deduplication, urgent interruption and no full answer fallback', () => {
  const f = fixture();
  assert.throws(() => f.speak('x'.repeat(321)), /320/);
  assert.throws(() => f.speak('a '.repeat(51)), /50 words/);
  assert.throws(() => f.speak('a\nb'), /plain text/);
  assert.equal(f.speak('Done.', { id: 'once' }).status, 'queued');
  assert.equal(f.speak('Done.', { id: 'once' }).status, 'duplicate');
  assert.throws(() => f.speak('Different.', { id: 'once' }), /conflict/);
  f.speak('I need your decision.', { priority: 'urgent' });
  assert.equal(f.sent.at(-2).type, 'stop');
  f.controller.newRun();
  f.controller.settled();
  assert.equal(f.sent.at(-1).text, 'I’ve finished this response, but did not produce a spoken summary. Ask me to summarize the result aloud.');
  const count = f.sent.length;
  f.controller.settled();
  assert.equal(f.sent.length, count);
});

test('reporters extend instructions without access to microphone activation or retargeting', () => {
  const f = fixture();
  const remove = f.controller.api.registerReporter({ id: 'captain', instructions: 'Brief orchestration updates.' });
  assert.equal(f.controller.state().reportingOwner, 'captain');
  assert.equal(f.controller.instructions(), 'Brief orchestration updates.');
  assert.equal(f.controller.api.start, undefined);
  assert.equal(f.controller.api.stop, undefined);
  assert.throws(() => f.controller.api.registerReporter({ id: 'captain', instructions: 'Duplicate.' }), /already/);
  remove(); remove();
  assert.equal(f.controller.state().reportingOwner, null);
});

test('uncertain submission is not retried and is not called executed', () => {
  let attempts = 0;
  const sent = [];
  const c = createVoiceController({ send: frame => sent.push(frame), submit() { attempts++; throw new Error('lost'); } });
  const { generation } = c.start('s');
  const emit = frame => c.event(frame, generation);
  emit({ type: 'ready' });
  emit({ type: 'addressed', id: 'u' });
  emit({ type: 'utterance', id: 'u', text: 'Do it.' });
  emit({ type: 'addressed', id: 'u' });
  emit({ type: 'utterance', id: 'u', text: 'Do it.' });
  assert.equal(attempts, 1);
  assert.match(sent.at(-1).text, /uncertain/);
});

test('retry runs preserve intentional speech and cancelled additions never resurrect an old fallback', () => {
  const f = fixture();
  f.controller.newRun();
  f.speak('Finished the checks.');
  const count = f.sent.length;
  f.controller.newRun();
  f.controller.settled();
  assert.equal(f.sent.length, count + 1);
  assert.equal(f.sent.at(-1).text, 'I’m finished for now.');
  f.controller.newRun();
  f.event({ type: 'addressed', id: 'cancelled-addition' });
  f.controller.settled();
  f.event({ type: 'cancelled', id: 'cancelled-addition' });
  const cancelled = f.sent.length;
  f.controller.settled();
  assert.equal(f.sent.length, cancelled);
});

test('stopping speech invalidates pending tool calls and late playback events', () => {
  const f = fixture();
  const token = f.controller.state();
  f.speak('Old update.', { id: 'old' });
  f.controller.silence();
  assert.equal(f.controller.api.speak({ ...token, text: 'Late update.' }).status, 'stale');
  f.event({ type: 'speech_start', id: 'old' });
  assert.equal(f.controller.state().speaking, false);
  f.controller.settled();
  assert.equal(f.sent.at(-1).type, 'stop');
});

test('throwing observers cannot turn confirmed dispatch into uncertain delivery or break teardown', () => {
  const sent = [];
  const c = createVoiceController({ submit: () => ({}), send: frame => sent.push(frame),
    notify() { throw new Error('observer'); }, changed() { throw new Error('observer'); } });
  const { generation } = c.start('s');
  c.event({ type: 'ready' }, generation);
  c.event({ type: 'addressed', id: 'u' }, generation);
  c.event({ type: 'utterance', id: 'u', text: 'Do it.' }, generation);
  assert.equal(sent.at(-1).text, 'Got it.');
  c.dispose();
  assert.throws(() => c.api.registerReporter({ id: 'late', instructions: 'No.' }), /closed/);
});

test('startup failures expose and retain the bounded native error after audio stops', () => {
  const notices = [];
  const c = createVoiceController({ submit() {}, send() {}, notify: text => notices.push(text) });
  const { generation } = c.start('s');
  assert.equal(c.event({ type: 'error', stage: 'capture-start', message: 'Selected source disappeared.\u001b' }, generation).fatal, true);
  c.stop();
  assert.match(c.state().lastError, /capture-start.*Selected source disappeared/);
  assert.ok(!c.state().lastError.includes('\u001b'));
  assert.ok(notices.some(text => text.includes('Selected source disappeared')));
});

test('failed audio writes are not reported as queued speech', () => {
  const c = createVoiceController({ submit() {}, send: () => false });
  const { generation } = c.start('s');
  c.event({ type: 'ready' }, generation);
  assert.equal(c.api.speak({ ...c.state(), text: 'Not delivered.' }).status, 'unavailable');
});
