import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceController } from '../src/controller.ts';

function fixture(overrides = {}) {
  let now = 0, sequence = 0;
  const timers = new Map(), sent = [];
  const controller = createVoiceController({
    uuid: () => `availability-${++sequence}`,
    send: frame => sent.push(frame),
    submit: () => ({}),
    setTimer(fn, delay) {
      const id = ++sequence;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimer: id => timers.delete(id),
    ...overrides,
  });
  const event = frame => controller.event(frame, controller.state().generation);
  const advance = milliseconds => {
    const end = now + milliseconds;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    now = end;
  };
  const speeches = () => sent.filter(frame => frame.type === 'speak');
  const finish = () => {
    for (const frame of speeches()) {
      event({ type: 'speech_start', id: frame.id });
      event({ type: 'speech_end', id: frame.id });
    }
  };
  controller.start('session');
  event({ type: 'ready' });
  return { controller, event, advance, speeches, finish, timers };
}

test('user feedback switches disable unsolicited notices and receipt wording stays configurable', () => {
  const f = fixture();
  f.controller.stop();
  f.controller.configureFeedback({ receipt: 'Received.', steeringReceipt: 'Updating direction.',
    progressUpdates: false, idleReminders: false });
  f.controller.start('session');
  f.event({ type: 'ready' });
  f.advance(600_000);
  assert.equal(f.speeches().length, 0);
  f.event({ type: 'addressed', id: 'first' });
  f.event({ type: 'utterance', id: 'first', text: 'A request.' });
  assert.equal(f.speeches().at(-1).text, 'Received.');
  f.finish();
  f.controller.newRun();
  f.advance(600_000);
  assert.equal(f.speeches().length, 1);
  f.controller.settled();
  assert.equal(f.speeches().at(-1).key, 'fallback');
  f.finish();
  const before = f.speeches().length;
  f.advance(600_000);
  assert.equal(f.speeches().length, before);
  f.controller.dispose();
});

test('long work gets minute-spaced progress from active tool status, not stale output', () => {
  const f = fixture();
  f.controller.newRun();
  f.controller.toolStarted('command-1', 'bash');
  f.advance(59_999);
  assert.equal(f.speeches().length, 0);
  f.advance(1);
  assert.equal(f.speeches().at(-1).text, 'Running a command.');
  f.finish();
  f.controller.toolEnded('command-1');
  f.advance(60_000);
  assert.equal(f.speeches().at(-1).text, 'Still working.');
  f.finish();
  f.controller.settled();
  assert.equal(f.speeches().at(-1).key, 'fallback');
  f.finish();
  const before = f.speeches().filter(frame => frame.key === 'progress-status').length;
  f.advance(120_000);
  assert.equal(f.speeches().filter(frame => frame.key === 'progress-status').length, before);
  f.controller.dispose();
});

test('progress stays brief, waits for speech and confirmations, and cancels on off', () => {
  const f = fixture();
  f.controller.newRun();
  f.controller.toolStarted('unknown', 'constructor');
  f.advance(60_000);
  assert.equal(f.speeches().at(-1).text, 'Still working.');
  const count = f.speeches().length;
  f.advance(180_000);
  assert.equal(f.speeches().length, count);
  f.finish();
  f.controller.blocked(true);
  f.advance(180_000);
  assert.equal(f.speeches().length, count);
  f.controller.blocked(false);
  f.controller.api.speak({ ...f.controller.state(), text: 'Checking the playback queue.' });
  f.finish();
  f.advance(59_999);
  assert.equal(f.speeches().at(-1).text, 'Checking the playback queue.');
  f.advance(1);
  assert.equal(f.speeches().at(-1).key, 'progress-status');
  assert.ok(f.speeches().filter(frame => frame.key === 'progress-status')
    .every(frame => frame.text.split(/\s+/u).length <= 6));
  f.finish();
  f.controller.stop();
  f.advance(180_000);
  assert.equal(f.timers.size, 0);
  assert.equal(f.speeches().filter(frame => frame.key === 'progress-status').length, 2);
  f.controller.dispose();
});

test('uncertain delivery is not described as idle and duplicate settle events invent no completion', () => {
  const f = fixture({ submit() { throw new Error('Delivery unknown'); } });
  f.controller.settled();
  assert.equal(f.speeches().length, 0);
  f.event({ type: 'addressed', id: 'uncertain' });
  f.event({ type: 'utterance', id: 'uncertain', text: 'Check this.' });
  f.finish();
  f.advance(600_000);
  assert.equal(f.speeches().length, 1);
  assert.match(f.speeches()[0].text, /uncertain/);
  f.controller.dispose();
});

test('settling after a progress update announces completion once, without claiming success', () => {
  const f = fixture();
  f.controller.newRun();
  f.controller.api.speak({ ...f.controller.state(), text: 'I’m checking the tests.' });
  f.controller.settled();
  assert.equal(f.speeches().at(-1).text, 'I’m finished for now.');
  const count = f.speeches().length;
  f.controller.settled();
  assert.equal(f.speeches().length, count);
  f.controller.dispose();
});

test('a queued request suppresses availability before agent startup', () => {
  const f = fixture();
  f.event({ type: 'addressed', id: 'request' });
  f.event({ type: 'utterance', id: 'request', text: 'Run the checks.' });
  f.finish();
  const count = f.speeches().length;
  f.advance(600_000);
  assert.equal(f.speeches().length, count);
  f.controller.newRun();
  f.advance(600_000);
  assert.equal(f.speeches().filter(frame => frame.key === 'idle-reminder').length, 0);
  assert.equal(f.speeches().at(-1).key, 'progress-status');
  f.controller.settled();
  f.finish();
  f.advance(60_000);
  assert.equal(f.speeches().at(-1).key, 'idle-reminder');
  f.controller.dispose();
});

test('capture and blocking confirmations defer availability until a fresh quiet minute', () => {
  const f = fixture();
  f.advance(59_000);
  f.event({ type: 'addressed', id: 'first' });
  f.event({ type: 'addressed', id: 'second' });
  f.event({ type: 'cancelled', id: 'first' });
  f.advance(120_000);
  assert.equal(f.speeches().length, 0);
  f.event({ type: 'cancelled', id: 'second' });
  f.controller.blocked(true);
  f.advance(120_000);
  assert.equal(f.speeches().length, 0);
  f.controller.blocked(false);
  f.advance(59_999);
  assert.equal(f.speeches().length, 0);
  f.advance(1);
  assert.equal(f.speeches().at(-1).key, 'idle-reminder');
  f.controller.dispose();
});

test('off, mute and disposal cancel reminders and fence stale callbacks after rearming', () => {
  for (const action of ['stop', 'mute', 'dispose']) {
    const f = fixture();
    const stale = [...f.timers.values()][0].fn;
    if (action === 'mute') f.controller.mute(true);
    else f.controller[action]();
    stale();
    f.advance(600_000);
    assert.equal(f.speeches().length, 0);
    assert.equal(f.timers.size, 0);
    if (action === 'stop') {
      f.controller.start('new-session');
      f.event({ type: 'ready' });
      stale();
      assert.equal(f.speeches().length, 0);
      f.advance(60_000);
      assert.equal(f.speeches().length, 1);
    }
    f.controller.dispose();
  }
});

test('a spoken final answer is not duplicated and cancellation never claims completion', () => {
  const f = fixture();
  f.controller.newRun();
  f.controller.answer({ ...f.controller.state(), text: 'The tests passed.' });
  f.controller.settled();
  assert.equal(f.speeches().length, 1);
  f.finish();
  f.controller.newRun();
  f.controller.api.speak({ ...f.controller.state(), text: 'I’m checking.' });
  f.controller.settled(true);
  assert.equal(f.speeches().at(-1).text, 'The agent stopped.');
  f.controller.dispose();
});

test('availability is spoken after a minute, at most three times until new activity', () => {
  const f = fixture();
  f.advance(59_999);
  assert.equal(f.speeches().length, 0);
  f.advance(1);
  assert.equal(f.speeches()[0]?.text, 'I’m available and have nothing in progress.');
  f.advance(180_000);
  assert.equal(f.speeches().length, 1);
  f.finish();
  for (let count = 2; count <= 3; count++) {
    f.advance(60_000);
    assert.equal(f.speeches().length, count);
    f.finish();
  }
  f.advance(600_000);
  assert.equal(f.speeches().length, 3);
  f.controller.newRun();
  f.advance(600_000);
  assert.equal(f.speeches().filter(frame => frame.key === 'idle-reminder').length, 3);
  assert.equal(f.speeches().at(-1).key, 'progress-status');
  f.controller.settled();
  f.finish();
  const before = f.speeches().length;
  f.advance(60_000);
  assert.equal(f.speeches().length, before + 1);
  assert.equal(f.speeches().at(-1).key, 'idle-reminder');
  f.controller.dispose();
});
