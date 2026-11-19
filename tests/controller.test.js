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

test('timed pause remains unconfirmed until native closure acknowledgement and times out safely', () => {
  const timers = new Map(), sent = [], notices = [];
  let serial = 0, closes = 0;
  const c = createVoiceController({ submit() { assert.fail('Unconfirmed capture must not submit'); },
    send: frame => { sent.push(frame); return true; }, close: () => closes++,
    notify: (...args) => notices.push(args), setTimer(fn, delay) { const id = ++serial; timers.set(id, { fn, delay }); return id; },
    clearTimer: id => timers.delete(id) });
  const token = c.start('s');
  const event = frame => c.event(frame, token.generation);
  event({ type: 'ready' });
  assert.equal(c.pauseInput(10, c.state(), 'pending').status, 'requested');
  assert.equal(c.state().inputPause, 'pausing');
  assert.equal(c.state().inputPauseRemainingMs, 0);
  event({ type: 'addressed', id: 'late' });
  event({ type: 'utterance', id: 'late', text: 'Must not submit' });
  event({ type: 'input_pause_state', id: 'wrong', phase: 'paused', remainingMs: 9000 });
  assert.equal(c.state().inputPause, 'pausing');
  const deadline = [...timers.values()].find(timer => timer.delay === 3000).fn;
  event({ type: 'input_pause_state', id: 'pending', phase: 'paused', remainingMs: 6500 });
  assert.equal(c.state().inputPause, 'paused');
  assert.equal(c.state().inputPauseRemainingMs, 6500);
  deadline();
  assert.equal(closes, 0);
  c.pauseInput(5, c.state(), 'missing');
  [...timers.values()].find(timer => timer.delay === 3000).fn();
  assert.equal(closes, 1);
  assert.equal(c.state().inputPause, 'unconfirmed');
  assert.equal(c.state().listening, false);
  assert.equal(sent.at(-1).type, 'shutdown');
  assert.match(notices.at(-1)[0], /closure.*unconfirmed/i);
  event({ type: 'input_pause_state', id: 'missing', phase: 'paused', remainingMs: 4000 });
  event({ type: 'input_pause_state', id: 'missing', phase: 'resumed', remainingMs: 0, listening: true });
  assert.equal(c.state().inputPause, 'unconfirmed');
  assert.equal(c.state().listening, false);
  c.dispose();
});

test('unconfirmed pause transport failure and stop intent cannot accept a late acknowledgement', () => {
  for (const action of ['transport', 'throw', 'stop', 'off', 'session']) {
    const timers = new Map(), notices = [];
    let n = 0, closes = 0;
    const c = createVoiceController({ submit() {},
      send(frame) { if (frame.type === 'input_pause' && action === 'throw') throw new Error('Lost transport');
        return action !== 'transport'; }, close: () => closes++, notify: (...args) => notices.push(args),
      setTimer(fn, delay) { const id = ++n; timers.set(id, { fn, delay }); return id; }, clearTimer: id => timers.delete(id) });
    const token = c.start('s');
    c.event({ type: 'ready' }, token.generation);
    const result = c.pauseInput(10, c.state(), 'pending');
    if (action === 'transport' || action === 'throw') {
      assert.equal(result.status, 'unavailable');
      assert.equal(closes, 1);
      assert.match(notices.at(-1)[0], /closure.*unconfirmed/i);
    } else {
      const staleTimer = [...timers.values()].find(timer => timer.delay === 3000).fn;
      if (action === 'stop') c.silence();
      else { c.stop(); if (action === 'session') c.start('other'); }
      staleTimer();
      assert.equal(closes, action === 'stop' ? 1 : 0);
    }
    c.event({ type: 'input_pause_state', id: 'pending', phase: 'paused', remainingMs: 9000 }, token.generation);
    c.event({ type: 'input_pause_state', id: 'pending', phase: 'resumed', remainingMs: 0, listening: true }, token.generation);
    assert.equal(c.state().listening, false, action);
    assert.notEqual(c.state().inputPause, 'paused', action);
    c.dispose();
  }
});

test('timed microphone pause fences recognition immediately without stopping speech or work', () => {
  const f = fixture();
  f.event({ type: 'addressed', id: 'partial' });
  const token = f.controller.state();
  f.speak('An answer.', { id: 'answer' });
  const before = f.sent.length;
  assert.equal(f.controller.pauseInput(10, token, 'pause-one').status, 'requested');
  assert.deepEqual(f.sent.slice(before), [{ type: 'input_pause', id: 'pause-one', seconds: 10 }]);
  assert.equal(f.controller.state().epoch, token.epoch);
  assert.equal(f.controller.state().inputPause, 'pausing');
  assert.equal(f.controller.state().listening, false);
  f.event({ type: 'utterance', id: 'partial', text: 'Never submit this.' });
  f.event({ type: 'addressed', id: 'late' });
  f.event({ type: 'review', id: 'late', text: 'Never recover this.' });
  assert.equal(f.submitted.length, 0);
  assert.equal(f.speak('Work continues.').status, 'queued');
  assert.equal(f.controller.pauseInput(10, token, 'pause-one').status, 'duplicate');
  assert.equal(f.controller.pauseInput(0, token).status, 'invalid');
  assert.equal(f.controller.pauseInput(301, token).status, 'invalid');
  assert.equal(f.controller.pauseInput(1.5, token).status, 'invalid');
  assert.equal(f.controller.pauseInput(10, { ...token, epoch: token.epoch - 1 }).status, 'stale');
  f.event({ type: 'input_pause_state', id: 'wrong', phase: 'resumed', remainingMs: 0 });
  assert.equal(f.controller.state().inputPause, 'pausing');
  f.event({ type: 'input_pause_state', id: 'pause-one', phase: 'warming', remainingMs: 0 });
  assert.equal(f.controller.state().inputPause, 'warming');
  assert.equal(f.controller.state().listening, false);
  f.event({ type: 'availability', input: true, output: true, listening: true });
  f.event({ type: 'input_pause_state', id: 'pause-one', phase: 'resumed', remainingMs: 0, listening: true });
  assert.equal(f.controller.state().inputPause, null);
  assert.equal(f.controller.state().listening, true);
  f.controller.dispose();
});

test('timed request history never evicts an ID and accidentally extends a retried pause', () => {
  const f = fixture();
  const token = f.controller.state();
  for (let index = 0; index < 512; index++) {
    assert.equal(f.controller.pauseInput(10, token, `pause-${index}`).status, 'requested');
  }
  assert.equal(f.controller.pauseInput(10, token, 'over-limit').status, 'unavailable');
  assert.equal(f.controller.pauseInput(10, token, 'pause-0').status, 'duplicate');
  assert.equal(f.sent.filter(frame => frame.type === 'input_pause').length, 512);
  f.controller.dispose();
});

test('timed input pause never arms off, starting, fully paused or stale generations', () => {
  const c = createVoiceController({ submit() {}, send() {} });
  assert.equal(c.pauseInput(10, c.state()).status, 'unavailable');
  const token = c.start('s');
  assert.equal(c.pauseInput(10, token).status, 'unavailable');
  c.event({ type: 'ready' }, token.generation);
  c.mute(true);
  assert.equal(c.pauseInput(10, c.state()).status, 'unavailable');
  c.stop();
  assert.equal(c.pauseInput(10, token).status, 'stale');
});

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
