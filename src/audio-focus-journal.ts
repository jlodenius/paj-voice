import { constants, type Stats } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isFocusMetadataLabel, type FocusStream } from "./audio-focus-types.ts";

export interface FocusRecoveryRecord {
  generation: string;
  epoch: string;
  stream: FocusStream;
  baseline: number[];
  candidate?: number[];
}

const FILE = "recovery-v1.json";
const STAGING = "recovery-v1.tmp";
const VERSION = 1;
const MAX_RECORDS = 128;
const MAX_BYTES = 1024 * 1024;

function fields(value: unknown, required: string[], optional: string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const entry = value as Record<string, unknown>;
  if (
    required.every((key) => Object.hasOwn(entry, key)) &&
    Object.keys(entry).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  )
    return entry;
}

const printable = (value: unknown) =>
  typeof value === "string" && /^[\x20-\x7e]{0,256}$/u.test(value);
const token = (value: unknown) => printable(value) && value !== "";
const objectId = (value: unknown) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 0xffffffff;
const vector = (value: unknown, channels?: number): value is number[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 64 &&
  (channels === undefined || value.length === channels) &&
  Array.from(value).every(
    (volume) =>
      typeof volume === "number" &&
      Number.isFinite(volume) &&
      volume >= 0 &&
      volume <= 4,
  );

function validRecord(value: unknown): value is FocusRecoveryRecord {
  const record = fields(
    value,
    ["generation", "epoch", "stream", "baseline"],
    ["candidate"],
  );
  if (!record || !token(record.generation) || !token(record.epoch))
    return false;
  const stream = fields(
    record.stream,
    ["serial", "id", "appId", "binary", "role", "name", "volumes", "muted"],
    ["associatedClient"],
  );
  if (
    !stream ||
    !token(stream.serial) ||
    !objectId(stream.id) ||
    ![stream.appId, stream.binary, stream.role].every(printable) ||
    !isFocusMetadataLabel(stream.name) ||
    !stream.name ||
    typeof stream.muted !== "boolean" ||
    !vector(stream.volumes) ||
    !vector(record.baseline, stream.volumes.length) ||
    (record.candidate !== undefined &&
      !vector(record.candidate, stream.volumes.length))
  )
    return false;
  if (stream.associatedClient === undefined) return true;
  const client = fields(stream.associatedClient, [
    "id",
    "serial",
    "source",
    "appId",
    "binary",
    "role",
    "name",
    "applicationName",
  ]);
  return (
    !!client &&
    objectId(client.id) &&
    client.id !== stream.id &&
    token(client.serial) &&
    client.serial !== stream.serial &&
    (client.source === "node" || client.source === "client") &&
    [client.appId, client.binary, client.role].every(printable) &&
    isFocusMetadataLabel(client.name) &&
    isFocusMetadataLabel(client.applicationName)
  );
}

function checkedRecords(value: unknown): FocusRecoveryRecord[] {
  const serials = new Set<string>();
  if (!Array.isArray(value) || value.length > MAX_RECORDS)
    throw new Error("Invalid focus recovery records");
  for (const record of value) {
    if (!validRecord(record)) throw new Error("Invalid focus recovery record");
    const serial = JSON.stringify([record.generation, record.stream.serial]);
    if (serials.has(serial)) throw new Error("Duplicate focus recovery record");
    serials.add(serial);
  }
  return value;
}

const sameInode = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

async function checkedDirectory(path: string): Promise<Stats> {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    /[\u0000-\u001f\u007f]/u.test(path)
  )
    throw new Error("Invalid focus recovery directory path");
  const ancestors = [];
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    ancestors.push(parent);
    if (parent === dirname(parent)) break;
  }
  const uid = process.getuid?.();
  for (const parent of ancestors.reverse()) {
    const stat = await lstat(parent);
    if (
      !stat.isDirectory() ||
      (stat.uid !== uid && stat.uid !== 0) ||
      ((stat.mode & 0o022) !== 0 && !(stat.mode & 0o1000))
    )
      throw new Error("Unsafe focus recovery directory parent");
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700)
    throw new Error("Unsafe focus recovery directory");
  return stat;
}

function checkedFile(stat: Stats, staging = false) {
  // A killed writer may have created the staging file under a restrictive umask.
  const mode = stat.mode & 0o7777;
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    stat.nlink !== 1 ||
    (staging ? (mode & ~0o600) !== 0 : mode !== 0o600)
  )
    throw new Error("Unsafe focus recovery file");
}

async function existing(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function readJournal(path: string): Promise<FocusRecoveryRecord[]> {
  const expected = await existing(path);
  if (!expected) return [];
  checkedFile(expected);
  const fd = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await fd.stat();
    checkedFile(stat);
    if (!sameInode(stat, expected))
      throw new Error("Focus recovery file changed");
    if (stat.size > MAX_BYTES)
      throw new Error("Focus recovery file is too large");
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await fd.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error("Focus recovery file changed");
    return decode(buffer.subarray(0, offset));
  } finally {
    await fd.close();
  }
}

function decode(buffer: Buffer) {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer),
    );
  } catch {
    throw new Error("Malformed focus recovery file");
  }
  const document = fields(value, ["version", "records"]);
  if (!document || document.version !== VERSION)
    throw new Error("Invalid focus recovery format");
  return checkedRecords(document.records);
}

/** The caller must hold broker ownership and supply its existing private XDG runtime directory. */
export async function openFocusJournal(directory: string): Promise<{
  load(): FocusRecoveryRecord[];
  save(records: FocusRecoveryRecord[]): Promise<void>;
}> {
  const identity = await checkedDirectory(directory);
  const path = join(directory, FILE);
  const staging = join(directory, STAGING);
  let records = await readJournal(path);
  const orphan = await existing(staging);
  if (orphan) checkedFile(orphan, true);
  let tail = Promise.resolve();

  async function replace(encoded: Buffer) {
    if (!sameInode(identity, await checkedDirectory(directory)))
      throw new Error("Focus recovery directory changed");
    const dir = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let created = false;
    try {
      if (!sameInode(identity, await dir.stat()))
        throw new Error("Focus recovery directory changed");
      await readJournal(path);
      const orphan = await existing(staging);
      if (orphan) {
        checkedFile(orphan, true);
        await unlink(staging);
      }
      const temp = await open(
        staging,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      try {
        await temp.chmod(0o600);
        await temp.writeFile(encoded);
        await temp.sync();
      } finally {
        await temp.close();
      }
      await rename(staging, path);
      created = false;
      await dir.sync();
    } finally {
      if (created) await unlink(staging).catch(() => {});
      await dir.close();
    }
  }

  return {
    load: () => structuredClone(records),
    async save(next) {
      const checked = checkedRecords(next);
      const encoded = Buffer.from(
        JSON.stringify({ version: VERSION, records: checked }),
      );
      if (encoded.length > MAX_BYTES)
        throw new Error("Focus recovery file is too large");
      const snapshot = decode(encoded);
      const write = tail.then(async () => {
        await replace(encoded);
        records = snapshot;
      });
      tail = write.catch(() => {});
      await write;
    },
  };
}
