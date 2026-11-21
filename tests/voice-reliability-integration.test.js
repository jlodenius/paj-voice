import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';

const final = text => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] });

test('rejected noise and a confirmed mic pause preserve fresh inbox narration and cleanup diagnostics', async t => {
  let diagnostic;
  const f = fixture({ loadConfig: () => ({ audioDucking: { enabled: true } }),
    startAudioFocus(_settings, options) {
      diagnostic = options.onDiagnostic;
      return {
        playing() { diagnostic({ component: 'client', operation: 'set', reason: 'ack_timeout' }); },
        idle() {},
        async close() { diagnostic({ component: 'client', operation: 'close', reason: 'cleanup_failed' }); },
      };
    } });
  t.after(() => f.command('off'));
  const retries = [];
  f.pi.sendMessage = message => retries.push(message);
  await f.command('on');
  f.audio({ type: 'ready' });
  f.audio({ type: 'addressed', id: 'question' });
  f.audio({ type: 'utterance', id: 'question', text: 'Check the review.' });
  const userMessages = f.messages.map(([content]) => ({ role: 'user', content }));
  await f.event('before_agent_start', { messageType: 'user' });
  await f.event('agent_start');
  await f.event('context', { messages: userMessages });
  await f.event('message_end', { message: final('I will check the review.') });
  await f.event('agent_settled');
  f.audio({ type: 'addressed', id: 'noise' });
  f.audio({ type: 'cancelled', id: 'noise', reason: 'unreliable_speech' });
  assert.equal(f.messages.length, 1);
  await f.command('mute 10 seconds');
  const pause = f.frames.findLast(frame => frame.type === 'input_pause');
  assert.equal(f.controller.state().inputPause, 'pausing');
  f.audio({ type: 'input_pause_state', id: pause.id, phase: 'paused', remainingMs: 9500 });
  const inbox = { role: 'custom', customType: 'paj-messages', content: 'An agent update.',
    details: { messageIds: ['review-update'] } };
  f.events.emit('paj:messages:delivering:v1', { sessionId: 'session-one',
    messageIds: ['review-update'], requestTurn() {} });
  await f.event('before_agent_start', { messageType: 'custom', message: inbox });
  await f.event('agent_start');
  await f.event('context', { messages: [...userMessages, inbox] });
  await f.event('message_end', { message: final('') });
  await f.event('agent_settled');
  assert.equal(retries.length, 1);
  await f.event('before_agent_start', { messageType: 'custom', message: retries[0] });
  await f.event('agent_start');
  await f.event('context', { messages: [...userMessages, inbox, { role: 'custom', ...retries[0] }] });
  const summary = 'The worker finished the review with no blocking issues.';
  await f.event('message_end', { message: final(summary) });
  await f.event('agent_settled');
  assert.equal(f.frames.filter(frame => frame.type === 'speak' && frame.text === summary).length, 1);
  assert.equal(f.controller.state().inputPause, 'paused');
  assert.equal(f.controller.state().listening, false);
  assert.equal(f.controller.state().outputAvailable, true);
  assert.equal(f.messages.length, 1);
  assert.equal(f.workers[0].closed, false);
  f.audio({ type: 'playback_state', id: 'summary-playback', outputEpoch: 1, playbackGeneration: 1, playing: true });
  await f.command('off');
  await new Promise(resolve => setImmediate(resolve));
  const frameCount = f.frames.length;
  await f.command('ducking diagnostics');
  assert.match(f.notices.at(-1)[0], /ack_timeout.*cleanup_failed/);
  assert.equal(f.frames.length, frameCount);
  assert.equal(f.workers.length, 1);
  await f.event('session_start');
  diagnostic({ component: 'client', operation: 'set', reason: 'ack_timeout' });
  await f.command('ducking diagnostics');
  assert.match(f.notices.at(-1)[0], /\[\]$/);
});
