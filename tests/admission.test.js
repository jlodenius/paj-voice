import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdmission } from '../src/admission.js';

function fixture(withPaj = false) {
  let idle = true, editorBusy = false;
  const reservations = new Set(), sent = [];
  const ctx = { mode: 'tui', hasUI: true, isIdle: () => idle, sessionManager: { getSessionId: () => 's' } };
  const paj = {
    version: 1,
    getSnapshot: () => ({ editorBusy, identity: { id: 'p', role: 'primary', pid: process.pid, piSessionId: 's' } }),
    tryReserve(token) { if (reservations.size) return false; reservations.add(token); return true; },
    release(token) { reservations.delete(token); },
  };
  const pi = { sendUserMessage: (...args) => sent.push(args) };
  const admission = createAdmission({ pi, getContext: () => ctx, queryPaj: () => withPaj ? paj : null,
    sessionId: 's', generation: 'g', env: {} });
  const submit = (requestId = 'r') => admission.submit({ text: 'hello', sessionId: 's', generation: 'g', requestId });
  return { admission, submit, ctx, paj, pi, sent, reservations,
    busy: () => { idle = false; }, editor: () => { editorBusy = true; } };
}

test('ordinary Pi works with neither Paj nor Captain installed', () => {
  const f = fixture();
  assert.equal(f.submit().steering, false);
  assert.deepEqual(f.sent[0], ['hello', { expandPromptTemplates: false }]);
  assert.throws(() => f.submit('r2'), { code: 'busy' });
  f.admission.started();
  f.busy();
  assert.equal(f.submit('r3').steering, true);
  assert.equal(f.sent[1][1].deliverAs, 'steer');
});

test('a follow-up during Pi startup is queued as steering instead of lost before agent_start', () => {
  const f = fixture(true);
  f.submit('first');
  f.busy();
  assert.equal(f.submit('addition').steering, true);
  assert.equal(f.sent.length, 2);
  f.admission.started();
  f.admission.settled();
  assert.equal(f.reservations.size, 0);
});

test('Paj editor and other external reservations are honored', () => {
  const f = fixture(true);
  f.editor();
  assert.throws(() => f.submit(), { code: 'editor_busy' });
  assert.equal(f.sent.length, 0);
  const g = fixture(true);
  g.reservations.add('rc-owned');
  assert.throws(() => g.submit(), { code: 'editor_busy' });
  assert.deepEqual([...g.reservations], ['rc-owned']);
});

test('own reservation excludes uncertain pending dispatch then shares active steering run', () => {
  const f = fixture(true);
  f.submit();
  assert.equal(f.reservations.size, 1);
  assert.throws(() => f.submit('r2'), { code: 'busy' });
  f.busy();
  f.admission.started();
  assert.equal(f.reservations.size, 0);
  f.submit('r3');
  f.submit('r4');
  assert.equal(f.reservations.size, 1);
  f.admission.settled();
  assert.equal(f.reservations.size, 0);
});

test('stale target, unavailable Paj identity and child sessions fail closed', () => {
  const f = fixture(true);
  assert.throws(() => f.admission.submit({ sessionId: 'other', generation: 'g', text: 'no' }), { code: 'unavailable' });
  f.paj.getSnapshot = () => ({ identity: null });
  assert.throws(() => f.submit(), { code: 'unavailable' });
  const g = fixture();
  g.ctx.sessionManager.getSessionId = () => 'replacement';
  assert.throws(() => g.submit(), { code: 'unavailable' });
  const child = createAdmission({ pi: {}, getContext: () => g.ctx, queryPaj: () => null,
    sessionId: 'replacement', generation: 'g', env: { PAJ_SPAWN_ID: 'child' } });
  assert.throws(() => child.submit({ sessionId: 'replacement', generation: 'g' }), { code: 'unavailable' });
});

test('closing voice releases its own reservation but never aborts Pi work', () => {
  const f = fixture(true);
  f.submit();
  f.admission.close();
  assert.equal(f.reservations.size, 0);
  assert.throws(() => f.submit(), { code: 'unavailable' });
  assert.equal(f.sent.length, 1);
});

test('throwing optional reservation release cannot strand local admission state or break close', () => {
  const f = fixture(true);
  f.submit();
  f.paj.release = () => { throw new Error('Paj hook failed'); };
  assert.doesNotThrow(() => f.admission.close());
  assert.doesNotThrow(() => f.admission.close());
  assert.throws(() => f.submit(), { code: 'unavailable' });
});
