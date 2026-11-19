import test from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../src/config.ts';
import { fixture } from './fixtures/extension.js';

const final = text => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] });

function utter(f, text) {
  f.audio({ type: 'addressed', id: 'ordinary-request' });
  f.audio({ type: 'utterance', id: 'ordinary-request', text });
}

test('saved phrase expansion is not an available configuration or matching interface', () => {
  assert.equal(Object.hasOwn(config.validateConfig({}), 'shortcuts'), false);
  assert.equal(Object.hasOwn(config, 'normalizeShortcutPhrase'), false);
  for (const shortcuts of [[], [{ phrase: 'status update', request: 'A different request' }]]) {
    assert.throws(() => config.validateConfig({ shortcuts }), /Invalid voice configuration/);
  }
});

test('recognized speech is submitted once as the ordinary unexpanded user request', async t => {
  for (const text of ['status update', 'status updates', '  STATUS UPDATE?!  ']) {
    const f = fixture();
    t.after(() => f.command('off'));
    await f.command('on');
    f.audio({ type: 'ready' });
    utter(f, text);
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0][0].split('\n').slice(1).join('\n'), text.trim());
    assert.deepEqual(f.messages[0][1], { expandPromptTemplates: false });
    f.audio({ type: 'utterance', id: 'ordinary-request', text });
    assert.equal(f.messages.length, 1);
  }
});

test('ordinary uncertain delivery retains its attempted epoch and missing-context fence', async t => {
  for (const accepted of [false, true]) {
    const f = fixture();
    t.after(() => f.command('off'));
    await f.command('on');
    f.audio({ type: 'ready' });
    let attempts = 0;
    f.pi.sendUserMessage = (...args) => {
      attempts++;
      if (accepted) f.messages.push(args);
      throw new Error('Synthetic uncertain delivery');
    };
    utter(f, 'A new ordinary request.');
    f.audio({ type: 'addressed', id: 'noise' });
    f.audio({ type: 'cancelled', id: 'noise', reason: 'unreliable_speech' });
    await f.event('before_agent_start', { messageType: 'user' });
    await f.event('agent_start');
    await f.event('context', { messages: [{ role: 'user',
      content: accepted ? f.messages[0][0] : 'An older request.' }] });
    const staleAnswer = 'An obsolete answer must not become fresh.';
    await f.event('message_end', { message: final(staleAnswer) });
    await f.event('agent_settled');
    assert.equal(attempts, 1);
    assert.equal(f.frames.some(frame => frame.type === 'speak' && frame.text === staleAnswer), false);
    assert.equal(f.notices.some(([message]) => message === 'Voice request submitted.'), false);
  }
});
