import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Environment } from "./types.ts";

export function runtimePaths(env: Environment = process.env, home = homedir()) {
  const cacheRoot = env.XDG_CACHE_HOME || join(home, ".cache");
  if (!isAbsolute(cacheRoot) || /[\u0000-\u001f\u007f]/u.test(cacheRoot)) {
    throw new Error("XDG_CACHE_HOME must be an absolute local directory");
  }
  return {
    executable: fileURLToPath(
      new URL("../../../bin/paj-voice-audio", import.meta.url),
    ),
    cacheDir: join(cacheRoot, "paj-voice"),
  };
}
