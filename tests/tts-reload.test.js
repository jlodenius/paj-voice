import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';

test('reload only sends output settings to the existing worker and waits for its matching acknowledgement', async t => {
  let settings = {};
  const f = fixture({ loadConfig: () => settings });
  t.after(() => f.command('off'));
  assert.ok(f.commands.get('paj-voice').getArgumentCompletions('rel').some(x => x.value === 'reload'));
  await f.command('reload');
  assert.equal(f.workers.length, 0);
  await f.command('on');
  await f.command('reload');
  assert.equal(f.frames.some(frame => frame.type === 'reload_tts'), false);
  f.audio({ type: 'ready' });
  const original = f.controller.state();
  const from = f.frames.length;
  settings = { voice: 'amy', volume: 30, speed: 1.25 };
  await f.command('reload');
  await f.command('reload');
  assert.equal(f.workers.length, 1);
  assert.equal(f.workers[0].closed, false);
  assert.deepEqual(f.controller.state(), original);
  const [request] = f.frames.slice(from);
  assert.deepEqual(f.frames.slice(from), [{ type: 'reload_tts', id: request.id,
    tts: { voice: 'amy', volume: 0.3, lengthScale: 0.8 } }]);
  f.audio({ type: 'tts_reloaded', id: 'wrong', applied: true });
  assert.equal(f.notices.some(([message]) => message === 'Voice output reloaded.'), false);
  f.audio({ type: 'tts_reloaded', id: request.id, applied: true });
  assert.equal(f.notices.at(-1)[0], 'Voice output reloaded.');
});

test('reload is a no-op for equivalent defaults and restarts changed settings without a second arm confirmation', async t => {
  let settings = {};
  const f = fixture({ loadConfig: () => settings });
  t.after(() => f.command('off'));
  let confirmations = 0;
  f.ctx.ui.confirm = async () => { confirmations++; return true; };
  await f.command('on');
  f.audio({ type: 'ready' });
  settings = { volume: 40, speed: 1, pauseSeconds: 0.8, audioDucking: { enabled: false } };
  await f.command('reload');
  assert.match(f.notices.at(-1)[0], /unchanged/);
  assert.equal(f.workers.length, 1);
  settings = { pauseSeconds: 2, feedback: { receipt: 'Changed.' } };
  await f.command('reload');
  assert.equal(confirmations, 1);
  assert.equal(f.workers.length, 2);
  assert.equal(f.workers[0].closed, true);
  assert.notEqual(f.workers[0].args.generation, f.workers[1].args.generation);
  assert.equal(f.controller.state().starting, true);
});

test('changed devices and paused capture do not authorize a restart', async t => {
  let settings = {};
  let input = 'laptop';
  const f = fixture({ loadConfig: () => settings, loadDevices: () => ({ version: 1, input, output: 'headphones' }) });
  t.after(() => f.command('off'));
  await f.command('on');
  f.audio({ type: 'ready' });
  settings = { pauseSeconds: 2 };
  input = 'different';
  await f.command('reload');
  assert.match(f.notices.at(-1)[0], /endpoint consent/);
  assert.equal(f.workers.length, 1);
  assert.equal(f.workers[0].closed, false);
  input = 'laptop';
  await f.command('pause 10 seconds');
  assert.ok(f.controller.state().inputPause);
  await f.command('reload');
  assert.match(f.notices.at(-1)[0], /paused microphone/);
  assert.equal(f.workers.length, 1);
});

test('reload waits for process closure and a later off cancels replacement', async () => {
  let settings = {};
  const f = fixture({ loadConfig: () => settings });
  await f.command('on');
  f.audio({ type: 'ready' });
  const exit = Promise.withResolvers();
  f.workers[0].waitClosed = () => exit.promise;
  settings = { pauseSeconds: 2 };
  const reload = f.command('reload');
  assert.equal(f.workers[0].closed, true);
  assert.equal(f.workers.length, 1);
  const off = f.command('off');
  exit.resolve();
  await Promise.all([reload, off]);
  assert.equal(f.workers.length, 1);
  assert.equal(f.controller.state().enabled, false);
});

test('a synchronous off during reload shutdown cancels replacement', async () => {
  let settings = {};
  const f = fixture({ loadConfig: () => settings });
  await f.command('on');
  f.audio({ type: 'ready' });
  let off;
  f.events.once('paj-voice:state:v1', () => { off = f.command('off'); });
  settings = { pauseSeconds: 2 };
  await f.command('reload');
  assert.ok(off);
  await off;
  assert.equal(f.workers.length, 1);
  assert.equal(f.controller.state().enabled, false);
});

for (const command of ['off', 'pause']) {
  for (const phase of ['starting', 'validation']) {
    test(`synchronous ${command} during replacement ${phase} prevents capture startup`, async () => {
      let settings = {};
      const f = fixture({ loadConfig: () => settings });
      await f.command('on');
      f.audio({ type: 'ready' });
      const original = f.controller.state().generation;
      let cancellation;
      const cancel = () => {
        const state = f.controller.state();
        if (state.starting && state.generation !== original)
          cancellation = f.command(command);
      };
      f.events.on(phase === 'starting' ? 'paj-voice:state:v1' : 'paj:external:v1', cancel);
      settings = { pauseSeconds: 2 };
      await f.command('reload');
      assert.ok(cancellation);
      await cancellation;
      assert.equal(f.workers.length, 1);
      assert.equal(f.workers[0].closed, true);
      assert.equal(f.controller.state().muted, command === 'pause');
    });
  }
}

test('reload rejects invalid preferences, negative acknowledgements, and stale worker events', async t => {
  let settings = {};
  const f = fixture({ loadConfig: () => settings });
  t.after(() => f.command('off'));
  await f.command('on');
  f.audio({ type: 'ready' });
  const reloads = () => f.frames.filter(frame => frame.type === 'reload_tts');
  for (const invalid of [{ voice: '../../invalid' }, { speed: 0 }, { volume: 101 }]) {
    settings = invalid;
    await f.command('reload');
    assert.equal(reloads().length, 0);
  }
  settings = { voice: 'valid-id-but-not-installed' };
  await f.command('reload');
  f.audio({ type: 'tts_reloaded', id: reloads().at(-1).id, applied: false });
  assert.match(f.notices.at(-1)[0], /previous output is unchanged/);
  await f.command('reload');
  const old = f.workers.at(-1);
  const id = reloads().at(-1).id;
  await f.command('pause');
  await f.command('reload');
  assert.equal(reloads().length, 2);
  assert.equal(f.workers.length, 1);
  await f.command('resume');
  f.audio({ type: 'ready' });
  old.args.onEvent({ type: 'tts_reloaded', id, applied: true }, old.args.generation);
  assert.equal(f.notices.some(([message]) => message === 'Voice output reloaded.'), false);
});
