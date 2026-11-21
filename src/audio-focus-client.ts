import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { spawn as spawnProcess } from "node:child_process";
import type { SpawnOptions, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { BackgroundAudioSettings } from "./audio-focus-types.ts";
import {
  focusRuntimeDirectory,
  focusSocketPath,
  verifyFocusSocket,
  validFocusSettings,
  FOCUS_FRAME_BYTES,
  FOCUS_HEARTBEAT_MS,
} from "./audio-focus-broker.ts";
import type { FocusFileSystem } from "./audio-focus-broker.ts";
import {
  assertDefaultFocusEnvironment,
  focusSpawnEnvironment,
} from "./audio-focus-environment.ts";
import {
  safeFocusDiagnostic,
  focusErrorCode,
  focusElapsed,
  focusSignal,
  decodeFocusDiagnostic,
  isFocusDiagnosticMessage,
} from "./audio-focus-diagnostics.ts";
import type { FocusDiagnostic } from "./audio-focus-diagnostics.ts";

export interface FocusClientSnapshot {
  state: "connecting" | "connected" | "idle" | "failed" | "closing" | "closed";
  leasePresent: boolean;
  terminal:
    | (FocusDiagnostic & { ageMs: number })
    | { reason: "unknown"; ageMs: number }
    | null;
}

export interface AudioFocusClient {
  playing(token: string): void;
  idle(token: string): void;
  close(): Promise<void>;
  snapshot?(): FocusClientSnapshot;
}

export interface AudioFocusClientOptions {
  now?: () => number;
  env?: Record<string, string | undefined>;
  onWarning?: (message: string) => void;
  onDiagnostic?: (event: FocusDiagnostic) => void;
  runtimeDir?: string;
  filesystem?: FocusFileSystem;
  connect?: (path: string) => Socket;
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
}

export function startAudioFocus(
  settings: BackgroundAudioSettings,
  options: AudioFocusClientOptions = {},
): AudioFocusClient {
  if (!validFocusSettings(settings) || settings.mode === "off") {
    let closed = false;
    return {
      playing(_token: string) {},
      idle(_token: string) {},
      async close() {
        closed = true;
      },
      snapshot: () => ({
        state: closed ? "closed" : "idle",
        leasePresent: false,
        terminal: null,
      }),
    };
  }
  const policy: BackgroundAudioSettings = {
    ...settings,
    apps: [...settings.apps],
    excludeApps: [...settings.excludeApps],
  };
  let current: string | undefined;
  let socket: Socket | undefined;
  let opening: Promise<void> | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let idleClose: NodeJS.Timeout | undefined;
  let revision = 0;
  let closed = false;
  let closeSettled = false;
  let failed = false;
  let warned = false;
  let nextId = 0;
  let buffer = Buffer.alloc(0);
  let closePromise: Promise<void> | undefined;
  const pending = new Map<
    number,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
      operation: "set" | "idle" | "ping" | "close";
      started: number;
    }
  >();
  const diagnostic = (event: FocusDiagnostic) => {
    const safe = safeFocusDiagnostic(event);
    if (safe) {
      try {
        options.onDiagnostic?.(safe);
      } catch {}
    }
  };
  const warning = () => {
    if (!warned) {
      warned = true;
      try {
        options.onWarning?.(
          "Background audio focus unavailable; restoration could not be confirmed",
        );
      } catch {}
    }
  };
  const now = options.now ?? (() => performance.now());
  let terminal:
    { event: FocusDiagnostic | { reason: "unknown" }; at: number } | undefined;
  const snapshot = (): FocusClientSnapshot => ({
    state: closed
      ? closeSettled
        ? "closed"
        : "closing"
      : failed
        ? "failed"
        : socket && current
          ? "connected"
          : opening
            ? "connecting"
            : "idle",
    leasePresent: current !== undefined,
    terminal: terminal
      ? {
          ...terminal.event,
          ageMs: Math.max(
            0,
            Math.min(2_147_483_647, Math.round(now() - terminal.at) || 0),
          ),
        }
      : null,
  });
  const issues = new WeakMap<object, FocusDiagnostic>();
  const issue = (error: unknown, event: FocusDiagnostic) => {
    diagnostic(event);
    if (error && typeof error === "object") issues.set(error, event);
  };
  const fail = (event?: unknown) => {
    if (!failed && !closed)
      terminal = {
        event: safeFocusDiagnostic(event) ??
          (event && typeof event === "object"
            ? issues.get(event)
            : undefined) ?? { reason: "unknown" },
        at: now(),
      };
    failed = true;
    clearInterval(heartbeat);
    clearTimeout(idleClose);
    idleClose = undefined;
    socket?.destroy();
    socket = undefined;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Background audio focus connection lost"));
    }
    pending.clear();
    if (!closed) warning();
  };
  const send = (
    op: "set" | "idle" | "ping" | "close",
    token?: string,
  ): Promise<void> => {
    if (
      !socket ||
      socket.destroyed ||
      pending.size >= 16 ||
      socket.writableLength > FOCUS_FRAME_BYTES
    ) {
      const error = new Error("Background audio focus connection unavailable");
      issue(error, {
        component: "client",
        operation: op,
        reason: "request_unavailable",
      });
      return Promise.reject(error);
    }
    const id = ++nextId;
    const message = {
      v: 1,
      id,
      op,
      ...(token === undefined ? {} : { token }),
      ...(op === "set" ? { settings: policy } : {}),
    };
    return new Promise<void>((resolve, reject) => {
      const started = performance.now();
      const timer = setTimeout(() => {
        const event: FocusDiagnostic = {
          component: "client",
          operation: op,
          reason: "ack_timeout",
          elapsedMs: focusElapsed(started),
          timeoutMs: 2500,
        };
        diagnostic(event);
        fail(event);
        warning();
      }, 2500);
      timer.unref();
      pending.set(id, { resolve, reject, timer, operation: op, started });
      try {
        socket!.write(JSON.stringify(message) + "\n");
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        const rejection = new Error(
          "Background audio focus request write failed",
        );
        issue(rejection, {
          component: "client",
          operation: op,
          reason: "request_failed",
          elapsedMs: focusElapsed(started),
          code: focusErrorCode(error),
        });
        reject(rejection);
      }
    });
  };
  const attach = (connected: Socket) => {
    socket = connected;
    buffer = Buffer.alloc(0);
    socket.on("error", (error) => {
      if (socket !== connected) return;
      const event: FocusDiagnostic = {
        component: "client",
        operation: "connect",
        reason: "socket_error",
        code: focusErrorCode(error),
      };
      if (!failed && !closed) diagnostic(event);
      fail(event);
    });
    socket.on("close", () => {
      if (socket !== connected) return;
      const request = pending.values().next().value;
      const event: FocusDiagnostic = {
        component: "client",
        operation: request?.operation ?? "idle",
        reason: "socket_closed",
        ...(request ? { elapsedMs: focusElapsed(request.started) } : {}),
      };
      if (!failed && !closed) diagnostic(event);
      fail(event);
    });
    socket.on("data", (chunk) => {
      if (socket !== connected) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > FOCUS_FRAME_BYTES) {
        const event: FocusDiagnostic = {
          component: "client",
          operation: "protocol",
          reason: "protocol_invalid",
        };
        diagnostic(event);
        fail(event);
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf(10)) !== -1) {
        const frame = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        try {
          const reply = JSON.parse(frame) as {
            v?: unknown;
            id?: unknown;
            ok?: unknown;
            warning?: unknown;
          };
          if (
            reply.v === 1 &&
            typeof reply.warning === "string" &&
            reply.warning.length <= 256 &&
            Object.keys(reply).every((key) => ["v", "warning"].includes(key))
          ) {
            if (isFocusDiagnosticMessage(reply.warning)) {
              const event = decodeFocusDiagnostic(reply.warning);
              if (event) diagnostic(event);
              else
                diagnostic({
                  component: "client",
                  operation: "protocol",
                  reason: "protocol_invalid",
                });
            } else {
              try {
                options.onWarning?.(reply.warning);
              } catch {}
            }
            continue;
          }
          if (
            reply.v !== 1 ||
            !Number.isSafeInteger(reply.id) ||
            reply.ok !== true ||
            Object.keys(reply).some((key) => !["v", "id", "ok"].includes(key))
          )
            throw new Error();
          const request = pending.get(reply.id as number);
          if (!request) throw new Error();
          clearTimeout(request.timer);
          pending.delete(reply.id as number);
          if (request.operation !== "ping")
            diagnostic({
              component: "client",
              operation: request.operation,
              reason: "acknowledged",
              elapsedMs: focusElapsed(request.started),
            });
          request.resolve();
        } catch {
          const event: FocusDiagnostic = {
            component: "client",
            operation: "protocol",
            reason: "protocol_invalid",
          };
          diagnostic(event);
          fail(event);
          return;
        }
      }
    });
    heartbeat = setInterval(() => {
      void send("ping").catch(fail);
    }, FOCUS_HEARTBEAT_MS);
    heartbeat.unref();
  };
  const connect = async (path: string): Promise<Socket> => {
    const started = performance.now();
    try {
      await verifyFocusSocket(path, options.filesystem);
    } catch (error) {
      issue(error, {
        component: "client",
        operation: "connect",
        reason: "connect_failed",
        elapsedMs: focusElapsed(started),
        code: focusErrorCode(error),
      });
      throw error;
    }
    return new Promise((resolve, reject) => {
      let connection: Socket;
      try {
        connection = (options.connect ?? createConnection)(path);
      } catch (error) {
        issue(error, {
          component: "client",
          operation: "connect",
          reason: "connect_failed",
          elapsedMs: focusElapsed(started),
          code: focusErrorCode(error),
        });
        reject(error);
        return;
      }
      const timer = setTimeout(() => {
        const error = new Error("Focus connect timed out");
        issue(error, {
          component: "client",
          operation: "connect",
          reason: "connect_timeout",
          elapsedMs: focusElapsed(started),
          timeoutMs: 400,
        });
        connection.destroy();
        reject(error);
      }, 400);
      connection.once("error", (error) => {
        clearTimeout(timer);
        issue(error, {
          component: "client",
          operation: "connect",
          reason: "connect_failed",
          elapsedMs: focusElapsed(started),
          code: focusErrorCode(error),
        });
        reject(error);
      });
      connection.once("connect", () => {
        clearTimeout(timer);
        diagnostic({
          component: "client",
          operation: "connect",
          reason: "connected",
          elapsedMs: focusElapsed(started),
        });
        resolve(connection);
      });
    });
  };
  const open = async () => {
    const env = { ...(options.env ?? process.env) };
    try {
      assertDefaultFocusEnvironment(env);
    } catch (error) {
      issue(error, {
        component: "client",
        operation: "environment",
        reason: "environment_rejected",
      });
      throw error;
    }
    let path: string;
    const started = performance.now();
    try {
      path = await focusSocketPath(
        options.runtimeDir ??
          (await focusRuntimeDirectory(env, options.filesystem)),
        options.filesystem,
      );
    } catch (error) {
      issue(error, {
        component: "client",
        operation: "runtime",
        reason: "runtime_rejected",
        elapsedMs: focusElapsed(started),
        code: focusErrorCode(error),
      });
      throw error;
    }
    if (closed || !current) return;
    let connected: Socket;
    try {
      connected = await connect(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
      if (closed || !current) return;
      const safeEnv = focusSpawnEnvironment(env);
      const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
      let child: ChildProcess;
      try {
        child = (options.spawn ?? spawnProcess)(
          process.execPath,
          [
            fileURLToPath(
              new URL(`./audio-focus-broker.${extension}`, import.meta.url),
            ),
          ],
          {
            env: safeEnv,
            detached: true,
            stdio: ["ignore", "ignore", "ignore", "ipc"],
          },
        );
      } catch (error) {
        issue(error, {
          component: "client",
          operation: "spawn",
          reason: "spawn_failed",
          code: focusErrorCode(error),
        });
        throw error;
      }
      diagnostic({
        component: "client",
        operation: "spawn",
        reason: "spawned",
      });
      child.on("error", (error) => {
        diagnostic({
          component: "client",
          operation: "spawn",
          reason: "spawn_failed",
          code: focusErrorCode(error),
        });
        if (!closed) warning();
      });
      child.on("message", (message) => {
        if (
          !message ||
          typeof message !== "object" ||
          !("type" in message) ||
          message.type !== "paj-voice-focus-diagnostic" ||
          !("event" in message)
        )
          return;
        const event = safeFocusDiagnostic(message.event);
        if (event) diagnostic(event);
      });
      child.on("exit", (code, signal) =>
        diagnostic({
          component: "broker",
          operation: "startup",
          reason: "broker_exit",
          ...(typeof code === "number" && code >= 0 && code <= 255
            ? { exitCode: code }
            : {}),
          ...(signal ? { signal: focusSignal(signal) } : {}),
          elapsedMs: focusElapsed(started),
        }),
      );
      child.channel?.unref();
      child.unref();
      let lastError: unknown;
      let result: Socket | undefined;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (closed || !current) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          result = await connect(path);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
          lastError = error;
        }
      }
      if (!result) throw lastError ?? new Error("Focus broker did not start");
      connected = result;
    }
    if (closed || !current) {
      connected.destroy();
      return;
    }
    attach(connected);
    await send("set", current);
  };
  const ensureOpen = () => {
    if (opening || socket || closed || failed || !current) return;
    opening = open()
      .catch((error) => {
        fail(error);
      })
      .finally(() => {
        opening = undefined;
        if (current && !socket && !closed && !failed) ensureOpen();
      });
  };
  const playing = (token: string) => {
    if (closed || failed || !token || token.length > 256 || current === token)
      return;
    try {
      assertDefaultFocusEnvironment(options.env ?? process.env);
    } catch {
      const event: FocusDiagnostic = {
        component: "client",
        operation: "environment",
        reason: "environment_rejected",
      };
      diagnostic(event);
      fail(event);
      return;
    }
    current = token;
    revision++;
    clearTimeout(idleClose);
    idleClose = undefined;
    if (socket) {
      if (!heartbeat) {
        heartbeat = setInterval(() => {
          void send("ping").catch(fail);
        }, FOCUS_HEARTBEAT_MS);
        heartbeat.unref();
      }
      void send("set", token).catch(fail);
    } else ensureOpen();
  };
  const idle = (token: string) => {
    if (closed || token !== current) return;
    current = undefined;
    const idleRevision = ++revision;
    clearInterval(heartbeat);
    heartbeat = undefined;
    if (socket) {
      const connection = socket;
      void send("idle", token)
        .then(() => {
          if (
            !closed &&
            !current &&
            revision === idleRevision &&
            socket === connection
          ) {
            clearTimeout(idleClose);
            idleClose = setTimeout(() => {
              idleClose = undefined;
              if (
                !closed &&
                !current &&
                revision === idleRevision &&
                socket === connection
              ) {
                socket = undefined;
                connection.end();
              }
            }, 2500);
            idleClose.unref();
          }
        })
        .catch((error) => {
          if (socket === connection) fail(error);
        });
    }
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    current = undefined;
    clearInterval(heartbeat);
    clearTimeout(idleClose);
    idleClose = undefined;
    closePromise = (async () => {
      if (failed) warning();
      if (socket && !socket.destroyed) {
        const started = performance.now();
        try {
          await send("close");
        } catch (error) {
          const event: FocusDiagnostic = {
            component: "client",
            operation: "close",
            reason: "cleanup_failed",
            elapsedMs: focusElapsed(started),
            code: focusErrorCode(error),
          };
          diagnostic(event);
          terminal ??= { event, at: now() };
          warning();
        }
      }
      fail();
      await opening;
      closeSettled = true;
    })();
    return closePromise;
  };
  return { playing, idle, close, snapshot };
}
