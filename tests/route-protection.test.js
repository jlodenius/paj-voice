import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as store from '../src/device-settings.ts';
import { fixture } from './fixtures/extension.js';

test('ordinary setup explicitly saves speakers protection and carries it into the runtime snapshot', async t => {
  const f = configured(t, { outputHint: 'speakers' });
  const dialogs = [];
  f.ctx.ui.confirm = async (title, text) => { dialogs.push([title, text]); return true; };
  await f.command('setup desk');
  assert.deepEqual(store.loadRoutes(f.file)?.routes.desk, { ...desk, speakerMode: true });
  assert.equal(f.workers.length, 0);
  assert.match(dialogs.at(-1)[1], /half-duplex/i);
  assert.match(dialogs.at(-1)[1], /initial preferred/i);
  await f.command('on');
  assert.equal(f.workers[0].args.config.audio.speakerMode, true);
});

test('compiled ordinary setup sends the explicit speaker flag to the compiled runtime', async t => {
  const { registerVoice } = await import('../dist/extension.js');
  const f = configured(t, { bluetooth: true, outputHint: 'headphones' }, registerVoice);
  await f.command('setup desk');
  assert.equal(store.loadRoutes(f.file)?.routes.desk.speakerMode, true);
  await f.command('on');
  assert.equal(f.workers[0].args.config.audio.speakerMode, true);
  f.audio({ type: 'ready', speakerMode: true, listening: false });
  assert.equal(f.controller.state().speakerMode, true);
  assert.equal(f.controller.state().listening, false);
});

test('speaker-safe runtime advertises half-duplex and a typed stop without closing audio or agent work', async t => {
  const f = configured(t);
  store.saveRoute(f.file, 'desk', { ...desk, speakerMode: true });
  await f.command('on');
  f.audio({ type: 'ready', speakerMode: true, listening: false });
  const panel = f.widgets.at(-1).component.render(140).join('\n');
  assert.match(panel, /HALF-DUPLEX/);
  assert.match(panel, /Stop speech: \/paj-voice stop/);
  assert.doesNotMatch(panel, /interrupt with your voice/);
  await f.command('stop');
  assert.equal(f.frames.at(-1).type, 'stop');
  assert.equal(f.workers[0].closed, false);
  assert.equal(f.controller.state().enabled, true);
});

test('setup recommendations never replace explicit consent; confirmed headphones stay full-duplex', async t => {
  for (const output of [{}, { outputHint: 'headphones' }, { outputHint: 'speakers' },
    { bluetooth: true, outputHint: 'headphones' }, { outputHint: 'invalid' }]) {
    for (const headphones of [false, true]) {
      const f = configured(t, output);
      let chooser;
      f.ctx.ui.select = async (title, choices) => {
        if (title.startsWith('Playback protection:')) {
          chooser = title;
          assert.match(choices[0], /protection ON/);
          return choices[headphones ? 1 : 0];
        }
        return choices[0];
      };
      await f.command('setup desk');
      assert.equal(store.loadRoutes(f.file)?.routes.desk.speakerMode, !headphones);
      if (output.bluetooth || output.outputHint !== 'headphones') assert.match(chooser, /ON recommended/);
      else assert.match(chooser, /not proof/);
      await f.command('on');
      assert.equal(f.workers[0].args.config.audio.speakerMode === true, !headphones);
      f.audio({ type: 'ready', speakerMode: !headphones, listening: headphones });
      const speech = f.frames.findLast(frame => frame.type === 'speak');
      if (speech) f.audio({ type: 'speech_start', id: speech.id });
      f.audio({ type: 'addressed', id: 'synthetic-interruption' });
      f.audio({ type: 'utterance', id: 'synthetic-interruption', text: 'Synthetic user interruption.' });
      assert.equal(f.messages.length, headphones ? 1 : 0);
      await f.command('off');
    }
  }
});

test('ordinary setup preserves the current preferred and fallback unless explicitly selected', async t => {
  for (const activate of [false, true]) {
    const f = configured(t);
    store.saveRoute(f.file, 'desk', desk);
    store.saveFallback(f.file, 'reserve', travel);
    const before = store.loadRoutes(f.file);
    f.ctx.ui.select = async (title, choices) =>
      choices[title === 'Preferred route after saving' && activate ? 1 : 0];
    await f.command('setup travel');
    const after = store.loadRoutes(f.file);
    assert.equal(after.active, activate ? 'travel' : 'desk');
    assert.equal(after.fallback, 'reserve');
    assert.deepEqual(after.routes.desk, before.routes.desk);
    assert.deepEqual(after.routes.reserve, before.routes.reserve);
    assert.deepEqual(after.routes.travel, { ...desk, speakerMode: true });
    assert.equal(f.workers.length, 0);
  }
});

test('protection command retrofits legacy routes without changing endpoints, preferred or fallback', async t => {
  const f = configured(t);
  store.saveRoute(f.file, 'desk', desk);
  store.saveFallback(f.file, 'reserve', travel);
  const before = store.loadRoutes(f.file);
  await f.command('protection desk speakers');
  assert.deepEqual(store.loadRoutes(f.file), { ...before,
    routes: Object.assign(Object.create(null), before.routes, { desk: { ...desk, speakerMode: true } }) });
  await f.command('protection desk headphones');
  assert.deepEqual(store.loadRoutes(f.file).routes.desk, { ...desk, speakerMode: false });
  await f.command('protection reserve headphones');
  assert.equal(store.loadRoutes(f.file).routes.reserve.speakerMode, true);
  assert.equal(f.workers.length, 0);
  assert.equal(store.loadRoutes(f.file).fallback, 'reserve');
});

test('setup cancellation and stale sessions at every consent stage leave the saved routes byte-identical', async t => {
  for (const stage of [1, 2, 3, 4, 5]) {
    for (const action of ['cancel', 'off', 'replace', 'no-ui']) {
      const f = configured(t);
      store.saveRoute(f.file, 'desk', desk);
      const before = readFileSync(f.file, 'utf8');
      let step = 0;
      const respond = async answer => {
        if (++step !== stage) return answer;
        if (action === 'off') await f.command('off');
        if (action === 'replace') f.replace();
        if (action === 'no-ui') f.ctx.hasUI = false;
        return action === 'cancel' ? undefined : answer;
      };
      f.ctx.ui.select = async (_title, choices) => respond(choices[0]);
      f.ctx.ui.confirm = async () => respond(true);
      await f.command('setup travel');
      assert.equal(readFileSync(f.file, 'utf8'), before, `${stage}/${action}`);
      assert.equal(f.workers.length, 0);
    }
  }
});

test('setup refuses an unexpectedly created or changed route instead of overwriting it', async t => {
  for (const exists of [false, true]) {
    const f = configured(t);
    store.saveRoute(f.file, 'desk', desk);
    if (exists) store.saveRouteBinding(f.file, 'travel', travel, store.loadRoutes(f.file));
    const concurrent = { ...travel, output: 'synthetic-concurrent-output' };
    f.ctx.ui.confirm = async () => {
      store.saveRouteBinding(f.file, 'travel', concurrent, store.loadRoutes(f.file));
      return true;
    };
    await f.command('setup travel');
    assert.deepEqual(store.loadRoutes(f.file).routes.travel, concurrent);
    assert.equal(store.loadRoutes(f.file).active, 'desk');
    assert.match(f.notices.at(-1)[0], /changed/);
  }
});

test('protection consent is canceled by off, session replacement, UI loss, cancellation or route edits', async t => {
  for (const action of ['cancel', 'off', 'replace', 'no-ui', 'route-change', 'becomes-fallback']) {
    const f = configured(t);
    store.saveRoute(f.file, 'desk', desk);
    let expected = store.loadRoutes(f.file);
    f.ctx.ui.confirm = async () => {
      if (action === 'off') await f.command('off');
      if (action === 'replace') f.replace();
      if (action === 'no-ui') f.ctx.hasUI = false;
      if (action === 'route-change') store.saveRoute(f.file, 'desk', travel);
      if (action === 'becomes-fallback') store.saveFallback(f.file, 'desk');
      expected = store.loadRoutes(f.file);
      return action !== 'cancel';
    };
    await f.command('protection desk headphones');
    assert.deepEqual(store.loadRoutes(f.file), expected, action);
    assert.equal(f.workers.length, 0);
  }
});

test('replacement command contexts invalidate pending main-TUI consent even in the same session', async t => {
  for (const command of ['setup desk', 'protection desk speakers']) {
    const f = configured(t);
    store.saveRoute(f.file, 'desk', desk);
    const before = readFileSync(f.file, 'utf8');
    f.ctx.ui.confirm = async () => {
      await f.commands.get('paj-voice').handler('status', { ...f.ctx, mode: 'rpc' });
      return true;
    };
    await f.command(command);
    assert.equal(readFileSync(f.file, 'utf8'), before);
    assert.equal(f.workers.length, 0);
  }
});

test('armed runtime snapshots cannot be silently edited or rearmed by setup/protection commands', async t => {
  const f = configured(t);
  store.saveRoute(f.file, 'desk', { ...desk, speakerMode: false });
  const before = readFileSync(f.file, 'utf8');
  await f.command('on');
  f.audio({ type: 'ready' });
  assert.equal(f.workers[0].args.config.audio.speakerMode, undefined);
  await f.command('protection desk speakers');
  await f.command('setup desk');
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.equal(f.workers.length, 1);
  assert.equal(f.workers[0].closed, false);
  assert.ok(f.notices.some(([text]) => /original snapshot/.test(text)));
});

test('non-primary or non-TUI sessions cannot configure protection or setup', async t => {
  for (const scope of ['parent', 'spawn', 'task', 'parent-task', 'role', 'rpc', 'no-ui']) {
    const env = { XDG_CONFIG_HOME: '/dev/null', ...{
      parent: { PAJ_PARENT_PI_SESSION_ID: 'fake' }, spawn: { PAJ_SPAWN_ID: 'fake' },
      task: { PAJ_TASK_ID: 'fake' }, 'parent-task': { PAJ_PARENT_TASK_ID: 'fake' },
      role: { PAJ_ROLE: 'worker' },
    }[scope] };
    const f = fixture({ env });
    t.after(() => f.command('off'));
    f.pi.exec = async () => assert.fail('Enumeration forbidden in non-primary sessions');
    f.ctx.ui.confirm = async () => assert.fail('Consent forbidden in non-primary sessions');
    f.ctx.ui.select = async () => assert.fail('Chooser forbidden in non-primary sessions');
    if (scope === 'rpc') f.ctx.mode = 'rpc';
    if (scope === 'no-ui') f.ctx.hasUI = false;
    await f.command('setup desk');
    await f.command('protection desk speakers');
    assert.equal(f.workers.length, 0);
  }
});

test('output hints are advisory metadata only; Bluetooth, absent and invalid hints remain unknown', () => {
  const choices = store.deviceChoices([
    { name: 'a', class: 'Audio/Sink', outputHint: 'speakers' },
    { name: 'b', class: 'Audio/Sink', outputHint: 'headphones' },
    { name: 'c', class: 'Audio/Sink', outputHint: 'headphones', bluetooth: true },
    { name: 'headphones', description: 'Headphones', class: 'Audio/Sink' },
    { name: 'e', class: 'Audio/Sink', outputHint: 'invalid' },
  ], 'Audio/Sink');
  assert.deepEqual(choices.map(choice => choice.outputHint),
    ['speakers', 'headphones', 'unknown', 'unknown', 'unknown']);
});

test('fallback approval shows the saved pair and requires fresh approval after a route edit', async t => {
  const f = configured(t);
  store.saveRoute(f.file, 'desk', desk);
  store.saveRouteBinding(f.file, 'travel', travel, store.loadRoutes(f.file));
  const replacement = { ...travel, input: 'synthetic-replacement-mic' };
  let confirmed = 0;
  f.ctx.ui.confirm = async (title, text) => {
    assert.match(title, /automatic fallback/);
    assert.ok(text.includes(`Playback: ${travel.output} (device: ${travel.outputDevice})`));
    const pair = confirmed++ === 0 ? travel : replacement;
    assert.ok(text.includes(`Microphone: ${pair.input} (device: ${pair.inputDevice})`));
    if (pair === travel) store.saveRouteBinding(f.file, 'travel', replacement, store.loadRoutes(f.file));
    return true;
  };
  await f.command('fallback travel');
  assert.match(f.notices.at(-1)[0], /changed during fallback confirmation/);
  assert.deepEqual(store.loadRoutes(f.file).routes.travel, replacement);
  assert.equal(store.loadRoutes(f.file).fallback, undefined);
  await f.command('fallback travel');
  assert.equal(store.loadRoutes(f.file).fallback, 'travel');
  assert.equal(store.loadRoutes(f.file).active, 'desk');
  assert.equal(confirmed, 2);
  assert.equal(f.workers.length, 0);
});

const desk = { input: 'synthetic-mic', output: 'synthetic-output' };
const travel = { input: 'synthetic-other-mic', output: 'synthetic-other-output',
  inputDevice: 'synthetic-input-card', outputDevice: 'synthetic-output-card', speakerMode: true };
function configured(t, output = {}, register) {
  const file = storage(t);
  const f = fixture({ env: { XDG_CONFIG_HOME: '/dev/null' },
    loadRoutes: () => store.loadRoutes(file),
    loadDevices: (_file, required = true) => store.loadDevices(file, required),
    saveRouteBinding: (_file, ...args) => store.saveRouteBinding(file, ...args),
    saveFallback: (_file, ...args) => store.saveFallback(file, ...args),
    updateRouteProtection: (_file, ...args) => store.updateRouteProtection(file, ...args) }, register);
  f.pi.exec = async (_executable, args) => {
    assert.deepEqual(args, ['--devices'], 'only synthetic enumeration is allowed');
    return { code: 0, stdout: JSON.stringify([
      { name: desk.input, class: 'Audio/Source' },
      { name: desk.output, class: 'Audio/Sink', ...output },
    ]) };
  };
  f.ctx.ui.select = async (_title, choices) => choices[0];
  t.after(() => f.command('off'));
  return { ...f, file };
}

function storage(t) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-protection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'devices.json');
}

test('saving a binding preserves preferred and fallback routes, with CAS and private serialization', t => {
  const file = storage(t);
  store.saveRoute(file, 'desk', desk);
  store.saveFallback(file, 'reserve', travel);
  const before = store.loadRoutes(file);
  store.saveRouteBinding(file, 'travel', travel, before);
  assert.deepEqual(store.loadRoutes(file), { ...before,
    routes: Object.assign(Object.create(null), before.routes, { travel }) });
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, 'utf8').includes('"speakerMode": true'), true);
  const saved = readFileSync(file, 'utf8');
  assert.throws(() => store.saveRouteBinding(file, 'travel', desk, before), /changed/);
  assert.equal(readFileSync(file, 'utf8'), saved);
  store.saveRouteBinding(file, 'travel', travel, store.loadRoutes(file), true);
  assert.equal(store.loadRoutes(file).active, 'travel');
});

test('protection updates require an explicit boolean and share the private atomic-save lock', t => {
  const file = storage(t);
  store.saveRoute(file, 'desk', desk);
  const before = readFileSync(file, 'utf8');
  for (const invalid of [undefined, null, 'true', 0, {}, []]) {
    assert.throws(() => store.updateRouteProtection(file, 'desk', invalid, desk), /speaker mode/);
    assert.equal(readFileSync(file, 'utf8'), before);
  }
  const snapshot = store.loadRoutes(file);
  const lock = join(dirname(file), '.devices.lock');
  writeFileSync(lock, 'synthetic lock', { mode: 0o600 });
  assert.throws(() => store.updateRouteProtection(file, 'desk', true, desk), /being changed/);
  assert.throws(() => store.saveRouteBinding(file, 'travel', travel, snapshot), /being changed/);
  assert.equal(readFileSync(file, 'utf8'), before);
  rmSync(lock);
  store.updateRouteProtection(file, 'desk', true, desk);
  assert.deepEqual(readdirSync(dirname(file)), ['devices.json']);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
});

test('legacy v1 remains byte-identical without consent, then explicitly migrates protection only', async t => {
  const f = configured(t, { outputHint: 'headphones' });
  const raw = JSON.stringify({ version: 1, ...desk });
  writeFileSync(f.file, raw, { mode: 0o600 });
  f.ctx.ui.select = async () => undefined;
  await f.command('protection default');
  assert.equal(readFileSync(f.file, 'utf8'), raw);
  await f.command('on');
  assert.equal(readFileSync(f.file, 'utf8'), raw);
  await f.command('off');
  await f.command('protection default speakers');
  assert.deepEqual(store.loadDevices(f.file), { version: 1, ...desk, speakerMode: true });
  assert.equal(store.loadRoutes(f.file).active, 'default');
  assert.equal(store.loadRoutes(f.file).fallback, undefined);
});

test('protection editing changes only the explicit flag, supports legacy routes and refuses stale consent or unsafe fallback', t => {
  const file = storage(t);
  store.saveRoute(file, 'desk', desk);
  store.saveFallback(file, 'reserve', travel);
  const before = store.loadRoutes(file);
  store.updateRouteProtection(file, 'desk', true, desk);
  assert.deepEqual(store.loadRoutes(file), { ...before,
    routes: Object.assign(Object.create(null), before.routes, { desk: { ...desk, speakerMode: true } }) });
  const saved = readFileSync(file, 'utf8');
  assert.throws(() => store.updateRouteProtection(file, 'desk', false, desk), /changed/);
  assert.throws(() => store.updateRouteProtection(file, 'reserve', false, travel), /fallback/i);
  assert.equal(readFileSync(file, 'utf8'), saved);
  store.updateRouteProtection(file, 'desk', false, { ...desk, speakerMode: true });
  assert.deepEqual(store.loadRoutes(file).routes.desk, { ...desk, speakerMode: false });
  assert.equal(store.loadRoutes(file).active, 'desk');
  assert.equal(store.loadRoutes(file).fallback, 'reserve');
});
