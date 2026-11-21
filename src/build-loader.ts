import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { registerVoice as RegisterVoice } from "./extension.ts";

export async function loadVoiceBuild(packageLink: string) {
  // A mutable import URL keeps its old transitive ESM graph after a rebuild.
  const root = realpathSync(packageLink);
  const entry = join(root, "dist/extension.js");
  const { registerVoice } = (await import(pathToFileURL(entry).href)) as {
    registerVoice: typeof RegisterVoice;
  };
  return { root, registerVoice };
}
