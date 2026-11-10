/**
 * File-backed GuardStore. One JSON file, one mutex across the read and the
 * write, so incrementWithCeiling and windowAdd are each one step inside this
 * process and across processes that share the file. The method bodies match
 * MemoryStore, which is what the guard's vectors were generated against.
 * The send log is a sidecar so a budget counter does not rewrite every body.
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SEND_LOG_CAP, type CounterResult, type GuardStore, type SendRecord, type WindowResult } from 'agent-email-guard';

interface CounterEntry {
  value: number;
  expiresAt: number | null;
}

interface Disk {
  counters: Record<string, CounterEntry>;
  windows: Record<string, Record<string, number>>;
  state: Record<string, string>;
  logCounts: Record<string, number>;
  logOldest: Record<string, number>;
}

const chains = new Map<string, Promise<unknown>>();

function emptyDisk(): Disk {
  return { counters: {}, windows: {}, state: {}, logCounts: {}, logOldest: {} };
}

function readDisk(path: string): Disk {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyDisk();
    throw err;
  }
  if (text.trim().length === 0) return emptyDisk();
  const parsed = JSON.parse(text) as Partial<Disk>;
  return {
    counters: parsed.counters ?? {},
    windows: parsed.windows ?? {},
    state: parsed.state ?? {},
    logCounts: parsed.logCounts ?? {},
    logOldest: parsed.logOldest ?? {},
  };
}

function writeDisk(path: string, data: Disk): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`);
  renameSync(tmp, path);
}

function acquire(lockPath: string): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > 10_000) unlinkSync(lockPath);
    } catch {
      // The holder removed it between the stat and the unlink.
    }
    if (Date.now() > deadline) throw new Error(`Could not lock ${lockPath}.`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function sendsPath(path: string): string {
  return `${path}.sends`;
}

interface SendLine {
  log: string;
  record: SendRecord;
}

function readSends(path: string): SendLine[] {
  let text: string;
  try {
    text = readFileSync(sendsPath(path), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const rows: SendLine[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    rows.push(JSON.parse(line) as SendLine);
  }
  return rows;
}

function writeSends(path: string, rows: readonly SendLine[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const file = sendsPath(path);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''));
  renameSync(tmp, file);
}

function exclusive<T>(path: string, fn: (data: Disk) => T): Promise<T> {
  const previous = chains.get(path) ?? Promise.resolve();
  const run = previous.then(() => {
    const lockPath = `${path}.lock`;
    acquire(lockPath);
    try {
      const data = readDisk(path);
      const result = fn(data);
      writeDisk(path, data);
      return result;
    } finally {
      releaseLock(lockPath);
    }
  });
  chains.set(
    path,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export class FileStore implements GuardStore {
  constructor(private readonly path: string) {}

  incrementWithCeiling(name: string, amount: number, ceiling: number | null, expiresAt: number | null): Promise<CounterResult> {
    return exclusive(this.path, (data) => {
      const current = data.counters[name]?.value ?? 0;
      if (ceiling !== null && current + amount > ceiling) return { ok: false, value: current };
      data.counters[name] = { value: current + amount, expiresAt };
      return { ok: true, value: current + amount };
    });
  }

  decrement(name: string, amount: number): Promise<void> {
    return exclusive(this.path, (data) => {
      const entry = data.counters[name];
      if (!entry) return;
      entry.value = Math.max(0, entry.value - amount);
    });
  }

  getCounter(name: string): Promise<number> {
    return exclusive(this.path, (data) => data.counters[name]?.value ?? 0);
  }

  windowAdd(name: string, member: string, at: number, windowMs: number, ceiling: number): Promise<WindowResult> {
    return exclusive(this.path, (data) => {
      const win = data.windows[name] ?? {};
      for (const [memberId, memberAt] of Object.entries(win)) {
        if (at - memberAt >= windowMs) delete win[memberId];
      }
      data.windows[name] = win;
      let oldest: number | null = null;
      for (const memberAt of Object.values(win)) {
        if (oldest === null || memberAt < oldest) oldest = memberAt;
      }
      const count = Object.keys(win).length;
      if (count >= ceiling) return { ok: false, count, oldestAt: oldest };
      win[member] = at;
      return { ok: true, count: count + 1, oldestAt: oldest ?? at };
    });
  }

  windowRemove(name: string, member: string): Promise<void> {
    return exclusive(this.path, (data) => {
      const win = data.windows[name];
      if (win) delete win[member];
    });
  }

  appendSend(log: string, record: SendRecord, keepMs: number): Promise<void> {
    return exclusive(this.path, (data) => {
      const count = data.logCounts[log] ?? 0;
      const oldest = data.logOldest[log];
      const agedOut = oldest !== undefined && record.at - oldest > keepMs;
      if (!agedOut && count + 1 <= SEND_LOG_CAP) {
        mkdirSync(dirname(this.path), { recursive: true });
        appendFileSync(sendsPath(this.path), `${JSON.stringify({ log, record })}\n`);
        data.logCounts[log] = count + 1;
        if (oldest === undefined) data.logOldest[log] = record.at;
        return;
      }
      const rows = readSends(this.path).filter((row) => row.log !== log);
      const list = readSends(this.path)
        .filter((row) => row.log === log)
        .map((row) => row.record);
      list.push(record);
      let drop = 0;
      while (drop < list.length && record.at - (list[drop] as SendRecord).at > keepMs) drop += 1;
      if (list.length - drop > SEND_LOG_CAP) drop = list.length - SEND_LOG_CAP;
      const kept = list.slice(drop);
      writeSends(this.path, [...rows, ...kept.map((item) => ({ log, record: item }))]);
      data.logCounts[log] = kept.length;
      const first = kept[0];
      if (first) data.logOldest[log] = first.at;
      else delete data.logOldest[log];
    });
  }

  recentSends(log: string, since: number): Promise<SendRecord[]> {
    return exclusive(this.path, () =>
      readSends(this.path)
        .filter((row) => row.log === log && row.record.at >= since)
        .map((row) => row.record),
    );
  }

  getState(name: string): Promise<string | null> {
    return exclusive(this.path, (data) => data.state[name] ?? null);
  }

  setState(name: string, value: string | null): Promise<void> {
    return exclusive(this.path, (data) => {
      if (value === null) delete data.state[name];
      else data.state[name] = value;
    });
  }
}
