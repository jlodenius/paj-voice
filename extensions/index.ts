import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { fileURLToPath } from 'node:url';
import type { loadVoiceBuild as LoadVoiceBuild } from '../src/build-loader.ts';

export default async function (pi: ExtensionAPI) {
  const { loadVoiceBuild } = await import(new URL('../dist/build-loader.js', import.meta.url).href) as {
    loadVoiceBuild: typeof LoadVoiceBuild;
  };
  const { root, registerVoice } = await loadVoiceBuild(fileURLToPath(new URL('..', import.meta.url)));
  registerVoice(pi, Type, { buildId: root });
}
