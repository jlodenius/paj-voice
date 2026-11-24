import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';

const final = text => ({ role: 'assistant', stopReason: 'stop',
  content: [{ type: 'text', text }] });
const speech = f => f.frames.filter(frame => frame.type === 'speak');
async function armed(t) {
  const f = fixture();
  t.after(() => f.command('off'));
  await f.command('on'); f.audio({ type: 'ready' });
  f.controller.api.registerReporter({ id: 'reporter', instructions: 'Own narration.' });
  return f;
}
async function start(f, inbox = false) {
  if (inbox) f.events.emit('paj:messages:delivering:v1', { sessionId: 'session-one',
    messageIds: ['review'], requestTurn() {} });
  else await f.event('input', { source: 'extension', text: 'Explain the result aloud.' });
  await f.event('before_agent_start', { messageType: inbox ? 'custom' : 'user' });
  await f.event('agent_start');
  await f.event('context', { messages: inbox ? [{ role: 'custom', customType: 'paj-messages',
    content: 'Untrusted worker data.', details: { messageIds: ['review'] } }] : [] });
}

test('a short meaningful inbox final containing a literal bracketed label speaks instead of a missing-summary fallback', async t => {
  const f = await armed(t);
  await start(f, true);
  const summary = 'The voice-label change is implemented and tested: yellow “[Voice request]” text without the purple background. It is not published yet.';
  await f.event('message_end', { message: final(summary) });
  await f.event('agent_settled');
  assert.deepEqual(speech(f).map(frame => frame.text), ['A Paj agent message arrived.', summary]);
});

test('an intentional voice_speak answer followed by its screen final is not followed by generic completion', async t => {
  const f = await armed(t);
  await start(f);
  await f.tools.get('voice_speak').execute('answer', { ...f.controller.state(),
    text: 'The review is complete and the tests passed.' });
  await f.event('message_end', { message: final('The review is complete and its tests passed. The implementation is ready.') });
  await f.event('agent_settled');
  await f.event('agent_settled');
  assert.deepEqual(speech(f).map(frame => frame.text), ['The review is complete and the tests passed.']);
});

test('unmarked inbox tool speech cannot satisfy a separate real-user outcome obligation', async t => {
  const f = await armed(t);
  await start(f);
  await start(f, true);
  await f.tools.get('voice_speak').execute('inbox', { ...f.controller.state(),
    text: 'The worker is still checking the change.' });
  await f.event('agent_settled');
  assert.match(speech(f).at(-1).text, /did not produce a spoken summary/);
});

test('empty, oversized or structured Markdown inbox finals still retain missing-summary protection', async t => {
  for (const text of ['', 'Long '.repeat(100), '[docs](relative-path)', '[docs][reference]', '**bold**']) {
    const f = await armed(t);
    await start(f, true);
    await f.event('message_end', { message: final(text) });
    await f.event('agent_settled');
    assert.equal(speech(f).at(-1).key, 'fallback');
  }
});

test('a speech tool call rejected by transport cannot satisfy an answer obligation', async t => {
  const f = await armed(t);
  await start(f);
  const worker = f.workers.at(-1), send = worker.send;
  worker.send = () => false;
  const result = await f.tools.get('voice_speak').execute('failed-answer', { ...f.controller.state(),
    text: 'The result is ready.' });
  assert.equal(result.details.status, 'unavailable');
  worker.send = send;
  await f.event('agent_settled');
  assert.equal(speech(f).at(-1).key, 'fallback');
});

test('explicit progress remains distinct from an actual answer', async t => {
  const f = await armed(t);
  await start(f);
  await f.tools.get('voice_speak').execute('progress', { ...f.controller.state(),
    purpose: 'progress', text: 'I am checking the tests.' });
  await f.event('agent_settled');
  assert.equal(speech(f).at(-1).key, 'fallback');
});
