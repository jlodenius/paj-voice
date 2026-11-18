import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';

const reply = text => ({ role: 'assistant', stopReason: 'stop',
  content: text ? [{ type: 'text', text }] : [] });
const speech = f => f.frames.filter(frame => frame.type === 'speak');
async function armed(t) {
  const f = fixture();
  t.after(() => f.command('off'));
  await f.command('on'); f.audio({ type: 'ready' });
  return f;
}
function deliver(f, ids = ['message-one'], sessionId = 'session-one') {
  let wake = false;
  f.events.emit('paj:messages:delivering:v1', { sessionId, messageIds: ids,
    requestTurn() { wake = true; } });
  return wake;
}
async function run(f, messageIds = ['message-one']) {
  await f.event('before_agent_start', { messageType: 'custom' });
  await f.event('agent_start');
  return f.event('context', { messages: [...f.messages.map(([content]) => ({ role: 'user', content })),
    { role: 'custom', customType: 'paj-messages',
    content: 'Untrusted worker report.', details: { messageIds } }] });
}

test('update, result and question arrivals request safe model summaries even with a reporter', async t => {
  for (const kind of ['update', 'result', 'question']) {
    const f = await armed(t);
    f.controller.api.registerReporter({ id: 'captain', instructions: 'Own reporting.' });
    assert.equal(deliver(f, [kind]), true);
    assert.equal(speech(f).at(-1).text, 'A Paj agent message arrived.');
    const context = await run(f, [kind]);
    assert.match(context.messages.at(-1).content, /Summarize the newly arrived Paj messages aloud/);
    await f.event('message_end', { message: reply('The worker discarded the twenty-second capture; nothing was sent.') });
    await f.event('agent_settled');
    assert.match(speech(f).at(-1).text, /discarded/);
    assert.equal(speech(f).length, 2);
  }
});

test('duplicate, wrong-session, off and muted arrivals never wake or announce', async t => {
  const f = await armed(t);
  assert.equal(deliver(f), true);
  assert.equal(deliver(f), false);
  assert.equal(deliver(f, ['stale'], 'old-session'), false);
  await f.command('mute');
  assert.equal(deliver(f, ['muted']), false);
  await f.command('off');
  assert.equal(deliver(f, ['off']), false);
  assert.equal(speech(f).length, 1);
});

test('queued batches retain summary ownership until their actual model context and are consumed once', async t => {
  const f = await armed(t);
  f.controller.api.registerReporter({ id: 'captain', instructions: 'Own reporting.' });
  deliver(f, ['first']);
  deliver(f, ['second']);
  const unrelated = await run(f, []);
  assert.doesNotMatch(unrelated.messages.at(-1).content, /Summarize the newly arrived/);
  await f.event('agent_settled');
  for (const id of ['first', 'second']) {
    const context = await run(f, [id]);
    assert.match(context.messages.at(-1).content, /Summarize the newly arrived/);
    await f.event('message_end', { message: reply(`${id} worker finished its check.`) });
    await f.event('agent_settled');
  }
  assert.equal(speech(f).filter(frame => /finished its check/.test(frame.text)).length, 2);
  assert.equal(speech(f).some(frame => /Untrusted worker report/.test(frame.text)), false);
  const replay = await run(f, ['first', 'second']);
  assert.doesNotMatch(replay.messages.at(-1).content, /Summarize the newly arrived/);
});

test('never-consumed inbox work rebinds to the epoch of its first actual model context', async t => {
  const f = await armed(t);
  f.controller.api.registerReporter({ id: 'captain', instructions: 'Own reporting.' });
  f.audio({ type: 'addressed', id: 'capture' });
  assert.equal(deliver(f), true);
  const arrivalEpoch = f.controller.state().epoch;
  f.audio({ type: 'utterance', id: 'capture', text: 'Continue the real task.' });
  assert.ok(f.controller.state().epoch > arrivalEpoch);
  const context = await run(f);
  assert.match(context.messages.at(-1).content, /Summarize the newly arrived Paj messages aloud/);
  await f.event('message_end', { message: reply('The worker discarded the capture; nothing was sent.') });
  await f.event('agent_settled');
  assert.match(speech(f).at(-1).text, /discarded the capture/);
});

test('an explicit inbox summary tool call is the only completion for an inbox-only run', async t => {
  const f = await armed(t);
  f.controller.api.registerReporter({ id: 'captain', instructions: 'Own reporting.' });
  deliver(f);
  await run(f);
  const state = f.controller.state();
  await f.tools.get('voice_speak').execute('inbox-summary', { ...state,
    text: 'The worker finished review.', purpose: 'inbox-summary' });
  await f.event('message_end', { message: reply('') });
  await f.event('agent_settled');
  assert.deepEqual(speech(f).map(frame => frame.text), [
    'A Paj agent message arrived.', 'The worker finished review.',
  ]);
});

test('inbox progress or its summary cannot discharge a real user outcome obligation', async t => {
  for (const purpose of [undefined, 'progress', 'inbox-summary']) {
    const f = await armed(t);
    await f.event('input', { source: 'extension', text: 'Finish the actual task.' });
    await f.event('before_agent_start', { messageType: 'user' });
    await f.event('agent_start');
    deliver(f);
    await run(f);
    await f.tools.get('voice_speak').execute('inbox-progress', { ...f.controller.state(),
      text: 'The worker is still reviewing.', ...(purpose ? { purpose } : {}) });
    await f.event('message_end', { message: reply('') });
    await f.event('agent_settled');
    assert.match(speech(f).at(-1).text, purpose === 'progress' ? /finished for now/ : /did not produce a spoken summary/);
    assert.equal(speech(f).length, 3);
  }
});

test('an inbox summary leaves the actual user outcome available for a separate final answer', async t => {
  const f = await armed(t);
  f.controller.api.registerReporter({ id: 'captain', instructions: 'Own reporting.' });
  await f.event('input', { source: 'extension', text: 'Finish the actual task.' });
  await f.event('before_agent_start', { messageType: 'user' });
  await f.event('agent_start');
  deliver(f);
  await run(f);
  await f.tools.get('voice_speak').execute('inbox-progress', { ...f.controller.state(),
    text: 'The worker is still reviewing.', purpose: 'inbox-summary' });
  await f.event('message_end', { message: reply('Your requested fix is complete and its tests passed.') });
  await f.event('agent_settled');
  assert.deepEqual(speech(f).map(frame => frame.text), [
    'A Paj agent message arrived.', 'The worker is still reviewing.',
    'Your requested fix is complete and its tests passed.',
  ]);
});

test('arrival notice is not an outcome; an empty inbox turn retains fallback protection', async t => {
  const f = await armed(t);
  deliver(f);
  await run(f);
  await f.event('message_end', { message: reply('') });
  await f.event('agent_settled');
  assert.match(speech(f).at(-1).text, /did not produce a spoken summary/);
});

test('explicit model silence is scoped to a run and does not disable later inbox or request guards', async t => {
  const f = await armed(t);
  await run(f);
  const state = f.controller.state();
  const result = await f.tools.get('voice_silence_turn').execute('silent', {
    generation: state.generation, epoch: state.epoch, turn: f.controller.turn(),
  });
  assert.equal(result.details.status, 'silenced');
  await f.event('message_end', { message: reply('') });
  await f.event('agent_settled');
  assert.equal(speech(f).length, 0);
  assert.equal(deliver(f), true);
  await run(f);
  await f.event('agent_settled');
  assert.match(speech(f).at(-1).text, /did not produce a spoken summary/);
  await f.event('input', { source: 'extension', text: 'A real request.' });
  await f.event('before_agent_start', { messageType: 'user' });
  await f.event('agent_start');
  await f.event('agent_settled');
  assert.match(speech(f).at(-1).text, /did not produce a spoken summary/);
});
