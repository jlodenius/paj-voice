import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceController } from '../src/controller.ts';
import { fixture as extension } from './fixtures/extension.js';

function fixture() {
  let now = 0, sequence = 0;
  const timers = new Map(), frames = [];
  const controller = createVoiceController({ uuid: () => `idle-${++sequence}`,
    submit: () => ({}), send: frame => frames.push(frame),
    setTimer(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, at: now + delay });
      return id;
    }, clearTimer: id => timers.delete(id) });
  const event = frame => controller.event(frame, controller.state().generation);
  const advance = delay => {
    const until = now + delay;
    for (;;) {
      const next = [...timers].filter(([, value]) => value.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = until;
  };
  const finish = () => {
    for (const frame of frames.filter(frame => frame.type === 'speak')) {
      event({ type: 'speech_start', id: frame.id });
      event({ type: 'speech_end', id: frame.id, completed: true });
    }
  };
  controller.start('session');
  event({ type: 'ready' });
  return { controller, event, advance, finish, frames, timers,
    reminders: () => frames.filter(frame => frame.key === 'idle-reminder') };
}

test('acknowledgement stops the idle cycle without its own confirmation or retries rearming it', t => {
  const f = fixture();
  t.after(() => f.controller.dispose());
  f.advance(60_000);
  assert.equal(f.reminders().length, 1);
  f.finish();
  const stale = [...f.timers.values()][0].callback;
  f.event({ type: 'addressed', id: 'ack' });
  f.event({ type: 'utterance', id: 'ack', text: 'I know you are available.' });
  f.controller.newRun();
  const token = f.controller.state();
  assert.equal(f.controller.acknowledgeIdle(token).status, 'acknowledged');
  assert.equal(f.controller.acknowledgeIdle(token).status, 'already_acknowledged');
  f.controller.newRun();
  f.controller.answer({ ...token, text: 'Okay, I will stop announcing it.' });
  f.controller.settled();
  f.finish();
  stale();
  f.advance(600_000);
  assert.equal(f.reminders().length, 1);
  assert.equal(f.frames.filter(frame => frame.text === 'Okay, I will stop announcing it.').length, 1);
  f.controller.newRun({ summaryExpected: false });
  f.controller.settled();
  f.finish();
  f.advance(600_000);
  assert.equal(f.reminders().length, 1);
});

test('a new request or Voice restart re-enables the ordinary minute-spaced reminders', t => {
  for (const action of ['voice', 'input', 'work', 'restart']) {
    const f = fixture();
    t.after(() => f.controller.dispose());
    f.controller.acknowledgeIdle(f.controller.state());
    f.advance(600_000);
    assert.equal(f.reminders().length, 0);
    if (action === 'restart') {
      f.controller.stop(); f.controller.start('session'); f.event({ type: 'ready' });
    } else {
      if (action === 'voice') {
        f.event({ type: 'addressed', id: 'new' });
        f.event({ type: 'utterance', id: 'new', text: 'Check the files.' });
      } else if (action === 'input') f.controller.expectSummary({ fromUser: true });
      f.controller.newRun();
      f.controller.answer({ ...f.controller.state(), text: 'The check is complete.' });
      f.controller.settled(); f.finish();
    }
    f.advance(59_999);
    assert.equal(f.reminders().length, 0);
    f.advance(1);
    assert.equal(f.reminders().length, 1);
  }
});

test('stale or unavailable acknowledgement cannot silence another generation or user turn', t => {
  const f = fixture();
  t.after(() => f.controller.dispose());
  const old = f.controller.state();
  f.event({ type: 'addressed', id: 'next' });
  f.event({ type: 'cancelled', id: 'next' });
  assert.equal(f.controller.acknowledgeIdle(old).status, 'stale');
  f.advance(60_000);
  assert.equal(f.reminders().length, 1);
  f.controller.mute(true);
  assert.equal(f.controller.acknowledgeIdle(f.controller.state()).status, 'unavailable');
  f.controller.stop();
  assert.equal(f.controller.acknowledgeIdle(old).status, 'stale');
});

test('acknowledgement confirmation and later short answers work with a reporting integration', async t => {
  const f = extension();
  t.after(() => f.command('off'));
  f.controller.api.registerReporter({ id: 'reporter', instructions: 'Report outcomes aloud.' });
  await f.command('on'); f.audio({ type: 'ready' });
  await f.event('agent_start'); await f.event('context', { messages: [] });
  await f.tools.get('voice_acknowledge_idle').execute('ack', f.controller.state());
  await f.event('message_end', { message: { role: 'assistant', stopReason: 'stop',
    content: [{ type: 'text', text: 'Okay, I will stop announcing it.' }] } });
  await f.event('agent_settled');
  assert.deepEqual(f.frames.filter(frame => frame.type === 'speak').map(frame => frame.text),
    ['Okay, I will stop announcing it.']);
  await f.event('input', { source: 'extension', text: 'New work.' });
  await f.event('agent_start'); await f.event('context', { messages: [] });
  await f.event('message_end', { message: { role: 'assistant', stopReason: 'stop',
    content: [{ type: 'text', text: 'A different result.' }] } });
  assert.equal(f.frames.filter(frame => frame.text === 'A different result.').length, 1);
});

test('the agent acknowledgement tool changes only reminders and supports one plain final confirmation', async t => {
  const f = extension();
  t.after(() => f.command('off'));
  const tool = () => f.tools.get('voice_acknowledge_idle');
  assert.equal(tool().exposure, 'hidden');
  await f.command('on'); f.audio({ type: 'ready' });
  assert.equal(tool().exposure, 'direct');
  const token = f.controller.state();
  await f.event('agent_start'); await f.event('context', { messages: [] });
  const before = f.workers.length;
  const result = await tool().execute('ack', token);
  assert.equal(result.details.status, 'acknowledged');
  assert.equal(f.controller.state().generation, token.generation);
  assert.equal(f.controller.state().muted, false);
  assert.equal(f.workers.length, before);
  await f.event('message_end', { message: { role: 'assistant', stopReason: 'stop',
    content: [{ type: 'text', text: 'Okay, I will stop announcing it.' }] } });
  await f.event('agent_settled');
  assert.deepEqual(f.frames.filter(frame => frame.type === 'speak').map(frame => frame.text),
    ['Okay, I will stop announcing it.']);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(() => tool().execute('cancelled', token, aborted.signal));
  await f.command('off');
  assert.equal(tool().exposure, 'hidden');
});
