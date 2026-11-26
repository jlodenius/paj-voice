import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';

const final = text => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] });
const inbox = { role: 'custom', customType: 'paj-messages', content: 'First and second reviews finished.', details: { messageIds: ['first', 'second'] } };
const lastSpeech = f => f.frames.findLast(frame => frame.type === 'speak');
async function turn(f, messageType, messages, message) {
  await f.event('before_agent_start', { messageType, message });
  await f.event('agent_start');
  return f.event('context', { messages });
}
async function reply(f, text) {
  await f.event('message_end', { message: final(text) });
  return lastSpeech(f);
}
async function setup(t) {
  const f = fixture();
  const resumes = [];
  f.pi.sendMessage = (message, options) => resumes.push({ message, options });
  t.after(() => f.command('off'));
  await f.command('on'); f.audio({ type: 'ready' });
  f.events.emit('paj:messages:delivering:v1', { sessionId: 'session-one', messageIds: inbox.details.messageIds, requestTurn() {} });
  await turn(f, 'custom', [inbox]);
  return { f, resumes };
}
async function interrupt(f, mode) {
  const original = mode === 'not-queued' ? undefined : await reply(f, 'Previously generated summary.');
  if (original) await f.event('agent_settled');
  if (mode === 'handed-off') {
    f.audio({ type: 'speech_start', id: original.id });
    f.audio({ type: 'speech_end', id: original.id, completed: false });
  }
  if (mode === 'completed') f.audio({ type: 'speech_end', id: original.id, completed: true });
  f.audio({ type: 'addressed', id: 'interrupt', ...(mode === 'pre-output' ? { preOutputSpeechIds: [original.id] } : {}) });
  if (!original) {
    await reply(f, 'Previously generated summary.');
    await f.event('agent_settled');
  }
}
async function user(f) {
  f.audio({ type: 'utterance', id: 'interrupt', text: 'What is two plus two?' });
  const receipt = lastSpeech(f);
  f.audio({ type: 'speech_end', id: receipt.id, completed: true });
  const messages = [inbox, ...f.messages.map(([content]) => ({ role: 'user', content }))];
  await turn(f, 'user', messages);
  return messages;
}
async function settle(f) {
  f.idle();
  await f.event('agent_settled');
}

for (const mode of ['not-queued', 'pre-output']) {
  test(`an inbox summary interrupted ${mode} resumes only after the user answer settles and drains`, async t => {
    const { f, resumes } = await setup(t);
    await interrupt(f, mode);
    assert.equal(resumes.length, 0);
    const messages = await user(f);
    const answer = await reply(f, 'Four.');
    assert.equal(answer.text, 'Four.');
    if (mode === 'pre-output') {
      f.audio({ type: 'speech_end', id: answer.id, completed: true });
      assert.equal(resumes.length, 0);
      await settle(f);
    } else {
      await settle(f);
      assert.equal(resumes.length, 0);
      f.audio({ type: 'speech_end', id: answer.id, completed: true });
    }
    assert.equal(resumes.length, 1);
    const [{ message, options }] = resumes;
    assert.deepEqual(message.details.messageIds, ['first', 'second']);
    assert.equal(message.content, '');
    assert.equal(options.deliverAs, 'followUp');
    const trigger = { ...message, role: 'custom' };
    const context = await turn(f, 'custom', [...messages, trigger], message);
    assert.ok(!context.messages.includes(trigger));
    assert.match(context.messages.at(-1).content, /Only summarize the previously interrupted/);
    const summary = await reply(f, 'Both reviews passed.');
    assert.equal(summary.text, 'Both reviews passed.');
    await settle(f);
    f.audio({ type: 'addressed', id: 'again', preOutputSpeechIds: [summary.id] });
    f.audio({ type: 'cancelled', id: 'again' });
    assert.equal(resumes.length, 1);
  });
}

for (const mode of ['handed-off', 'completed', 'ambiguous']) {
  test(`no replay after ${mode} inbox output`, async t => {
    const { f, resumes } = await setup(t);
    await interrupt(f, mode);
    await user(f);
    const answer = await reply(f, 'Four.');
    await settle(f);
    f.audio({ type: 'speech_end', id: answer.id, completed: true });
    assert.deepEqual(resumes, []);
  });
}

test('a queued second summary cannot revive IDs from an earlier handed-off summary', async t => {
  const { f, resumes } = await setup(t);
  const speak = f.tools.get('voice_speak');
  const args = { ...f.controller.state(), purpose: 'inbox-summary', text: 'An explicit report.' };
  const first = await speak.execute('first-summary', args);
  const second = await speak.execute('second-summary', args);
  f.audio({ type: 'speech_start', id: first.details.id });
  f.audio({ type: 'speech_end', id: first.details.id, completed: false });
  f.audio({ type: 'addressed', id: 'interrupt', preOutputSpeechIds: [second.details.id] });
  await f.event('agent_settled');
  await user(f);
  const answer = await reply(f, 'Four.');
  await settle(f);
  f.audio({ type: 'speech_end', id: answer.id, completed: true });
  assert.deepEqual(resumes, []);
});

test('a silenced inbox run is not revived by a subsequent capture', async t => {
  const { f, resumes } = await setup(t);
  await f.tools.get('voice_silence_turn').execute('silence', { ...f.controller.state(), turn: f.controller.turn() });
  await interrupt(f, 'not-queued');
  await user(f);
  const answer = await reply(f, 'Four.');
  await settle(f);
  f.audio({ type: 'speech_end', id: answer.id, completed: true });
  assert.deepEqual(resumes, []);
});

test('a partial ordinary answer cannot unlock deferred inbox speech', async t => {
  const { f, resumes } = await setup(t);
  await interrupt(f, 'pre-output');
  await user(f);
  const speak = f.tools.get('voice_speak');
  const args = { ...f.controller.state(), purpose: 'answer' };
  const first = await speak.execute('first-answer', { ...args, text: 'Part one.' });
  const second = await speak.execute('second-answer', { ...args, text: 'Part two.' });
  await settle(f);
  f.audio({ type: 'speech_end', id: first.details.id, completed: true });
  f.audio({ type: 'speech_end', id: second.details.id, completed: false });
  assert.deepEqual(resumes, []);
});

test('explicit silence in an admitted recovery run also blocks its speech tool', async t => {
  const { f, resumes } = await setup(t);
  await interrupt(f, 'pre-output');
  const messages = await user(f);
  const answer = await reply(f, 'Four.');
  await settle(f);
  f.audio({ type: 'speech_end', id: answer.id, completed: true });
  const [{ message }] = resumes;
  await turn(f, 'custom', [...messages, { ...message, role: 'custom' }], message);
  await f.tools.get('voice_silence_turn').execute('skip-recovery', { ...f.controller.state(), turn: f.controller.turn() });
  const result = await f.tools.get('voice_speak').execute('silenced-summary', {
    ...f.controller.state(), purpose: 'inbox-summary', text: 'Must not speak.' });
  assert.equal(result.details.status, 'stale');
  assert.equal(lastSpeech(f).text, 'Four.');
});

test('an obsolete recovery turn cannot bar an explicit answer to newer voice input', async t => {
  const { f, resumes } = await setup(t);
  await interrupt(f, 'pre-output');
  await user(f);
  const first = await reply(f, 'Four.');
  await settle(f);
  f.audio({ type: 'speech_end', id: first.id, completed: true });
  const [{ message }] = resumes;
  f.audio({ type: 'addressed', id: 'newer' });
  f.audio({ type: 'utterance', id: 'newer', text: 'What is three plus three?' });
  const messages = [inbox, ...f.messages.map(([content]) => ({ role: 'user', content }))];
  await turn(f, 'custom', [...messages, { ...message, role: 'custom' }], message);
  const answer = await f.tools.get('voice_speak').execute('new-answer', {
    ...f.controller.state(), purpose: 'answer', text: 'Six.' });
  assert.equal(answer.details.status, 'queued');
  assert.equal(lastSpeech(f).text, 'Six.');
});

for (const mode of ['stop', 'silence', 'second-capture', 'lost-output', 'abort', 'unconfirmed-answer']) {
  test(`no deferred recovery after ${mode}`, async t => {
    const { f, resumes } = await setup(t);
    await interrupt(f, 'pre-output');
    await user(f);
    if (mode === 'silence') await f.tools.get('voice_silence_turn').execute('silence', { ...f.controller.state(), turn: f.controller.turn() });
    const answer = await reply(f, 'Four.');
    if (mode === 'stop') await f.command('stop');
    if (mode === 'second-capture') f.audio({ type: 'addressed', id: 'another' });
    if (mode === 'lost-output') f.audio({ type: 'availability', input: true, output: false });
    f.idle();
    await f.event('agent_settled', { aborted: mode === 'abort' });
    f.audio({ type: 'speech_end', id: answer.id, completed: mode !== 'unconfirmed-answer' });
    assert.deepEqual(resumes, []);
  });
}
