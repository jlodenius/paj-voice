import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';

const desk = { input: 'synthetic-mic', output: 'synthetic-headphones' };
const spare = { input: 'synthetic-spare-mic', output: 'synthetic-spare-output' };
const tick = () => new Promise(resolve => setImmediate(resolve));

function delayedFixture() {
  const launches = [];
  const saved = { version: 2, active: 'desk', routes: { desk, spare } };
  const f = fixture({ loadRoutes: () => structuredClone(saved),
    loadDevices: () => ({ version: 1, ...saved.routes[saved.active] }),
    saveRoute: (_file, name) => { saved.active = name; },
    startCompanion(args) {
      let exit;
      const exited = new Promise(resolve => { exit = resolve; });
      const launch = { args, exit, closes: 0 };
      launches.push(launch);
      return { send: () => true, close() { launch.closes++; }, waitClosed: () => exited };
    } });
  f.pi.exec = async () => ({ code: 0, stdout: JSON.stringify([
    { class: 'Audio/Source', name: spare.input }, { class: 'Audio/Sink', name: spare.output },
  ]) });
  const ready = index => {
    const { args } = launches[index];
    args.onEvent({ type: 'ready' }, args.generation);
  };
  return { ...f, launches, ready, async arm() { await f.command('on'); ready(0); } };
}

async function status(f, state) {
  await f.command('status');
  assert.ok(f.notices.at(-1)[0].includes(`Audio process teardown: ${state}\n`));
}

for (const [stop, start] of [['pause', 'resume'], ['off', 'on']]) {
  test(`${stop} reports closing and ${start} cannot confirm or launch before exit`, async () => {
    const f = delayedFixture();
    await f.arm();
    let confirms = 0;
    f.ctx.ui.confirm = async () => { confirms++; return true; };
    const stopped = f.command(stop);
    assert.match(f.notices.at(-1)[0], /closing.*not yet confirmed/);
    assert.equal(f.controller.state().listening, false);
    assert.match(f.statuses.at(-1)[1], /AUDIO CLOSING/);
    assert.doesNotMatch(f.widgets.at(-1).lines.join('\n'), /MIC CLOSED/);
    await status(f, 'closing');
    const restarted = f.command(start);
    await tick();
    assert.equal(confirms, 0);
    assert.equal(f.launches.length, 1);
    assert.equal(f.launches[0].closes, 1);
    f.launches[0].exit();
    await Promise.all([stopped, restarted]);
    assert.ok(f.notices.some(([message]) => message.includes('the audio process is closed')));
    assert.equal(confirms, 1);
    assert.equal(f.launches.length, 2);
    f.launches[1].exit();
    await f.command('off');
  });
}

test('timeout reports unconfirmed closure and blocks rearm until a late exit and fresh request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = delayedFixture();
  await f.arm();
  const pausing = f.command('pause');
  const earlyResume = f.command('resume');
  t.mock.timers.tick(5000);
  await Promise.all([pausing, earlyResume]);
  assert.ok(f.notices.some(([msg, level]) => level === 'warning' && /Do not assume microphone privacy/.test(msg)));
  assert.match(f.notices.at(-1)[0], /Cannot arm Voice.*unconfirmed/);
  await status(f, 'unconfirmed');
  assert.match(f.statuses.at(-1)[1], /CLOSURE UNCONFIRMED/);
  await f.command('resume');
  assert.equal(f.launches.length, 1);
  f.launches[0].exit();
  await tick();
  await status(f, 'closed');
  assert.match(f.statuses.at(-1)[1], /MIC CLOSED/);
  assert.equal(f.launches.length, 1, 'late exit does not automatically rearm');
  await f.command('resume');
  assert.equal(f.launches.length, 2);
  f.launches[1].exit();
  await f.command('off');
});

test('off during route handoff cancels the route and retains the retiring process for manual rearm', async () => {
  const f = delayedFixture();
  await f.arm();
  const switched = f.command('route spare');
  await tick();
  assert.equal(f.launches[0].closes, 1);
  const off = f.command('off');
  const on = f.command('on');
  await tick();
  assert.equal(f.launches.length, 1);
  f.launches[0].exit();
  await Promise.all([switched, off, on]);
  assert.deepEqual(f.launches.map(({ args }) => args.config.audio.input), [desk.input, desk.input]);
  f.launches[1].exit();
  await f.command('off');
});

test('pause during rollback cancels the switch without cancelling a subsequent manual resume', async () => {
  const f = delayedFixture();
  await f.arm();
  const switched = f.command('route spare');
  await tick();
  f.launches[0].exit();
  await tick();
  f.launches[1].args.onEvent({ type: 'error' }, f.launches[1].args.generation);
  await tick();
  f.launches[1].exit();
  await tick();
  assert.equal(f.launches[2].args.config.audio.input, desk.input);
  const pausing = f.command('pause');
  const resuming = f.command('resume');
  await switched;
  assert.match(f.notices.at(-1)[0], /"status":"cancelled"/);
  assert.equal(f.controller.state().muted, true);
  assert.equal(f.launches.length, 3);
  f.ready(2);
  f.launches[2].args.onExit('stale retirement callback');
  assert.equal(f.controller.state().muted, true);
  f.launches[2].exit();
  await Promise.all([pausing, resuming]);
  assert.ok(f.notices.some(([msg]) => msg.startsWith('Voice paused; the audio process is closed')));
  f.ready(3);
  f.launches[2].args.onExit('stale retirement callback');
  assert.equal(f.controller.state().listening, true);
  f.launches[3].exit();
  await f.command('off');
});

test('an audio route retirement timeout stops Voice instead of launching or rolling back', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = delayedFixture();
  await f.arm();
  const switched = f.command('route spare');
  await tick();
  t.mock.timers.tick(5000);
  await switched;
  assert.equal(f.launches.length, 1);
  assert.equal(f.controller.state().enabled, false);
  assert.match(f.notices.at(-1)[0], /"recovered":false.*closure is unconfirmed/);
  await f.command('on');
  assert.equal(f.launches.length, 1);
  f.launches[0].exit();
  await tick();
  await status(f, 'closed');
});
