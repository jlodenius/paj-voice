import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';

test('rejected noise cannot submit a request or acknowledgement, even after duplicate late frames', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  await f.command('on');
  f.audio({ type: 'ready' });
  f.audio({ type: 'addressed', id: 'noise' });
  f.audio({ type: 'cancelled', id: 'noise', reason: 'unreliable_speech' });
  f.audio({ type: 'utterance', id: 'noise', text: 'Okay. '.repeat(25) });
  f.audio({ type: 'addressed', id: 'noise' });
  f.audio({ type: 'utterance', id: 'noise', text: 'Okay.' });
  assert.equal(f.messages.length, 0);
  assert.equal(f.frames.filter(frame => frame.type === 'speak').length, 0);
  assert.ok(f.notices.some(([text]) => /unreliable speech.*nothing was submitted/i.test(text)));
  assert.equal(f.controller.state().enabled, true);
});
