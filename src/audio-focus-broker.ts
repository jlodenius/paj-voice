import { createServer, createConnection } from "node:net";
import type { Server, Socket } from "node:net";
import {
  lstat,
  readFile,
  mkdir,
  mkdtemp,
  chmod,
  link,
  unlink,
  rmdir,
} from "node:fs/promises";
import { join, isAbsolute, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import type { BackgroundAudioSettings } from "./audio-focus-types.ts";
import { assertDefaultFocusEnvironment } from "./audio-focus-environment.ts";
import { isBackgroundAudioSelector } from "./config.ts";
import {
  createFocusDiagnosticSender,
  encodeFocusDiagnostic,
  safeFocusDiagnostic,
  focusErrorCode,
  focusElapsed,
} from "./audio-focus-diagnostics.ts";
import type { FocusDiagnostic } from "./audio-focus-diagnostics.ts";

export const FOCUS_FRAME_BYTES = 16384;
export const FOCUS_HEARTBEAT_MS = 2000;
export const FOCUS_DEADLINE_MS = 8000;
const SOCKET_NAME = "focus-v1.sock";

type Environment = Record<string, string | undefined>;
interface Engine {
  set(
    owner: string,
    settings: BackgroundAudioSettings | null,
    immediate?: boolean,
  ): Promise<void>;
  close(): Promise<void>;
  hasUnconfirmedRestorations?(): boolean;
  recover?(): Promise<void>;
}
export interface FocusFileSystem {
  lstat(path: string): Promise<Stats>;
}
const localFileSystem: FocusFileSystem = { lstat };
export interface BrokerOptions {
  engine?:
    | Engine
    | ((
        onWarning: (message: string) => void,
        onDiagnostic: (event: FocusDiagnostic) => void,
      ) => Engine);
  filesystem?: FocusFileSystem;
  server?: Server;
  runtimeDir?: string;
  env?: Environment;
  idleMs?: number;
  deadlineMs?: number;
  onWarning?: (message: string) => void;
  onDiagnostic?: (event: FocusDiagnostic) => void;
}

export function validFocusSettings(
  value: unknown,
): value is BackgroundAudioSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  const list = (v: unknown) =>
    Array.isArray(v) && v.length <= 32 && v.every(isBackgroundAudioSelector);
  return (
    Object.keys(s).every((k) =>
      ["mode", "gain", "apps", "excludeApps"].includes(k),
    ) &&
    (s.mode === "off" || s.mode === "duck" || s.mode === "duck-all") &&
    typeof s.gain === "number" &&
    Number.isFinite(s.gain) &&
    s.gain >= 0.05 &&
    s.gain <= 1 &&
    list(s.apps) &&
    list(s.excludeApps) &&
    (s.mode !== "duck" || (s.apps as unknown[]).length > 0)
  );
}

async function privateDirectory(
  path: string,
  create: boolean,
  filesystem: FocusFileSystem,
): Promise<void> {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path))
    throw new Error("Invalid focus runtime path");
  if (resolve(path) !== path)
    throw new Error("Noncanonical focus runtime path");
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const ancestor = await filesystem.lstat(parent);
    if (
      !ancestor.isDirectory() ||
      ancestor.isSymbolicLink() ||
      (ancestor.uid !== 0 && ancestor.uid !== process.getuid?.()) ||
      ((ancestor.mode & 0o022) !== 0 &&
        !(ancestor.uid === 0 && ancestor.mode & 0o1000))
    ) {
      throw new Error("Unsafe focus runtime parent");
    }
    if (parent === dirname(parent)) break;
  }
  if (create)
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  const stat = await filesystem.lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new Error("Unsafe focus runtime directory");
  }
}

export async function focusRuntimeDirectory(
  env: Environment = process.env,
  filesystem: FocusFileSystem = localFileSystem,
): Promise<string> {
  if (env.XDG_RUNTIME_DIR) {
    await privateDirectory(env.XDG_RUNTIME_DIR, false, filesystem);
    const path = join(env.XDG_RUNTIME_DIR, "paj-voice-focus");
    await privateDirectory(path, true, filesystem);
    return path;
  }
  const base = await filesystem.lstat("/tmp");
  if (
    !base.isDirectory() ||
    base.isSymbolicLink() ||
    base.uid !== 0 ||
    !(base.mode & 0o1000)
  ) {
    throw new Error("Unsafe temporary directory");
  }
  const path = `/tmp/paj-voice-focus-${process.getuid?.()}`;
  await privateDirectory(path, true, filesystem);
  return path;
}

export async function focusSocketPath(
  runtimeDir: string,
  filesystem: FocusFileSystem = localFileSystem,
): Promise<string> {
  await privateDirectory(runtimeDir, false, filesystem);
  const path = join(runtimeDir, SOCKET_NAME);
  if (Buffer.byteLength(path) > 100)
    throw new Error("Focus socket path too long");
  return path;
}

function checkedFocusSocketStat(stat: Stats): Stats {
  if (
    !stat.isSocket() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error("Unsafe focus socket");
  }
  return stat;
}

async function checkedFocusSocket(
  path: string,
  filesystem: FocusFileSystem,
): Promise<Stats> {
  return checkedFocusSocketStat(await filesystem.lstat(path));
}

export async function verifyFocusSocket(
  path: string,
  filesystem: FocusFileSystem = localFileSystem,
): Promise<void> {
  checkedFocusSocketStat(await filesystem.lstat(path));
}

function alive(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(500, () => {
      socket.destroy();
      reject(new Error("Focus socket probe timed out"));
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT")
        resolve(false);
      else reject(error);
    });
  });
}

export async function runAudioFocusBroker(options: BrokerOptions = {}) {
  const started = performance.now();
  const clients = new Set<Socket>();
  const diagnostic = (event: FocusDiagnostic, excluded?: Socket) => {
    const safe = safeFocusDiagnostic(event);
    if (!safe) return;
    try {
      options.onDiagnostic?.(safe);
    } catch {}
    const encoded = encodeFocusDiagnostic(safe);
    if (!encoded) return;
    const frame = JSON.stringify({ v: 1, warning: encoded }) + "\n";
    for (const socket of clients) {
      if (
        socket !== excluded &&
        !socket.destroyed &&
        socket.writableLength <= FOCUS_FRAME_BYTES
      )
        socket.write(frame);
    }
  };
  if (options.engine === undefined) {
    try {
      assertDefaultFocusEnvironment(process.env);
      assertDefaultFocusEnvironment(options.env ?? process.env);
      if (
        options.env &&
        options.env.XDG_RUNTIME_DIR !== process.env.XDG_RUNTIME_DIR
      ) {
        throw new Error(
          "Default user PipeWire runtime must match the broker process environment",
        );
      }
    } catch (error) {
      diagnostic({
        component: "broker",
        operation: "environment",
        reason: "environment_rejected",
        elapsedMs: focusElapsed(started),
      });
      throw error;
    }
  }
  const warn = (message: string) => {
    const warning = message
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .slice(0, 256);
    try {
      options.onWarning?.(warning);
    } catch {}
    const frame = JSON.stringify({ v: 1, warning }) + "\n";
    for (const socket of clients) {
      if (!socket.destroyed && socket.writableLength <= FOCUS_FRAME_BYTES)
        socket.write(frame);
    }
  };
  const filesystem = options.filesystem ?? localFileSystem;
  let runtimeDir: string;
  let path: string;
  try {
    runtimeDir =
      options.runtimeDir ??
      (await focusRuntimeDirectory(options.env, filesystem));
    path = await focusSocketPath(runtimeDir, filesystem);
  } catch (error) {
    diagnostic({
      component: "broker",
      operation: "runtime",
      reason: "runtime_rejected",
      elapsedMs: focusElapsed(started),
      code: focusErrorCode(error),
    });
    throw error;
  }
  const lock = join(runtimeDir, "starting");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    diagnostic({
      component: "broker",
      operation: "startup",
      reason: "startup_failed",
      elapsedMs: focusElapsed(started),
      code: focusErrorCode(error),
    });
    throw error;
  }
  let startupOwnsLock = true;
  const server = options.server ?? createServer();
  let engine: Engine;
  try {
    try {
      const previous = await checkedFocusSocket(path, filesystem);
      if (await alive(path))
        throw new Error("Audio focus broker already running");
      const current = await filesystem.lstat(path);
      if (previous.dev !== current.dev || previous.ino !== current.ino)
        throw new Error("Focus socket changed during startup");
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (options.engine) {
      engine =
        typeof options.engine === "function"
          ? options.engine(warn, diagnostic)
          : options.engine;
    } else {
      const xdgRuntime = (options.env ?? process.env).XDG_RUNTIME_DIR;
      if (!xdgRuntime || runtimeDir !== join(xdgRuntime, "paj-voice-focus"))
        throw new Error(
          "Durable audio focus requires a private XDG runtime directory",
        );
      const boot = (
        await readFile("/proc/sys/kernel/random/boot_id", "utf8")
      ).trim();
      const recoveryEpoch = async () => {
        const socket = await lstat(join(xdgRuntime, "pipewire-0"), {
          bigint: true,
        });
        if (
          !socket.isSocket() ||
          socket.uid !== BigInt(process.getuid?.() ?? -1)
        )
          throw new Error("PipeWire socket identity is unavailable");
        return `${boot}:${socket.dev}:${socket.ino}:${socket.ctimeNs}`;
      };
      engine = (await import("./audio-focus.ts")).createAudioFocus(
        (await import("./pipewire-focus.ts")).createPipeWireFocusGraph({
          onDiagnostic: diagnostic,
        }),
        {
          onWarning: warn,
          onRecoveryDrained: () => scheduleIdle(),
          recoveryEpoch,
          journal: await (
            await import("./audio-focus-journal.ts")
          ).openFocusJournal(runtimeDir),
        },
      );
    }
  } catch (error) {
    diagnostic({
      component: "broker",
      operation: "startup",
      reason: "startup_failed",
      elapsedMs: focusElapsed(started),
      code: focusErrorCode(error),
    });
    await rmdir(lock);
    throw error;
  }
  const releases = new Map<Socket, () => Promise<void>>();
  let stagingDirectory: string | undefined;
  let stagingIdentity: Stats | undefined;
  let stagingPath: string | undefined;
  let socketIdentity: Stats | undefined;
  let published = false;
  const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
  const unlinkOwnedSocket = async (candidate: string) => {
    try {
      const stat = await filesystem.lstat(candidate);
      if (
        socketIdentity &&
        sameFile(stat, socketIdentity) &&
        stat.isSocket() &&
        !stat.isSymbolicLink() &&
        stat.uid === process.getuid?.()
      )
        await unlink(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  const cleanupPublication = async () => {
    let cleanupOwnsLock = false;
    if (published && !startupOwnsLock) {
      // A publisher must not replace the pathname between the inode check and unlink.
      try {
        await mkdir(lock, { mode: 0o700 });
        cleanupOwnsLock = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    try {
      if (published && (startupOwnsLock || cleanupOwnsLock))
        await unlinkOwnedSocket(path);
      if (stagingPath) await unlinkOwnedSocket(stagingPath);
      if (stagingDirectory && stagingIdentity) {
        try {
          const stat = await filesystem.lstat(stagingDirectory);
          if (sameFile(stat, stagingIdentity)) await rmdir(stagingDirectory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } finally {
      if (cleanupOwnsLock) await rmdir(lock);
    }
  };
  let idle: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  let stopping = false;
  const waitForCleanup = async (job: Promise<void>) => {
    const timer = setTimeout(() => {
      diagnostic({
        component: "broker",
        operation: "cleanup",
        reason: "cleanup_slow",
        elapsedMs: 3000,
        timeoutMs: 3000,
      });
      warn("Background audio cleanup is taking longer than expected");
    }, 3000);
    try {
      await job;
    } finally {
      clearTimeout(timer);
    }
  };
  const scheduleIdle = () => {
    clearTimeout(idle);
    if (!clients.size && !stopping && !engine.hasUnconfirmedRestorations?.())
      idle = setTimeout(() => {
        if (!engine.hasUnconfirmedRestorations?.()) void close();
      }, options.idleMs ?? 2000);
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    stopping = true;
    clearTimeout(idle);
    closing = (async () => {
      await Promise.allSettled(
        [...releases.values()].map((release) => release()),
      );
      for (const socket of clients) socket.destroy();
      if (published || options.engine)
        await waitForCleanup(engine.close()).catch((error) => {
          diagnostic({
            component: "broker",
            operation: "cleanup",
            reason: "cleanup_failed",
            code: focusErrorCode(error),
          });
          warn("Background audio restoration could not be confirmed");
        });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await cleanupPublication();
    })();
    return closing;
  };
  server.on("connection", (socket) => {
    if (!published || stopping || clients.size >= 64) {
      socket.destroy();
      return;
    }
    clearTimeout(idle);
    clients.add(socket);
    let buffer = Buffer.alloc(0);
    let pending = 0;
    let ended = false;
    let token: string | undefined;
    let tail = Promise.resolve();
    const owner = randomUUID();
    let releasePromise: Promise<void> | undefined;
    const release = (closeId?: number) => {
      if (releasePromise) return releasePromise;
      const released = performance.now();
      ended = true;
      token = undefined;
      if (closeId === undefined) socket.destroy();
      let cleanup: Promise<void>;
      try {
        cleanup = engine.set(owner, null, true);
      } catch (error) {
        cleanup = Promise.reject(error);
      }
      releasePromise = waitForCleanup(
        Promise.allSettled([tail, cleanup]).then((results) => {
          if (results.some((result) => result.status === "rejected"))
            throw new Error("Audio focus release failed");
        }),
      )
        .then(() => {
          if (closeId !== undefined && !socket.destroyed) {
            reply(closeId);
            socket.end();
          }
        })
        .catch((error) => {
          diagnostic({
            component: "broker",
            operation: closeId === undefined ? "release" : "close",
            reason: "cleanup_failed",
            elapsedMs: focusElapsed(released),
            code: focusErrorCode(error),
          });
          warn("Background audio restoration could not be confirmed");
          socket.destroy();
        });
      return releasePromise;
    };
    releases.set(socket, release);
    socket.setTimeout(options.deadlineMs ?? FOCUS_DEADLINE_MS, () => {
      diagnostic({
        component: "broker",
        operation: "release",
        reason: "request_failed",
        timeoutMs: Math.min(600_000, options.deadlineMs ?? FOCUS_DEADLINE_MS),
      });
      void release();
    });
    socket.on("error", (error) => {
      diagnostic({
        component: "broker",
        operation: "connect",
        reason: "socket_error",
        code: focusErrorCode(error),
      });
      void release();
    });
    socket.on("end", () => {
      void release();
    });
    socket.on("close", () => {
      void release().finally(() => {
        clients.delete(socket);
        releases.delete(socket);
        scheduleIdle();
      });
    });
    const reply = (id: number) => {
      if (socket.writableLength > FOCUS_FRAME_BYTES)
        throw new Error("Focus response backpressure");
      socket.write(JSON.stringify({ v: 1, id, ok: true }) + "\n");
    };
    socket.on("data", (chunk) => {
      if (ended) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > FOCUS_FRAME_BYTES) {
        diagnostic(
          {
            component: "broker",
            operation: "protocol",
            reason: "protocol_invalid",
          },
          socket,
        );
        void release();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf(10)) !== -1) {
        const frame = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        if (++pending > 32) {
          diagnostic(
            {
              component: "broker",
              operation: "protocol",
              reason: "request_unavailable",
            },
            socket,
          );
          void release();
          return;
        }
        let message: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(frame);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error();
          message = parsed as Record<string, unknown>;
          if (
            message.v !== 1 ||
            !Number.isSafeInteger(message.id) ||
            (message.id as number) < 0 ||
            typeof message.op !== "string" ||
            !["set", "idle", "ping", "close"].includes(message.op)
          )
            throw new Error();
          const allowed =
            message.op === "set"
              ? ["v", "id", "op", "token", "settings"]
              : message.op === "idle"
                ? ["v", "id", "op", "token"]
                : ["v", "id", "op"];
          if (Object.keys(message).some((k) => !allowed.includes(k)))
            throw new Error();
          if (
            (message.op === "set" || message.op === "idle") &&
            (typeof message.token !== "string" ||
              !message.token.length ||
              message.token.length > 256)
          )
            throw new Error();
          if (
            message.op === "set" &&
            (!validFocusSettings(message.settings) ||
              message.settings.mode === "off")
          )
            throw new Error();
        } catch {
          diagnostic(
            {
              component: "broker",
              operation: "protocol",
              reason: "protocol_invalid",
            },
            socket,
          );
          void release();
          return;
        }
        if (message.op === "close") {
          void release(message.id as number);
          return;
        }
        const received = performance.now();
        tail = tail
          .then(async () => {
            if (ended) return;
            if (message.op === "set") {
              token = message.token as string;
              await engine.set(
                owner,
                message.settings as unknown as BackgroundAudioSettings,
              );
            } else if (message.op === "idle" && token === message.token) {
              token = undefined;
              await engine.set(owner, null);
            }
            if (!ended) reply(message.id as number);
          })
          .catch((error) => {
            diagnostic({
              component: "broker",
              operation: message.op as "set" | "idle" | "ping",
              reason: "request_failed",
              elapsedMs: focusElapsed(received),
              code: focusErrorCode(error),
            });
            warn("Background audio focus failed");
            void release();
          })
          .finally(() => {
            pending--;
          });
      }
    });
  });
  let bound = false;
  try {
    stagingDirectory = await mkdtemp(join(runtimeDir, "s-"));
    stagingIdentity = await filesystem.lstat(stagingDirectory);
    await privateDirectory(stagingDirectory, false, filesystem);
    stagingPath = join(stagingDirectory, "s");
    if (Buffer.byteLength(stagingPath) > 100)
      throw new Error("Focus socket path too long");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(stagingPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    bound = true;
    socketIdentity = await filesystem.lstat(stagingPath);
    if (
      !socketIdentity.isSocket() ||
      socketIdentity.isSymbolicLink() ||
      socketIdentity.uid !== process.getuid?.()
    ) {
      throw new Error("Unsafe staging socket");
    }
    await chmod(stagingPath, 0o600);
    if (
      !sameFile(
        socketIdentity,
        await checkedFocusSocket(stagingPath, filesystem),
      )
    ) {
      throw new Error("Focus socket changed during startup");
    }
    // Hard-link publication is atomic and refuses to replace an existing socket.
    await link(stagingPath, path);
    published = true;
    if (!sameFile(socketIdentity, await filesystem.lstat(path)))
      throw new Error("Focus socket changed during publication");
  } catch (error) {
    diagnostic({
      component: "broker",
      operation: "startup",
      reason: "startup_failed",
      elapsedMs: focusElapsed(started),
      code: focusErrorCode(error),
    });
    if (bound) await close();
    else {
      if (options.engine) await waitForCleanup(engine.close()).catch(() => {});
      await cleanupPublication();
    }
    throw error;
  } finally {
    startupOwnsLock = false;
    await rmdir(lock);
  }
  server.on("error", (error) => {
    diagnostic({
      component: "broker",
      operation: "connect",
      reason: "socket_error",
      code: focusErrorCode(error),
    });
    warn("Background audio broker socket failed");
    void close();
  });
  void engine.recover?.().finally(scheduleIdle);
  scheduleIdle();
  return { path, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sendDiagnostic = createFocusDiagnosticSender((event, done) => {
    if (!process.connected || !process.send)
      throw new Error("Diagnostic channel unavailable");
    process.send({ type: "paj-voice-focus-diagnostic", event }, () => done());
  });
  void runAudioFocusBroker({
    onWarning: (message) => process.stderr.write(message + "\n"),
    onDiagnostic(event) {
      if (process.connected) sendDiagnostic(event);
    },
  })
    .then((broker) => {
      for (const signal of ["SIGTERM", "SIGINT"] as const)
        process.once(signal, () => {
          void broker.close();
        });
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
