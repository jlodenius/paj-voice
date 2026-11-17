import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadVoiceBuild(packageLink) {
  // A mutable import URL keeps its old transitive ESM graph after a rebuild.
  const root = realpathSync(packageLink);
  const entry = join(root, 'share/paj-voice/src/extension.js');
  const { registerVoice } = await import(pathToFileURL(entry).href);
  return { root, registerVoice };
}
