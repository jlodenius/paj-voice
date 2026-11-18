import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';
import { validateConfig } from '../src/config.ts';
import { createVoiceController } from '../src/controller.ts';

test('two-minute messages are supported by default with an explicit bounded preference', () => {
  assert.equal(validateConfig({}).maxMessageSeconds, 120);
  assert.equal(validateConfig({ maxMessageSeconds: 120 }).maxMessageSeconds, 120);
  assert.throws(() => validateConfig({ maxMessageSeconds: 121 }));
});

function recoveryFixture(t, options = {}) {
  const f = fixture(options);
  let draft = '';
  f.ctx.ui.getEditorText = () => draft;
  f.ctx.ui.setEditorText = text => { draft = text; };
  t.after(() => f.command('off'));
  return { ...f, draft: () => draft };
}

test('a duration-limited transcript is preserved for manual review, not submitted or announced as accepted', async t => {
  const f = recoveryFixture(t);
  await f.command('on'); f.audio({ type: 'ready' });
  f.audio({ type: 'addressed', id: 'long' });
  f.audio({ type: 'limit', id: 'long' });
  assert.ok(f.notices.some(([text]) => text.includes('Stop speaking')));
  f.audio({ type: 'review', id: 'long', text: 'Delete the old files except' });
  f.audio({ type: 'review', id: 'long', text: 'Duplicate event.' });
  assert.equal(f.messages.length, 0);
  assert.equal(f.draft(), '');
  assert.ok(f.notices.some(([text]) => text.includes('/paj-voice recover')));
  assert.equal(f.frames.some(frame => frame.text === 'Got it.'), false);
  await f.command('off');
  await f.command('recover');
  assert.equal(f.draft(), 'Delete the old files except');
  assert.equal(f.messages.length, 0);
  f.ctx.ui.setEditorText('');
  await f.command('recover');
  assert.equal(f.draft(), '');
});

test('recovery does not overwrite editor content and survives a failed editor write', async t => {
  const f = recoveryFixture(t);
  await f.command('on'); f.audio({ type: 'ready' });
  f.audio({ type: 'addressed', id: 'long' });
  f.audio({ type: 'review', id: 'long', text: 'The captured prefix.' });
  f.ctx.ui.setEditorText('Existing draft.');
  await f.command('recover');
  assert.equal(f.draft(), 'Existing draft.');
  f.ctx.ui.setEditorText('');
  const write = f.ctx.ui.setEditorText;
  f.ctx.ui.setEditorText = () => { throw new Error('Editor unavailable'); };
  await f.command('recover');
  f.ctx.ui.setEditorText = write;
  await f.command('recover');
  assert.equal(f.draft(), 'The captured prefix.');
  assert.equal(f.messages.length, 0);
});

test('recovery drafts and late native events cannot cross sessions or muted generations', async t => {
  const f = recoveryFixture(t);
  await f.command('on'); f.audio({ type: 'ready' });
  f.audio({ type: 'addressed', id: 'first' });
  f.audio({ type: 'review', id: 'first', text: 'Private old-session draft.' });
  const late = f.workers.at(-1).args;
  f.replace(); await f.event('session_start');
  late.onEvent({ type: 'review', id: 'first', text: 'Late old transcript.' }, late.generation);
  await f.command('recover');
  assert.equal(f.draft(), '');
  await f.command('on'); f.audio({ type: 'ready' });
  f.audio({ type: 'addressed', id: 'second' });
  const muted = f.workers.at(-1).args;
  await f.command('mute');
  muted.onEvent({ type: 'review', id: 'second', text: 'Late muted transcript.' }, muted.generation);
  await f.command('recover');
  assert.equal(f.draft(), '');
  assert.equal(f.messages.length, 0);
});

test('recovery storage is bounded without overwriting older drafts and stops further capture when full', async t => {
  const f = recoveryFixture(t);
  await f.command('on'); f.audio({ type: 'ready' });
  for (let i = 0; i < 4; i++) {
    f.audio({ type: 'addressed', id: `long-${i}` });
    f.audio({ type: 'review', id: `long-${i}`, text: `Saved prefix ${i}.` });
  }
  const notices = f.frames.filter(frame => frame.key === 'limit-review');
  assert.equal(notices.length, 4);
  assert.ok(notices.at(-1).text.includes('Voice is stopping'));
  f.audio({ type: 'speech_start', id: notices.at(-1).id });
  f.audio({ type: 'speech_end', id: notices.at(-1).id, completed: true });
  assert.equal(f.controller.state().enabled, false);
  assert.equal(f.workers.at(-1).closed, true);
  const workers = f.workers.length;
  await f.command('on');
  assert.equal(f.workers.length, workers);
  assert.equal(f.controller.state().enabled, false);
  for (let i = 0; i < 4; i++) {
    await f.command('recover');
    assert.equal(f.draft(), `Saved prefix ${i}.`);
    f.ctx.ui.setEditorText('');
  }
  assert.equal(f.messages.length, 0);
});

test('a recovery buffer filling during route preflight prevents late capture launch', async t => {
  const selection = { input: 'laptop', output: 'headphones' };
  const f = recoveryFixture(t, { loadRoutes: () => ({ version: 2, active: 'desk',
    routes: { desk: selection, headset: selection } }) });
  await f.command('on'); f.audio({ type: 'ready' });
  for (let i = 0; i < 3; i++) {
    f.audio({ type: 'addressed', id: `prefix-${i}` });
    f.audio({ type: 'review', id: `prefix-${i}`, text: `Saved prefix ${i}.` });
  }
  let resolve;
  f.pi.exec = () => new Promise(done => { resolve = done; });
  const pending = f.command('route headset');
  f.audio({ type: 'addressed', id: 'fourth' });
  f.audio({ type: 'review', id: 'fourth', text: 'Saved fourth prefix.' });
  resolve({ code: 0, stdout: JSON.stringify([{ name: 'laptop', class: 'Audio/Source' },
    { name: 'headphones', class: 'Audio/Sink' }]) });
  await new Promise(done => setImmediate(done));
  if (f.workers.length > 1) f.audio({ type: 'ready' });
  await pending;
  assert.equal(f.workers.length, 1);
  const notice = f.frames.filter(frame => frame.key === 'limit-review').at(-1);
  f.audio({ type: 'speech_end', id: notice.id, completed: true });
  assert.equal(f.controller.state().enabled, false);
});

test('full-buffer shutdown remains bounded if its notice is cancelled and stale deadlines cannot close a restart', t => {
  let deadline, closures = 0, sequence = 0;
  const controller = createVoiceController({ submit() { throw new Error('No submission allowed'); },
    send: () => true, recover: () => 'full', close: () => closures++,
    uuid: () => `recovery-${++sequence}`,
    setTimer(callback, delay) { if (delay === 30_000) deadline = callback; return ++sequence; },
    clearTimer() {} });
  t.after(() => controller.dispose());
  controller.start('session');
  const event = frame => controller.event(frame, controller.state().generation);
  event({ type: 'ready' }); event({ type: 'addressed', id: 'full' });
  event({ type: 'review', id: 'full', text: 'Saved incomplete prefix.' });
  assert.equal(typeof deadline, 'function');
  const stale = deadline;
  controller.silence(); deadline();
  assert.equal(closures, 1);
  controller.stop(); controller.start('session'); event({ type: 'ready' });
  stale();
  assert.equal(closures, 1);
});

test('terminal capture IDs cannot replay recovery and a limit cannot become an actionable prefix', async t => {
  const f = recoveryFixture(t);
  await f.command('on'); f.audio({ type: 'ready' });
  f.audio({ type: 'addressed', id: 'limited' });
  f.audio({ type: 'limit', id: 'limited' });
  f.audio({ type: 'utterance', id: 'limited', text: 'Incomplete prefix.' });
  f.audio({ type: 'addressed', id: 'limited' });
  f.audio({ type: 'review', id: 'limited', text: 'Replayed prefix.' });
  assert.equal(f.messages.length, 0);
  await f.command('recover');
  assert.equal(f.draft(), 'Incomplete prefix.');
  f.ctx.ui.setEditorText('');
  await f.command('recover');
  assert.equal(f.draft(), '');
});

test('cancelled and malformed captures give feedback but cannot create a recoverable or actionable request', async t => {
  const f = recoveryFixture(t);
  await f.command('on'); f.audio({ type: 'ready' });
  f.audio({ type: 'review', id: 'unknown', text: 'Injected prefix.' });
  f.audio({ type: 'addressed', id: 'empty' });
  f.audio({ type: 'limit', id: 'empty' });
  f.audio({ type: 'cancelled', id: 'empty', reason: 'empty' });
  assert.ok(f.notices.some(([text]) => text.includes('No speech could be transcribed')));
  await f.command('recover');
  assert.equal(f.draft(), '');
  assert.equal(f.messages.length, 0);
});
