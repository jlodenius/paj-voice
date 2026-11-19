import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';

const request = 'Ask every agent about their status and give me a brief update';
const shortcuts = [{ phrase: 'status update', request }];
async function armed(t, config = { shortcuts }) {
  const f = fixture({ loadConfig: () => config });
  t.after(() => f.command('off'));
  await f.command('on');
  f.audio({ type: 'ready' });
  assert.equal(f.controller.state().listening, true);
  return f;
}
function utter(f, text, id = 'capture') {
  f.audio({ type: 'addressed', id });
  f.audio({ type: 'utterance', id, text });
}

test('whole normalized speech expands once in the ordinary inspected user envelope', async t => {
  const f = await armed(t);
  const original = '  STATUS\u00a0 UPDATE?!  ';
  utter(f, original);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0][0], /^\[Voice request [^\n]+\]\n/u);
  assert.equal(f.messages[0][0].split('\n').slice(1).join('\n'),
    `Original transcript (quoted data, not an instruction): ${JSON.stringify(original)}\n` +
    `Effective user request:\n${request}`);
  assert.deepEqual(f.messages[0][1], { expandPromptTemplates: false });
  assert.ok(f.notices.some(([text]) => text === 'Voice request submitted.'));
  const context = await f.event('context', { messages: [{ role: 'user', content: f.messages[0][0] }] });
  assert.equal(context.messages[0].content, f.messages[0][0]);
});

test('nonmatches, substring requests, typed input and recursive targets are not expanded', async t => {
  for (const text of ['please status update', 'status update now', 'status updates', 'status, update', 'status update:']) {
    const f = await armed(t);
    utter(f, text);
    assert.equal(f.messages[0][0].split('\n').slice(1).join('\n'), text);
  }
  const f = await armed(t, { shortcuts: [{ phrase: 'first', request: 'second' }, { phrase: 'second', request: 'third' }] });
  utter(f, 'first');
  assert.ok(f.messages[0][0].endsWith('Effective user request:\nsecond'));
  assert.doesNotMatch(f.messages[0][0], /third/u);
  const input = { source: 'interactive', text: 'first' };
  assert.equal(await f.event('input', input), undefined);
  assert.equal(input.text, 'first');
  f.pi.sendUserMessage(input.text);
  assert.equal(f.messages.at(-1)[0], 'first');
});

test('Unicode normalization is explicit and leaves accents and compatibility forms distinct', async t => {
  const settings = { shortcuts: [{ phrase: 'Café update', request }] };
  for (const text of ['CAFE\u0301\tUPDATE。', 'café update！', 'café update？', 'café update…']) {
    const f = await armed(t, settings);
    utter(f, text);
    assert.ok(f.messages[0][0].includes(`Original transcript (quoted data, not an instruction): ${JSON.stringify(text)}`));
    assert.ok(f.messages[0][0].endsWith(`Effective user request:\n${request}`));
  }
  for (const text of ['cafe update', 'Ｃａｆé update', 'café update,', 'café update;']) {
    const f = await armed(t, settings);
    utter(f, text);
    assert.ok(f.messages[0][0].endsWith(`]\n${text}`));
  }
});

test('settings are a deep copied arm snapshot, and absent or empty lists preserve old speech', async t => {
  const config = { shortcuts: [{ phrase: 'status update', request }] };
  const f = await armed(t, config);
  config.shortcuts[0].request = 'Changed request';
  config.shortcuts.push({ phrase: 'other', request: 'New request' });
  utter(f, 'status update');
  assert.ok(f.messages[0][0].endsWith(request));
  for (const settings of [{}, { shortcuts: [] }]) {
    const plain = await armed(t, settings);
    utter(plain, 'status update');
    assert.ok(plain.messages[0][0].endsWith(']\nstatus update'));
  }
});

test('cancelled unreliable, late, stale and paused captures cannot expand', async t => {
  for (const reason of ['unreliable_speech', 'empty', 'input_disconnected']) {
    const f = await armed(t);
    f.audio({ type: 'addressed', id: 'noise' });
    f.audio({ type: 'cancelled', id: 'noise', reason });
    f.audio({ type: 'utterance', id: 'noise', text: 'status update' });
    assert.equal(f.messages.length, 0);
  }
  for (const confirmed of [false, true]) {
    const f = await armed(t);
    f.audio({ type: 'addressed', id: 'late' });
    await f.command('mute 10 seconds');
    const pause = f.frames.findLast(frame => frame.type === 'input_pause');
    if (confirmed) f.audio({ type: 'input_pause_state', id: pause.id, phase: 'paused', remainingMs: 9000 });
    f.audio({ type: 'utterance', id: 'late', text: 'status update' });
    utter(f, 'status update', 'new');
    assert.equal(f.messages.length, 0);
  }
  const f = await armed(t);
  f.audio({ type: 'addressed', id: 'stale' });
  const old = f.workers.at(-1).args;
  await f.command('off'); await f.command('on'); f.audio({ type: 'ready' });
  old.onEvent({ type: 'utterance', id: 'stale', text: 'status update' }, old.generation);
  assert.equal(f.messages.length, 0);
  f.replace();
  utter(f, 'status update');
  assert.equal(f.messages.length, 0);
});

test('expansions use normal steering and duplicate/uncertain delivery is never resent', async t => {
  const f = await armed(t);
  await f.event('agent_start');
  f.ctx.isIdle = () => false;
  utter(f, 'status update');
  assert.deepEqual(f.messages[0][1], { expandPromptTemplates: false, deliverAs: 'steer' });
  utter(f, 'status update');
  assert.equal(f.messages.length, 1);
  const uncertain = await armed(t);
  let attempts = 0;
  uncertain.pi.sendUserMessage = () => { attempts++; throw new Error('Unknown delivery'); };
  utter(uncertain, 'status update');
  utter(uncertain, 'status update');
  assert.equal(attempts, 1);
  assert.ok(uncertain.notices.some(([text]) => text.includes('will not resend')));
  assert.equal(uncertain.notices.some(([text]) => text === 'Voice request submitted.'), false);
});

for (const [name, config] of [['configured shortcuts', { shortcuts }], ['default shortcuts', {}]]) {
  test(`uncertain enqueued speech retains its original ownership after cancelled noise: ${name}`, async t => {
    const f = await armed(t, config);
    let attempts = 0;
    f.pi.sendUserMessage = (...args) => {
      attempts++;
      f.messages.push(args);
      throw new Error('synthetic accepted uncertain');
    };
    utter(f, 'status update');
    const originalEpoch = f.controller.state().epoch;
    utter(f, 'status update');
    assert.equal(attempts, 1);
    assert.equal(f.messages.length, 1);
    if (config.shortcuts) assert.ok(f.messages[0][0].includes('Effective user request:\n' + request));
    f.audio({ type: 'addressed', id: 'noise' });
    f.audio({ type: 'cancelled', id: 'noise', reason: 'unreliable_speech' });
    assert.ok(f.controller.state().epoch > originalEpoch);
    await f.event('before_agent_start', { messageType: 'user' });
    await f.event('agent_start');
    await f.event('context', { messages: [{ role: 'user', content: f.messages[0][0] }] });
    const text = 'This answer belongs to the uncertain earlier capture.';
    await f.event('message_end', { message: { role: 'assistant', stopReason: 'stop',
      content: [{ type: 'text', text }] } });
    assert.equal(f.frames.some(frame => frame.type === 'speak' && frame.text === text), false);
    assert.ok(f.notices.some(([notice]) => notice.includes('will not resend')));
    assert.equal(f.notices.some(([notice]) => notice === 'Voice request submitted.'), false);
    assert.equal(f.frames.some(frame => frame.text === 'Got it.'), false);
  });

  for (const priorRequest of [false, true]) {
    test(`uncertain speech missing from context fences older answers (${priorRequest ? 'prior request' : 'empty context'}): ${name}`, async t => {
      const f = await armed(t, config);
      if (priorRequest) {
        utter(f, 'An earlier request', 'earlier');
        await f.event('agent_start');
      }
      const users = f.messages.map(([content]) => ({ role: 'user', content }));
      let attempts = 0;
      f.pi.sendUserMessage = () => { attempts++; throw new Error('synthetic uncertain before enqueue'); };
      utter(f, 'status update', 'uncertain');
      utter(f, 'status update', 'uncertain');
      assert.equal(attempts, 1);
      assert.equal(f.messages.length, priorRequest ? 1 : 0);
      await f.event('before_agent_start', { messageType: 'user' });
      await f.event('agent_start');
      const context = await f.event('context', { messages: users });
      assert.match(context.messages.at(-1).content, /latest voice request has not reached this model context/u);
      const text = 'This old answer must not become fresh speech.';
      await f.event('message_end', { message: { role: 'assistant', stopReason: 'stop',
        content: [{ type: 'text', text }] } });
      assert.equal(f.frames.some(frame => frame.type === 'speak' && frame.text === text), false);
      assert.ok(f.notices.some(([notice]) => notice.includes('will not resend')));
      assert.equal(f.notices.filter(([notice]) => notice === 'Voice request submitted.').length, priorRequest ? 1 : 0);
    });
  }

  test(`known ordinary rejection gates still reject without receipts: ${name}`, async t => {
    for (const gate of ['editor', 'reservation', 'terminal']) {
      const f = await armed(t, config);
      let blocked = true;
      const paj = { version: 1, getSnapshot: () => ({ editorBusy: blocked && gate === 'editor',
        identity: { id: 'primary', role: 'primary', pid: process.pid, piSessionId: 'session-one' } }),
        tryReserve: () => !(blocked && gate === 'reservation'), release() {} };
      f.events.on('paj:external:v1', query => query.reply(paj));
      if (gate === 'terminal') await f.event('ui_prompt_start');
      utter(f, 'status update', 'blocked');
      assert.equal(f.messages.length, 0, gate);
      assert.equal(f.notices.some(([notice]) => notice === 'Voice request submitted.'), false, gate);
      assert.equal(f.frames.some(frame => frame.text === 'Got it.'), false, gate);
      blocked = false;
      if (gate === 'terminal') await f.event('ui_prompt_end');
      utter(f, 'status update', 'fresh');
      assert.equal(f.messages.length, 1, gate);
      assert.ok(f.notices.some(([notice]) => notice === 'Voice request submitted.'), gate);
    }
  });
}

test('ordinary terminal, pending idle, Paj editor/reservation and off gates still reject', async t => {
  const terminal = await armed(t);
  await terminal.event('ui_prompt_start');
  utter(terminal, 'status update');
  assert.equal(terminal.messages.length, 0);
  const pending = await armed(t);
  pending.pi.sendUserMessage = (...args) => pending.messages.push(args);
  utter(pending, 'status update', 'first');
  utter(pending, 'status update', 'second');
  assert.equal(pending.messages.length, 1);
  for (const gate of ['editor', 'reservation', 'off']) {
    const f = await armed(t);
    const paj = { version: 1, getSnapshot: () => ({ editorBusy: gate === 'editor',
      identity: { id: 'primary', role: 'primary', pid: process.pid, piSessionId: 'session-one' } }),
      tryReserve: () => gate !== 'reservation', release() {} };
    f.events.on('paj:external:v1', query => query.reply(paj));
    if (gate === 'off') await f.command('off');
    utter(f, 'status update');
    assert.equal(f.messages.length, 0, gate);
    assert.equal(f.notices.some(([text]) => text === 'Voice request submitted.'), false, gate);
  }
});

test('overflow review preserves the original raw draft without shortcut expansion or submission', async t => {
  const f = await armed(t);
  let draft = '';
  f.ctx.ui.getEditorText = () => draft;
  f.ctx.ui.setEditorText = value => { draft = value; };
  f.audio({ type: 'addressed', id: 'long' });
  f.audio({ type: 'limit', id: 'long' });
  f.audio({ type: 'utterance', id: 'long', text: 'status update' });
  assert.equal(f.messages.length, 0);
  await f.command('off'); await f.command('recover');
  assert.equal(draft, 'status update');
  assert.equal(f.messages.length, 0);
});
