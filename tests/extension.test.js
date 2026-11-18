import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';

test('extension is dormant until explicit on, binds current session and exposes short speech only after ready', async () => {
  const f = fixture();
  await f.event('session_start');
  assert.equal(f.workers.length, 0);
  assert.equal(f.tools.get('voice_speak').exposure, 'hidden');
  await f.command('on');
  assert.equal(f.workers.length, 1);
  assert.equal(f.controller.state().sessionId, 'session-one');
  assert.match(f.widgets.at(-1).lines[0], /warming up/);
  assert.equal(f.tools.get('voice_speak').exposure, 'hidden');
  f.audio({ type: 'ready' });
  assert.equal(f.tools.get('voice_speak').exposure, 'direct');
  assert.match(f.widgets.at(-1).lines[0], /OPEN MIC/);
  const context = await f.event('context', { messages: [] });
  assert.equal(context.messages.length, 1);
  assert.match(context.messages[0].content, /one sentence under 30 words/);
  await f.command('off');
  assert.equal(f.workers[0].closed, true);
  assert.equal(f.tools.get('voice_speak').exposure, 'hidden');
  assert.equal(await f.event('context', { messages: [] }), undefined);
});

test('ordinary Pi submits human input without expanding accidental slash commands, and steers additions', async () => {
  const f = fixture();
  await f.command('on'); f.audio({ type: 'ready' });
  f.audio({ type: 'addressed', id: 'u1' });
  f.audio({ type: 'utterance', id: 'u1', text: '/dangerous-command' });
  assert.match(f.messages[0][0], /\n\/dangerous-command$/);
  assert.deepEqual(f.messages[0][1], { expandPromptTemplates: false });
  await f.event('agent_start');
  f.audio({ type: 'addressed', id: 'u2' });
  f.audio({ type: 'utterance', id: 'u2', text: 'Actually use the other file.' });
  assert.equal(f.messages[1][1].deliverAs, 'steer');
  assert.equal(f.ctx.abort, undefined);
});

test('session replacement and worker failure stop capture without replaying or canceling model work', async () => {
  const f = fixture();
  await f.command('on'); f.audio({ type: 'ready' });
  const first = f.workers[0];
  await f.event('session_shutdown');
  first.args.onEvent({ type: 'addressed', id: 'late' }, first.args.generation);
  first.args.onEvent({ type: 'utterance', id: 'late', text: 'Wrong target' }, first.args.generation);
  assert.equal(f.messages.length, 0);
  assert.equal(first.closed, true);
  const g = fixture();
  await g.command('on'); g.audio({ type: 'ready' });
  g.workers[0].args.onExit('Disconnected');
  assert.equal(g.controller.state().enabled, false);
  assert.equal(g.messages.length, 0);
});

test('optional extension hooks work while off and select one reporting owner without duplicate generic policy', async () => {
  const f = fixture();
  let api;
  f.events.emit('paj-voice:api:v1', { reply: value => { api = value; } });
  assert.equal(api.version, 1);
  const remove = api.registerReporter({ id: 'paj-captain', instructions: 'Report brief assignments, blockers and outcomes.' });
  await f.command('on'); f.audio({ type: 'ready' });
  const context = await f.event('context', { messages: [] });
  assert.match(context.messages.at(-1).content, /brief assignments/);
  assert.doesNotMatch(context.messages.at(-1).content, /Provide one brief spoken outcome/);
  remove();
  const ordinary = await f.event('context', { messages: [] });
  assert.match(ordinary.messages.at(-1).content, /For a simple answer/);
});

test('eyes-free policy requires spoken outcomes even with a reporting owner', async () => {
  const f = fixture();
  let api;
  f.events.emit('paj-voice:api:v1', { reply: value => { api = value; } });
  api.registerReporter({ id: 'test-reporter', instructions: 'Report outcomes briefly.' });
  await f.command('on'); f.audio({ type: 'ready' });
  const context = await f.event('context', { messages: [] });
  const policy = context.messages.at(-1).content;
  assert.match(policy, /Assume the user cannot see the screen/);
  assert.match(policy, /Do not replace a spoken answer with a screen referral/);
  assert.match(policy, /genuinely requires manual interaction/);
  assert.match(policy, /Report outcomes briefly/);
});

test('voice panel stays above the editor, follows activity and disappears when off', async () => {
  const f = fixture();
  await f.command('on');
  assert.equal(f.widgets.at(-1).options.placement, 'aboveEditor');
  f.audio({ type: 'ready' });
  await f.event('agent_start');
  assert.match(f.widgets.at(-1).lines[1], /WORKING/);
  f.audio({ type: 'addressed', id: 'current' });
  assert.match(f.widgets.at(-1).lines[1], /RECEIVING SPEECH/);
  f.audio({ type: 'cancelled', id: 'current' });
  assert.match(f.widgets.at(-1).lines[1], /WORKING/);
  await f.command('mute');
  assert.match(f.widgets.at(-1).lines[0], /MIC CLOSED/);
  await f.command('off');
  assert.equal(f.widgets.at(-1).lines, undefined);
});

test('a continuation gets playback context for the unheard prior answer without replay or resubmission', async () => {
  const f = fixture();
  await f.command('on'); f.audio({ type: 'ready' });
  f.audio({ type: 'addressed', id: 'first' });
  f.audio({ type: 'utterance', id: 'first', text: 'Suggest a shorter receipt, something more' });
  const first = { role: 'user', content: f.messages[0][0] };
  await f.event('context', { messages: [first] });
  const answer = { role: 'assistant', stopReason: 'stop', content: [
    { type: 'text', text: 'Got it feels friendly. Heard is shorter.' },
  ] };
  await f.event('message_end', { message: answer });
  const queued = f.frames.find(frame => frame.key === 'answer');
  f.audio({ type: 'addressed', id: 'continuation' });
  f.audio({ type: 'utterance', id: 'continuation', text: 'fun' });
  const context = await f.event('context', { messages: [first, answer,
    { role: 'user', content: f.messages[1][0] }] });
  const playback = context.messages.find(message => message.customType === 'paj-voice-playback');
  assert.ok(playback, 'Agent lacks the interrupted playback history');
  const record = JSON.parse(playback.content).find(entry => entry.id === queued.id);
  assert.equal(record.status, 'interrupted');
  assert.equal(record.reason, 'new_speech');
  assert.equal(record.text, 'Got it feels friendly. Heard is shorter.');
  assert.match(context.messages.at(-1).content, /continuation/);
  assert.match(context.messages.at(-1).content, /Never automatically replay/);
  assert.match(context.messages.at(-1).content, /Never rerun tools/);
  assert.equal(f.messages.length, 2);
  assert.match(f.messages[1][0], /\nfun$/);
  assert.equal(f.frames.filter(frame => frame.key === 'answer').length, 1);
  await f.command('off');
});

test('a final answer interrupted before queue admission is still provided to the next context', async () => {
  const f = fixture();
  await f.command('on'); f.audio({ type: 'ready' });
  f.audio({ type: 'addressed', id: 'review' });
  f.audio({ type: 'utterance', id: 'review', text: 'Review our settings.' });
  const first = { role: 'user', content: f.messages[0][0] };
  await f.event('context', { messages: [first] });
  f.audio({ type: 'addressed', id: 'receipt-question' });
  const reply = { role: 'assistant', stopReason: 'stop', content: [
    { type: 'text', text: 'Should I cover Paj, Captain, Voice and paj-rc?' },
  ] };
  await f.event('message_end', { message: reply });
  assert.equal(f.frames.filter(frame => frame.key === 'answer').length, 0);
  f.audio({ type: 'utterance', id: 'receipt-question', text: 'What was that receipt?' });
  const context = await f.event('context', { messages: [first, reply,
    { role: 'user', content: f.messages[1][0] }] });
  const history = context.messages.find(message => message.customType === 'paj-voice-playback');
  const record = JSON.parse(history.content).find(entry => entry.key === 'answer');
  assert.ok(record, 'A generated but never queued answer disappeared from delivery context');
  assert.equal(record.status, 'not_queued');
  assert.equal(record.reason, 'new_speech');
  assert.equal(record.text, 'Should I cover Paj, Captain, Voice and paj-rc?');
  assert.equal(f.messages.length, 2);
  await f.command('off');
});

test('setup selects friendly device names while off and saves without opening audio', async () => {
  const saved = [], menus = [];
  const f = fixture({ saveDevices: (file, audio) => saved.push({ file, audio }) });
  f.pi.exec = async () => ({ code: 0, stdout: JSON.stringify([
    { name: 'alsa_input.laptop', description: 'Laptop microphone', class: 'Audio/Source' },
    { name: 'bluez_input.headset', description: 'Bluetooth microphone', class: 'Audio/Source' },
    { name: 'bluez_output.sony', description: 'Sony headphones', class: 'Audio/Sink' },
  ]) });
  f.ctx.ui.select = async (title, labels) => { menus.push({ title, labels }); return labels[0]; };
  await f.command('setup');
  assert.match(menus[0].labels[0], /Laptop microphone/);
  assert.equal(menus[0].labels.length, 2);
  assert.match(menus[1].labels[0], /Sony headphones/);
  assert.deepEqual(saved[0].audio, { input: 'alsa_input.laptop', output: 'bluez_output.sony' });
  assert.equal(f.workers.length, 0);
  assert.equal(f.controller.state().enabled, false);
  await f.command('on'); f.audio({ type: 'ready' });
  await f.command('setup');
  assert.equal(saved.length, 1);
  assert.ok(f.notices.some(([text]) => text.includes('Turn voice off')));
  await f.command('off');
});

test('cancelled or invalidated device selection never writes preferences or opens audio', async () => {
  for (const invalidate of [false, true]) {
    const saved = [];
    const f = fixture({ saveDevices: (...args) => saved.push(args) });
    f.pi.exec = async () => ({ code: 0, stdout: JSON.stringify([
      { name: 'input', class: 'Audio/Source' }, { name: 'output', class: 'Audio/Sink' },
    ]) });
    f.ctx.ui.select = async (_title, labels) => {
      if (invalidate) await f.command('off');
      return invalidate ? labels[0] : undefined;
    };
    await f.command('setup');
    assert.equal(saved.length, 0);
    assert.equal(f.workers.length, 0);
  }
});

test('disabled feedback is respected in automatic timers and reporter-independent model policy', async () => {
  const f = fixture({ loadConfig: () => ({ feedback: { progressUpdates: false, idleReminders: false } }) });
  await f.command('on'); f.audio({ type: 'ready' });
  const context = await f.event('context', { messages: [] });
  const policy = context.messages.at(-1).content;
  assert.match(policy, /Spoken progress updates are disabled/);
  assert.match(policy, /Idle reminders are disabled/);
  assert.match(policy, /preferences apply to all reporting integrations/);
  assert.doesNotMatch(policy, /During long tasks, provide/);
  await f.command('off');
});

test('blocking terminal UI is reported but speech cannot implicitly approve it', async () => {
  const f = fixture();
  await f.command('on'); f.audio({ type: 'ready' });
  await f.event('ui_prompt_start');
  f.audio({ type: 'addressed', id: 'u1' });
  f.audio({ type: 'utterance', id: 'u1', text: 'Yes, approve it.' });
  assert.equal(f.messages.length, 0);
  assert.ok(f.frames.some(frame => frame.text === 'A terminal confirmation needs your attention.'));
});

test('never reads verbose assistant output or hidden reasoning into playback', async () => {
  const f = fixture();
  await f.command('on'); f.audio({ type: 'ready' });
  await f.event('agent_start');
  await f.event('message_end', { message: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'secret reasoning' }, { type: 'text', text: 'Long answer. '.repeat(500) },
  ] } });
  assert.equal(f.frames.length, 0);
  await f.event('agent_settled');
  assert.equal(f.frames.at(-1).text, 'I’ve finished this response, but did not produce a spoken summary. Ask me to summarize the result aloud.');
});

test('nested Pi tool call IDs become bounded transport IDs and remain deduplicated', async () => {
  const f = fixture();
  await f.command('on'); f.audio({ type: 'ready' });
  const state = f.controller.state();
  const tool = f.tools.get('voice_speak');
  const params = { text: 'The checks passed.', generation: state.generation, epoch: state.epoch };
  const first = await tool.execute('call/1/nested|provider', params);
  assert.equal(first.details.status, 'queued');
  assert.match(f.frames.at(-1).id, /^[a-f0-9]{64}$/);
  const second = await tool.execute('call/1/nested|provider', params);
  assert.equal(second.details.status, 'duplicate');
});

test('Paj identity loss stops voice instead of silently becoming standalone', async () => {
  const f = fixture();
  let identity = { id: 'paj-id', pid: process.pid, role: 'primary', piSessionId: 'session-one' };
  const paj = { version: 1, getSnapshot: () => ({ identity }), tryReserve: () => true, release() {} };
  f.events.on('paj:external:v1', query => query.reply(paj));
  await f.command('on'); f.audio({ type: 'ready' });
  identity = null;
  f.events.emit('paj:external:changed:v1');
  assert.equal(f.controller.state().enabled, false);
  assert.equal(f.workers[0].closed, true);
});

test('throwing state subscribers and API replies cannot prevent shutdown or retain activation', async () => {
  const f = fixture();
  let api;
  f.events.emit('paj-voice:api:v1', { reply: value => { api = value; } });
  assert.doesNotThrow(() => f.events.emit('paj-voice:api:v1', { reply() { throw new Error('hook'); } }));
  f.events.on('paj-voice:state:v1', () => { throw new Error('hook'); });
  await f.event('session_start');
  await f.command('on');
  f.audio({ type: 'ready' });
  assert.equal(api.getState().enabled, true);
  await f.event('session_shutdown');
  assert.equal(f.workers[0].closed, true);
  assert.equal(api.getState().enabled, false);
  assert.equal(api.speak({ text: 'Late.', ...api.getState() }).status, 'unavailable');
  assert.throws(() => api.registerReporter({ id: 'late', instructions: 'No.' }), /closed/);
  assert.equal(f.events.listenerCount('paj-voice:api:v1'), 0);
  assert.equal(f.events.listenerCount('paj:external:changed:v1'), 0);
});

test('mute terminates audio and unmute uses a fresh generation with stale callbacks fenced', async () => {
  const f = fixture();
  await f.command('on'); f.audio({ type: 'ready' });
  const old = f.workers[0];
  await f.command('mute');
  assert.equal(old.closed, true);
  assert.equal(f.controller.state().muted, true);
  old.args.onExit('Late close');
  assert.equal(f.controller.state().muted, true);
  await f.command('unmute');
  assert.equal(f.workers.length, 2);
  assert.notEqual(f.controller.state().generation, old.args.generation);
  assert.equal(f.controller.state().starting, true);
  old.args.onEvent({ type: 'ready' }, old.args.generation);
  assert.equal(f.controller.state().enabled, false);
  f.audio({ type: 'ready' });
  assert.equal(f.controller.state().enabled, true);
});

test('arming cancellation cannot open audio after off, and short final answers use actual voice context', async () => {
  const f = fixture();
  let confirm;
  f.ctx.ui.confirm = () => new Promise(resolve => { confirm = resolve; });
  const start = f.command('on');
  await f.command('off');
  confirm(true);
  await start;
  assert.equal(f.workers.length, 0);
  f.ctx.ui.confirm = async () => true;
  await f.command('on'); f.audio({ type: 'ready' });
  f.audio({ type: 'addressed', id: 'first' });
  f.audio({ type: 'utterance', id: 'first', text: 'How many seconds in a minute?' });
  const first = f.messages[0][0];
  await f.event('context', { messages: [{ role: 'user', content: first }] });
  f.audio({ type: 'addressed', id: 'second' });
  f.audio({ type: 'utterance', id: 'second', text: 'Actually answer another question.' });
  const before = f.frames.length;
  await f.event('message_end', { message: { role: 'assistant', stopReason: 'stop',
    content: [{ type: 'text', text: 'Old answer must not play.' }] } });
  assert.equal(f.frames.length, before);
  await f.event('context', { messages: f.messages.map(([content]) => ({ role: 'user', content })) });
  await f.event('message_end', { message: { role: 'assistant', stopReason: 'stop',
    content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'A current short answer.' }] } });
  assert.equal(f.frames.at(-1).text, 'A current short answer.');
});

test('session replacement and model selection stop capture without restoring or restricting tools', async () => {
  for (const event of ['session_start', 'model_select']) {
    const f = fixture();
    await f.command('on'); f.audio({ type: 'ready' });
    const worker = f.workers[0];
    await f.event(event);
    assert.equal(worker.closed, true);
    assert.equal(f.controller.state().enabled, false);
    assert.equal(f.widgets.at(-1).lines, undefined);
  }
});

test('prior worker callbacks cannot disable or submit into a newly enabled generation', async () => {
  const f = fixture();
  await f.command('on');
  f.audio({ type: 'ready' });
  const old = f.workers[0].args;
  await f.command('off');
  await f.command('on');
  f.audio({ type: 'ready' });
  const generation = f.controller.state().generation;
  old.onEvent({ type: 'addressed', id: 'old' }, old.generation);
  old.onEvent({ type: 'utterance', id: 'old', text: 'No.' }, old.generation);
  old.onExit('Late exit');
  assert.equal(f.controller.state().generation, generation);
  assert.equal(f.controller.state().enabled, true);
  assert.equal(f.messages.length, 0);
  await f.command('off');
});
