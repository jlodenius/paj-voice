import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadVoiceBuild } from '../src/build-loader.js';

test('reload follows the immutable build including transitive modules, not a cached symlink URL', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-build-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const version of ['old', 'new']) {
    const root = join(directory, version);
    const src = join(root, 'share/paj-voice/src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(src, 'controller.js'), `export const version = ${JSON.stringify(version)};\n`);
    writeFileSync(join(src, 'extension.js'), "import { version } from './controller.js';\nexport function registerVoice() { return version; }\n");
  }
  const link = join(directory, 'result-addon');
  symlinkSync(join(directory, 'old'), link);
  assert.equal((await loadVoiceBuild(link)).registerVoice(), 'old');
  unlinkSync(link);
  symlinkSync(join(directory, 'new'), link);
  const updated = await loadVoiceBuild(link);
  assert.equal(updated.root, join(directory, 'new'));
  assert.equal(updated.registerVoice(), 'new');
});
