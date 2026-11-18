import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
  symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadVoiceBuild } from '../src/build-loader.ts';

const project = fileURLToPath(new URL('../', import.meta.url));
const build = () => {
  const result = spawnSync(process.execPath, ['scripts/build.ts'], { cwd: project, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
before(build);

test('reload follows the immutable build including transitive modules, not a cached symlink URL', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-build-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const version of ['old', 'new']) {
    const root = join(directory, version);
    const src = join(root, 'dist');
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

test('generated JavaScript is deterministic and runs under node_modules without TypeScript source', t => {
  const files = readdirSync(join(project, 'dist')).sort();
  const contents = () => files.map(name => readFileSync(join(project, 'dist', name), 'utf8'));
  const first = contents();
  build();
  assert.deepEqual(contents(), first);
  for (const output of first) {
    assert.doesNotMatch(output, /(?:from\s*|import\s*\(\s*)['"]\.\.?\/[^'"]+\.ts['"]/u);
  }
  const directory = mkdtempSync(join(tmpdir(), 'voice-node-modules-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const installed = join(directory, 'node_modules/paj-voice');
  mkdirSync(installed, { recursive: true });
  cpSync(join(project, 'dist'), join(installed, 'dist'), { recursive: true });
  writeFileSync(join(installed, 'package.json'), '{"type":"module"}');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { loadVoiceBuild } from './node_modules/paj-voice/dist/build-loader.js';
    import { createVoiceController } from './node_modules/paj-voice/dist/controller.js';
    const loaded = await loadVoiceBuild('./node_modules/paj-voice');
    if (typeof loaded.registerVoice !== 'function') throw new Error('Missing built entrypoint');
    const controller = createVoiceController({ submit() {}, send() {} });
    if (controller.state().enabled) throw new Error('Audio armed automatically');
  `], { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
