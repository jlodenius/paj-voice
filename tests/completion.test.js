import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';

const missing = 'I’ve finished this response, but did not produce a spoken summary. Ask me to summarize the result aloud.';
const reply = text => ({ role: 'assistant', stopReason: 'stop',
  content: text ? [{ type: 'text', text }] : [] });
async function start(f, messageType) {
  await f.event('before_agent_start', messageType === 'user'
    ? { messageType, prompt: 'A user request.' }
    : { messageType, message: { role: 'custom', customType: 'paj-messages', content: 'Agent update.' } });
  await f.event('agent_start');
  await f.event('context', { messages: [] });
}
async function armed(t) {
  const f = fixture();
  t.after(() => f.command('off'));
  await f.command('on');
  f.audio({ type: 'ready' });
  return f;
}
const speech = f => f.frames.filter(frame => frame.type === 'speak').map(frame => frame.text);

test('silent background agent updates do not ask for a summary after a completed summary', async t => {
  const f = await armed(t);
  await start(f, 'user');
  await f.event('message_end', { message: reply('The fixes are published.') });
  const summary = f.frames.find(frame => frame.text === 'The fixes are published.');
  assert.ok(summary);
  f.audio({ type: 'speech_start', id: summary.id });
  f.audio({ type: 'speech_end', id: summary.id, completed: true });
  await f.event('agent_settled');
  const before = speech(f);
  for (let index = 0; index < 2; index++) {
    await start(f, 'custom');
    await f.event('tool_execution_start', { toolCallId: `read-${index}`, toolName: 'read' });
    await f.event('tool_execution_end', { toolCallId: `read-${index}`, toolName: 'read' });
    await f.event('agent_start');
    await f.event('message_end', { message: reply('') });
    await f.event('agent_settled');
  }
  assert.deepEqual(speech(f), before);
});

test('genuine new user requests still require their own spoken summary', async t => {
  const f = await armed(t);
  await start(f, 'custom');
  await f.event('message_end', { message: reply('') });
  await f.event('agent_settled');
  const before = speech(f).length;
  await start(f, 'user');
  await f.event('message_end', { message: reply('A long explanation. '.repeat(100)) });
  await f.event('agent_settled');
  assert.deepEqual(speech(f).slice(before), [missing]);
});

test('visible background results retain missing-summary protection when not narrated', async t => {
  const f = await armed(t);
  await start(f, 'custom');
  await f.event('message_end', { message: reply('A long result. '.repeat(100)) });
  await f.event('agent_settled');
  assert.deepEqual(speech(f), [missing]);
});

test('background results can be spoken normally without a second completion prompt', async t => {
  const f = await armed(t);
  await start(f, 'custom');
  await f.event('message_end', { message: reply('The review passed.') });
  await f.event('agent_settled');
  assert.deepEqual(speech(f), ['The review passed.']);
});

test('a queued SDK user input upgrades a background run to require an outcome', async t => {
  const f = await armed(t);
  await start(f, 'custom');
  await f.event('input', { source: 'extension', text: 'A new real user request.' });
  await f.event('agent_start');
  await f.event('message_end', { message: reply('') });
  await f.event('agent_settled');
  assert.equal(speech(f).at(-1), missing);
});

test('user input during background preparation survives initialization without leaking into later updates', async t => {
  const f = await armed(t);
  await f.event('before_agent_start', { messageType: 'custom',
    message: { role: 'custom', customType: 'paj-messages', content: 'Agent update.' } });
  await f.event('input', { source: 'extension', text: 'A real queued request.' });
  await f.event('agent_start');
  await f.event('message_end', { message: reply('') });
  await f.event('agent_settled');
  assert.equal(speech(f).at(-1), missing);
  const before = speech(f).length;
  await start(f, 'custom');
  await f.event('message_end', { message: reply('') });
  await f.event('agent_settled');
  assert.equal(speech(f).length, before);
});

test('a voice request admitted during a background run still requires its own outcome', async t => {
  const f = await armed(t);
  await start(f, 'custom');
  f.audio({ type: 'addressed', id: 'real-user' });
  f.audio({ type: 'utterance', id: 'real-user', text: 'Check the result.' });
  await f.event('agent_start');
  await f.event('message_end', { message: reply('') });
  await f.event('agent_settled');
  assert.equal(speech(f).at(-1), missing);
});
