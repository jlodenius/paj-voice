import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';

const panel = f => f.widgets.at(-1)?.lines?.join('\n') ?? '';
async function armed() {
  const f = fixture();
  await f.command('on');
  f.audio({ type: 'ready' });
  return f;
}

test('typed timed pause aliases use strict bounded duration grammar and leave output armed', async () => {
  for (const command of ['pause 10 seconds', 'mute 10 seconds', 'mute for 10 seconds', 'pause 1 minute', 'mute 5s', 'pause for 2 min']) {
    const f = await armed();
    await f.command(command);
    assert.equal(f.frames.at(-1).type, 'input_pause', command);
    assert.equal(f.workers[0].closed, false);
    assert.match(panel(f), /MIC PAUSING/);
    assert.match(panel(f), /closure unconfirmed/i);
    assert.doesNotMatch(panel(f), /Microphone closed|remaining/);
    assert.match(f.notices.at(-1)[0], /requested.*closure unconfirmed/i);
    await f.command('off');
  }
  for (const duration of ['0 seconds', '301s', '-1s', '+1s', '1.5 seconds', '1 second junk', '10', '1m 2s', '6m', '1e2s']) {
    const f = await armed();
    const before = f.frames.length;
    await f.command(`pause ${duration}`);
    assert.equal(f.frames.length, before, duration);
    assert.equal(f.workers[0].closed, false);
    assert.match(f.notices.at(-1)[0], /1.*300|duration/i);
    await f.command('off');
  }
});

test('timed pause cancellation follows off, full pause, shutdown, session replacement and user stop', async () => {
  for (const action of ['off', 'pause', 'shutdown', 'session', 'stop']) {
    const f = await armed();
    await f.command('pause 1s');
    const request = f.frames.at(-1), worker = f.workers[0];
    f.audio({ type: 'input_pause_state', id: request.id, phase: 'paused', remainingMs: 800 });
    if (action === 'shutdown') await f.event('session_shutdown');
    else if (action === 'session') { f.replace(); await f.event('session_start'); }
    else await f.command(action);
    worker.args.onEvent({ type: 'input_pause_state', id: request.id, phase: 'resumed', remainingMs: 0, listening: true },
      worker.args.generation);
    assert.equal(f.controller.state().listening, false, action);
    assert.equal(f.controller.state().inputPause, action === 'stop' ? 'held' : null, action);
    assert.equal(f.workers.length, 1);
    await f.command('off');
  }
});

test('timed requests never bypass main TUI gates or fresh manual resume consent', async () => {
  const f = await armed();
  const tool = f.tools.get('voice_pause_input'), token = f.controller.state();
  f.ctx.mode = 'rpc';
  assert.equal((await tool.execute('rpc', { ...token, seconds: 10 })).details.status, 'unavailable');
  const before = f.frames.length;
  await f.command('mute for 10s');
  assert.equal(f.frames.length, before);
  f.ctx.mode = 'tui';
  f.replace();
  assert.equal((await tool.execute('other-session', { ...token, seconds: 10 })).details.status, 'unavailable');
  await f.command('off');
  const g = await armed();
  await g.command('pause 10s');
  g.ctx.ui.confirm = async () => false;
  await g.command('resume');
  assert.equal(g.workers.length, 1);
  assert.equal(g.workers[0].closed, true);
  assert.equal(g.controller.state().enabled, false);
  await g.command('off');
});

test('spoken input pause tool is hidden off and gated by tokens; countdown distinguishes warming and held', async () => {
  const f = fixture();
  assert.equal(f.tools.get('voice_pause_input')?.exposure, 'hidden');
  await f.command('on');
  f.audio({ type: 'ready' });
  const tool = f.tools.get('voice_pause_input');
  assert.equal(tool.exposure, 'direct');
  const token = f.controller.state();
  assert.equal((await tool.execute('stale', { ...token, seconds: 10, epoch: token.epoch - 1 })).details.status, 'stale');
  assert.equal((await tool.execute('mute-ten', { ...token, seconds: 10 })).details.status, 'requested');
  const request = f.frames.at(-1);
  assert.equal(request.type, 'input_pause');
  assert.equal((await tool.execute('mute-ten', { ...token, seconds: 10 })).details.status, 'duplicate');
  f.audio({ type: 'input_pause_state', id: request.id, phase: 'paused', remainingMs: 4000 });
  assert.match(panel(f), /4s/);
  f.audio({ type: 'input_pause_state', id: request.id, phase: 'warming', remainingMs: 0 });
  assert.match(panel(f), /WARMING/);
  assert.doesNotMatch(panel(f), /LISTENING/);
  f.audio({ type: 'input_pause_state', id: request.id, phase: 'held', remainingMs: 0 });
  assert.match(panel(f), /MIC HELD/);
  assert.match(panel(f), /resume/);
  await f.command('resume');
  assert.equal(f.workers[0].closed, true);
  assert.equal(f.workers.length, 2);
  await f.command('pause');
  assert.equal(f.workers[1].closed, true);
  assert.equal(f.controller.state().muted, true);
  await f.command('off');
});
