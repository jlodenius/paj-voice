import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { fixture } from './fixtures/extension.js';

const desk = { input: 'private-desk-source', output: 'private-desk-sink' };
const headset = { input: 'private-headset-source', output: 'private-headset-sink' };
const tick = () => new Promise(resolve => setImmediate(resolve));
function routes() {
  const saved = { version: 2, active: 'desk', routes: { desk, headset } };
  const f = fixture({ env: { XDG_CONFIG_HOME: '/dev/null' },
    loadDevices: () => ({ version: 1, ...saved.routes[saved.active] }),
    loadRoutes: () => structuredClone(saved), saveRoute: (_path, name) => { saved.active = name; } });
  f.pi.exec = async () => ({ code: 0, stdout: JSON.stringify(Object.values(saved.routes)
    .flatMap(route => [{ name: route.input, class: 'Audio/Source' },
      { name: route.output, class: 'Audio/Sink' }])) });
  return { ...f, saved };
}
const panel = f => f.widgets.at(-1)?.lines?.join('\n') ?? '';
const status = f => f.statuses.at(-1)?.[1];
const ready = f => f.audio({ type: 'ready' });
async function arm(f) { await f.command('on'); ready(f); }

test('route visuals distinguish saved selection from ready audio through startup, mute, selection and off', async () => {
  const f = routes();
  await f.command('on');
  assert.match(panel(f), /warming up/);
  assert.match(panel(f), /Audio: desk \(selected\)/);
  assert.doesNotMatch(panel(f), /Audio: desk (?!\(selected\))/);
  ready(f);
  assert.doesNotMatch(panel(f), /\(selected\)/);
  assert.match(panel(f), /VOICE MODE \| OPEN MIC/);
  assert.doesNotMatch(panel(f).split('\n')[0], /desk/);
  assert.match(panel(f), /Audio: desk/);
  assert.match(status(f), /Audio: desk/);
  await f.command('mute');
  assert.match(panel(f), /MIC CLOSED/);
  assert.match(panel(f), /Audio: desk \(selected\)/);
  await f.command('route headset');
  assert.match(panel(f), /Audio: headset \(selected\)/);
  assert.equal(f.workers.length, 1);
  await f.command('unmute');
  assert.match(panel(f), /Audio: headset \(selected\)/);
  assert.doesNotMatch(panel(f), /Audio: headset (?!\(selected\))/);
  ready(f);
  assert.match(panel(f), /Audio: headset/);
  assert.doesNotMatch(panel(f), /\(selected\)/);
  await f.command('off');
  assert.equal(f.widgets.at(-1).lines, undefined);
  assert.equal(status(f), undefined);
  await f.command('route desk');
  await f.command('status');
  assert.match(f.notices.at(-1)[0], /Routes:.*"current":"desk"/);
  assert.equal(f.workers.length, 2);
});

test('active badges follow the armed selection rather than later saved-route changes', async () => {
  const f = routes();
  f.ctx.ui.confirm = async () => { f.saved.active = 'headset'; return true; };
  await f.command('on');
  assert.match(panel(f), /Audio: headset \(selected\)/);
  ready(f);
  assert.match(panel(f), /Audio: desk/);
  assert.doesNotMatch(panel(f), /Audio: headset/);
  await f.event('agent_start');
  assert.match(status(f), /Audio: desk/);
  await f.command('mute');
  assert.match(panel(f), /Audio: headset \(selected\)/);
  await f.command('off');
});

test('switch and rollback never advertise a target as active before readiness or leak private endpoints', async () => {
  for (const outcome of ['success', 'rollback', 'failed', 'cancel']) {
    const f = routes();
    await arm(f);
    const pending = f.command('route headset');
    await tick();
    assert.match(panel(f), /Audio: desk \(selected\) → headset \(switching\)/);
    assert.doesNotMatch(status(f), /Audio: headset (?!\(selected\))/);
    if (outcome === 'success') {
      ready(f); await pending;
      assert.match(panel(f), /Audio: headset/);
      assert.doesNotMatch(panel(f), /\(selected\)/);
    } else if (outcome === 'cancel') {
      await f.command('mute'); await pending;
      ready(f);
      assert.match(panel(f), /MIC CLOSED/);
      assert.match(panel(f), /Audio: desk \(selected\)/);
      assert.doesNotMatch(panel(f), /switching|Audio: headset/);
    } else {
      f.audio({ type: 'error' }); await tick();
      assert.doesNotMatch(panel(f), /Audio: (?:headset|desk) (?!\(selected\))/);
      if (outcome === 'rollback') ready(f);
      else f.audio({ type: 'error' });
      await pending;
      if (outcome === 'rollback') {
        assert.match(panel(f), /Audio: desk/);
        assert.doesNotMatch(panel(f), /\(selected\)/);
      }
      else assert.equal(f.widgets.at(-1).lines, undefined);
    }
    const visuals = JSON.stringify([f.widgets.map(widget => widget.lines), f.statuses]);
    assert.doesNotMatch(visuals, /private-|source|sink/);
    await f.command('off');
  }
});

test('route names remain available in narrow panels and every rendered line stays within terminal columns', async () => {
  const f = routes();
  await arm(f);
  const component = f.widgets.at(-1).component;
  for (const width of [1, 4, 8, 12, 20, 40, 80]) {
    const lines = component.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `${width}: ${lines.join('\n')}`);
    const text = lines.join('').replaceAll(/[│ ]/gu, '');
    assert.match(text, /Audio:desk/);
  }
  component.invalidate();
  assert.deepEqual(component.render(80), f.widgets.at(-1).lines);
  await f.command('off');
});
