import { userInfo } from 'node:os';
import { join } from 'node:path';

type Environment = Record<string, string | undefined>;

export function assertDefaultFocusEnvironment(env: Environment): void {
  const home = userInfo().homedir;
  if (Object.entries(env).some(([key, value]) => key.startsWith('PIPEWIRE_') && value &&
      !(key === 'PIPEWIRE_REMOTE' && value === 'pipewire-0')) ||
      (env.HOME !== undefined && env.HOME !== home) ||
      (env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== join(home, '.config'))) {
    throw new Error('Background audio focus supports only the default user PipeWire server and configuration');
  }
}

export function focusSpawnEnvironment(env: Environment): Record<string, string> {
  assertDefaultFocusEnvironment(env);
  const safe: Record<string, string> = { HOME: userInfo().homedir };
  for (const key of ['PATH', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (env[key] !== undefined) safe[key] = env[key];
  }
  return safe;
}
