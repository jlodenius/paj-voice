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
  settings = { voice: 'amy', volume: 30, speed: 1.25, pauseSeconds: 2, feedback: { receipt: 'Changed.' } };
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
