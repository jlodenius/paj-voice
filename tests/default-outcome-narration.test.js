import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';

const final = text => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] });
const answers = f => f.frames.filter(frame => frame.type === 'speak' && frame.key === 'answer');
async function userTurn(f) {
  await f.command('on'); f.audio({ type: 'ready' });
  f.audio({ type: 'addressed', id: 'request' });
  f.audio({ type: 'utterance', id: 'request', text: 'Did the check pass?' });
  await f.event('before_agent_start', { messageType: 'user' });
  await f.event('agent_start');
  const messages = f.messages.map(([content]) => ({ role: 'user', content }));
  await f.event('context', { messages });
  return messages;
}

for (const source of ['reporting owner', 'progress']) {
  test(`a safe final is narrated despite ${source}`, async t => {
    const f = fixture();
    t.after(() => f.command('off'));
    if (source === 'reporting owner') f.controller.api.registerReporter({ id: 'fixture', instructions: 'Report outcomes.' });
    await userTurn(f);
    if (source === 'progress') await f.tools.get('voice_speak').execute('progress', {
      ...f.controller.state(), purpose: 'progress', text: 'Checking now.',
    });
    await f.event('message_end', { message: final('The check passed.') });
    await f.event('agent_settled');
    assert.deepEqual(answers(f).map(x => x.text), ['The check passed.']);
  });
}

test('an already spoken answer, explicit silence and new speech suppress automatic narration', async t => {
  for (const mode of ['spoken', 'silent', 'new_speech']) {
    const f = fixture();
    t.after(() => f.command('off'));
    await userTurn(f);
    if (mode === 'spoken') await f.tools.get('voice_speak').execute('spoken', {
      ...f.controller.state(), purpose: 'answer', text: 'The check passed.',
    });
    if (mode === 'silent') f.controller.silenceTurn({ ...f.controller.state(), turn: f.controller.turn() });
    if (mode === 'new_speech') f.audio({ type: 'addressed', id: 'next' });
    const count = f.frames.filter(frame => frame.type === 'speak').length;
    await f.event('message_end', { message: final('The check passed.') });
    await f.event('agent_settled');
    assert.equal(f.frames.filter(frame => frame.type === 'speak').length, count);
  }
});
