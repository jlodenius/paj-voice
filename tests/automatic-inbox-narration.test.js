import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';

const speech = f => f.frames.filter(frame => frame.type === 'speak');
const final = text => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] });
const messages = (f, ids) => [...f.messages.map(([content]) => ({ role: 'user', content })),
  { role: 'custom', customType: 'paj-messages', content: 'Untrusted agent updates.', details: { messageIds: ids } }];
async function start(f, ids) {
  await f.event('before_agent_start', { messageType: 'custom' });
  await f.event('agent_start');
  return f.event('context', { messages: messages(f, ids) });
}
function deliver(f, ids) {
  f.events.emit('paj:messages:delivering:v1', { sessionId: 'session-one', messageIds: ids, requestTurn() {} });
}

test('an unsummarized inbox batch requests one fresh summary instead of telling the user to ask again', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  const retries = [];
  f.pi.sendMessage = (message, options) => retries.push({ message, options });
  await f.command('on'); f.audio({ type: 'ready' });
  deliver(f, ['first', 'second']);
  await start(f, ['first', 'second']);
  const before = speech(f).length;
  await f.event('message_end', { message: final('') });
  await f.event('agent_settled');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].message.customType, 'paj-voice-inbox-summary');
  assert.deepEqual(retries[0].message.details.messageIds, ['first', 'second']);
  assert.equal(retries[0].options.triggerTurn, true);
  assert.equal(speech(f).length, before);
  const context = await start(f, ['first', 'second']);
  assert.match(context.messages.at(-1).content, /Summarize the newly arrived Paj messages aloud/);
  await f.event('message_end', { message: final('Both reviews are complete and no blocking issues remain.') });
  await f.event('agent_settled');
  assert.deepEqual(speech(f).slice(before).map(frame => frame.text),
    ['Both reviews are complete and no blocking issues remain.']);
  assert.equal(retries.length, 1);
});

test('an internal Pi continuation retains the inbox batch for the one summary retry', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  const retries = [];
  f.pi.sendMessage = message => retries.push(message);
  await f.command('on'); f.audio({ type: 'ready' });
  deliver(f, ['worker-outcome']);
  await start(f, ['worker-outcome']);
  await f.event('agent_start');
  await f.event('context', { messages: messages(f, ['worker-outcome']) });
  await f.event('agent_settled');
  assert.deepEqual(retries.map(message => message.details.messageIds), [['worker-outcome']]);
});

test('a new capture cannot carry an old matched inbox batch into a fresh retry', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  const retries = [];
  f.pi.sendMessage = message => retries.push(message);
  await f.command('on'); f.audio({ type: 'ready' });
  deliver(f, ['old']);
  await start(f, ['old']);
  f.audio({ type: 'addressed', id: 'barge-in' });
  f.audio({ type: 'cancelled', id: 'barge-in' });
  deliver(f, ['fresh']);
  await f.event('agent_start');
  await f.event('context', { messages: messages(f, ['old', 'fresh']) });
  await f.event('agent_settled');
  assert.deepEqual(retries.map(message => message.details.messageIds), [['fresh']]);
});

test('a failed automatic retry is bounded and does not ask the user to request another summary', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  const retries = [];
  f.pi.sendMessage = message => retries.push(message);
  await f.command('on'); f.audio({ type: 'ready' });
  deliver(f, ['one']);
  await start(f, ['one']);
  await f.event('agent_settled');
  await start(f, ['one']);
  await f.event('agent_settled');
  assert.equal(retries.length, 1);
  assert.equal(speech(f).filter(frame => frame.key === 'fallback').length, 1);
  assert.doesNotMatch(speech(f).at(-1).text, /ask me|finished this response/i);
});

test('manual stop or new speech cancels a queued retry without replaying its old summary', async t => {
  for (const action of ['stop', 'speech']) {
    const f = fixture();
    t.after(() => f.command('off'));
    const retries = [];
    f.pi.sendMessage = message => retries.push(message);
    await f.command('on'); f.audio({ type: 'ready' });
    deliver(f, ['one']);
    await start(f, ['one']);
    await f.event('agent_settled');
    if (action === 'stop') await f.command('stop');
    else {
      f.audio({ type: 'addressed', id: 'interrupt' });
      f.audio({ type: 'cancelled', id: 'interrupt' });
    }
    const before = speech(f).length;
    await f.event('before_agent_start', { messageType: 'custom', message: retries[0] });
    await f.event('agent_start');
    await f.event('context', { messages: [...messages(f, ['one']),
      { role: 'custom', ...retries[0] }] });
    const attempt = await f.tools.get('voice_speak').execute('stale-retry', {
      ...f.controller.state(), text: 'The cancelled summary.', purpose: 'inbox-summary' });
    assert.equal(attempt.details.status, 'stale');
    await f.event('message_end', { message: final('The cancelled summary.') });
    await f.event('agent_settled');
    assert.equal(speech(f).length, before);
    assert.equal(retries.length, 1);
  }
});

test('an inbox context missing the latest user request cannot consume or narrate its pending updates', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  f.pi.sendMessage = () => assert.fail('Do not retry over an unseen user request');
  await f.command('on'); f.audio({ type: 'ready' });
  f.audio({ type: 'addressed', id: 'latest' });
  f.audio({ type: 'utterance', id: 'latest', text: 'Answer my new question first.' });
  deliver(f, ['one']);
  const before = speech(f).length;
  await f.event('before_agent_start', { messageType: 'custom' });
  await f.event('agent_start');
  const missing = await f.event('context', { messages: messages({ messages: [] }, ['one']) });
  assert.doesNotMatch(missing.messages.at(-1).content, /Summarize the newly arrived/);
  await f.event('message_end', { message: final('Too early.') });
  await f.event('agent_settled');
  assert.equal(speech(f).length, before);
  const current = await start(f, ['one']);
  assert.match(current.messages.at(-1).content, /Summarize the newly arrived/);
});

test('an automatic inbox final does not consume the separate user outcome', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  await f.command('on'); f.audio({ type: 'ready' });
  await f.event('input', { source: 'extension', text: 'Complete my requested fix.' });
  await f.event('before_agent_start', { messageType: 'user' });
  await f.event('agent_start');
  deliver(f, ['one']);
  await start(f, ['one']);
  const before = speech(f).length;
  await f.event('message_end', { message: final('The worker finished a preliminary review.') });
  await f.event('message_end', { message: final('Your requested fix is complete and all tests passed.') });
  await f.event('agent_settled');
  assert.deepEqual(speech(f).slice(before).map(frame => frame.text), [
    'The worker finished a preliminary review.', 'Your requested fix is complete and all tests passed.',
  ]);
});

test('fresh inbox context cannot revoke explicit silence within the same run', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  f.pi.sendMessage = () => assert.fail('Explicit silence must not schedule a retry');
  await f.command('on'); f.audio({ type: 'ready' });
  deliver(f, ['one']);
  await start(f, ['one']);
  await f.tools.get('voice_silence_turn').execute('silence', {
    ...f.controller.state(), turn: f.controller.turn(),
  });
  deliver(f, ['two']);
  const before = speech(f).length;
  await f.event('context', { messages: messages(f, ['one', 'two']) });
  await f.event('message_end', { message: final('Keep this response silent.') });
  await f.event('agent_settled');
  assert.equal(speech(f).length, before);
});

test('an obsolete retry cannot consume the newer user outcome', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  const retries = [];
  f.pi.sendMessage = message => retries.push(message);
  await f.command('on'); f.audio({ type: 'ready' });
  deliver(f, ['one']);
  await start(f, ['one']);
  await f.event('agent_settled');
  f.audio({ type: 'addressed', id: 'new-request' });
  f.audio({ type: 'utterance', id: 'new-request', text: 'Answer the new question instead.' });
  const before = speech(f).length;
  await f.event('before_agent_start', { messageType: 'custom', message: retries[0] });
  await f.event('agent_start');
  await f.event('context', { messages: [...messages(f, ['one']), { role: 'custom', ...retries[0] }] });
  await f.tools.get('voice_speak').execute('fresh-answer', {
    ...f.controller.state(), text: 'Here is the answer to your new question.', purpose: 'answer',
  });
  await f.event('agent_settled');
  assert.deepEqual(speech(f).slice(before).map(frame => frame.text),
    ['Here is the answer to your new question.']);
  assert.equal(retries.length, 1);
});

test('an old retry in history does not silence an unrelated new background report', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  const retries = [];
  f.pi.sendMessage = message => retries.push(message);
  await f.command('on'); f.audio({ type: 'ready' });
  deliver(f, ['one']);
  await start(f, ['one']);
  await f.event('agent_settled');
  await f.command('stop');
  await f.event('before_agent_start', { messageType: 'custom',
    message: { customType: 'unrelated-status', content: 'A new relevant report.' } });
  await f.event('agent_start');
  await f.event('context', { messages: [...messages(f, ['one']), { role: 'custom', ...retries[0] }] });
  const result = await f.tools.get('voice_speak').execute('new-background', {
    ...f.controller.state(), text: 'The new independent check passed.', purpose: 'answer',
  });
  assert.equal(result.details.status, 'queued');
  await f.event('agent_settled');
});

test('an obsolete retry automatic final cannot impersonate a newer user answer', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  const retries = [];
  f.pi.sendMessage = message => retries.push(message);
  await f.command('on'); f.audio({ type: 'ready' });
  deliver(f, ['one']);
  await start(f, ['one']);
  await f.event('agent_settled');
  f.audio({ type: 'addressed', id: 'new-request' });
  f.audio({ type: 'utterance', id: 'new-request', text: 'Answer my completely different question.' });
  await f.event('before_agent_start', { messageType: 'custom', message: retries[0] });
  await f.event('agent_start');
  await f.event('context', { messages: [...messages(f, ['one']), { role: 'custom', ...retries[0] }] });
  const before = speech(f).length;
  await f.event('message_end', { message: final('The old worker review is complete.') });
  assert.equal(speech(f).length, before);
  assert.equal(f.controller.userOutcomePending(), true);
  const oldSummary = await f.tools.get('voice_speak').execute('obsolete-summary', {
    ...f.controller.state(), text: 'The old worker review is complete.', purpose: 'inbox-summary',
  });
  assert.equal(oldSummary.details.status, 'stale');
  assert.equal(speech(f).length, before);
  const answer = await f.tools.get('voice_speak').execute('actual-user-answer', {
    ...f.controller.state(), text: 'Here is the answer to your new question.', purpose: 'answer',
  });
  assert.equal(answer.details.status, 'queued');
  await f.event('agent_settled');
  assert.deepEqual(speech(f).slice(before).map(frame => frame.text),
    ['Here is the answer to your new question.']);
});

test('retry batches stay within the shared message-ID bound across multiple contexts in one run', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  const retries = [];
  f.pi.sendMessage = message => retries.push(message);
  await f.command('on'); f.audio({ type: 'ready' });
  const first = Array.from({ length: 300 }, (_, index) => `first-${index}`);
  const second = Array.from({ length: 300 }, (_, index) => `second-${index}`);
  deliver(f, first);
  await start(f, first);
  deliver(f, second);
  await f.event('context', { messages: messages(f, second) });
  await f.event('agent_settled');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].details.messageIds.length, 512);
  assert.equal(retries[0].details.messageIds.includes('first-0'), false);
  assert.equal(new Set(retries[0].details.messageIds).size, 512);
});

test('a retry without an inbox summary reports failure even after progress or an unrelated answer', async t => {
  for (const purpose of ['progress', 'answer']) {
    const f = fixture();
    t.after(() => f.command('off'));
    const retries = [];
    f.pi.sendMessage = message => retries.push(message);
    await f.command('on'); f.audio({ type: 'ready' });
    deliver(f, ['one']);
    await start(f, ['one']);
    await f.event('agent_settled');
    await start(f, ['one']);
    await f.tools.get('voice_speak').execute(`non-summary-${purpose}`, {
      ...f.controller.state(), text: 'Checking the pending updates.', purpose,
    });
    await f.event('agent_settled');
    assert.match(speech(f).at(-1).text, /agent update could not be summarized automatically/i);
    assert.equal(speech(f).at(-1).key, 'fallback');
    assert.equal(retries.length, 1);
  }
});

test('inbox context uses fresh delivery ownership after cancelled noise advances past the last user prompt', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  await f.command('on'); f.audio({ type: 'ready' });
  f.controller.api.registerReporter({ id: 'captain', instructions: 'Give concise spoken updates.' });
  f.audio({ type: 'addressed', id: 'request' });
  f.audio({ type: 'utterance', id: 'request', text: 'Finish the review.' });
  await f.event('before_agent_start', { messageType: 'user' });
  await f.event('agent_start');
  await f.event('context', { messages: messages(f, []) });
  await f.event('agent_settled');
  f.audio({ type: 'addressed', id: 'noise' });
  f.audio({ type: 'cancelled', id: 'noise', reason: 'empty' });
  deliver(f, ['review-result']);
  const current = f.controller.state();
  const context = await start(f, ['review-result']);
  assert.match(context.messages.at(-1).content,
    new RegExp(`Current voice_speak delivery token: generation=.*epoch=${current.epoch}\\.`));
  const before = speech(f).length;
  await f.event('message_end', { message: final('The review passed with no blocking findings.') });
  await f.event('agent_settled');
  assert.deepEqual(speech(f).slice(before).map(frame => frame.text),
    ['The review passed with no blocking findings.']);
});
