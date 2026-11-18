import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createAdmission } from '../src/admission.ts';

const source = process.env.PAJ_VOICE_PAJ_EXTENSION
  ? pathToFileURL(resolve(process.env.PAJ_VOICE_PAJ_EXTENSION, 'external-session.ts'))
  : undefined;

test('actual Paj reservation interface excludes editor/other addons and releases only voice ownership',
  { skip: !source || !existsSync(source) }, async () => {
    const { createExternalSession } = await import(source.href);
    let editorBusy = false, idle = true;
    const external = createExternalSession(() => editorBusy, () => {});
    external.update({ id: 'paj-main', pid: process.pid, role: 'primary', piSessionId: 'session' });
    const sent = [];
    const admission = createAdmission({
      pi: { sendUserMessage: (...args) => sent.push(args) },
      getContext: () => ({ mode: 'tui', hasUI: true, isIdle: () => idle,
        sessionManager: { getSessionId: () => 'session' } }),
      queryPaj: () => external.api, sessionId: 'session', generation: 'generation', env: {},
    });
    const submit = requestId => admission.submit({ requestId, text: 'Check the tests.',
      sessionId: 'session', generation: 'generation' });
    editorBusy = true;
    assert.throws(() => submit('editor-owned'), { code: 'editor_busy' });
    editorBusy = false;
    assert.equal(external.api.tryReserve('rc-owned'), true);
    assert.throws(() => submit('rc-conflict'), { code: 'editor_busy' });
    external.api.release('rc-owned');
    submit('voice-idle');
    assert.equal(external.api.tryReserve('another-addon'), false);
    admission.started();
    assert.equal(external.api.getSnapshot().externalBusy, false);
    idle = false;
    submit('voice-steer');
    submit('voice-addition');
    assert.equal(external.api.tryReserve('another-addon'), false);
    admission.close();
    assert.equal(external.api.tryReserve('another-addon'), true);
    assert.equal(sent.length, 3);
    assert.equal(sent.at(-1)[1].deliverAs, 'steer');
  });
