/**
 * Local approval ids. The library holds a send and does not mint an id;
 * this file remembers the held send so `approve <id>` can pass
 * `approved: true` on the next check of the same message.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { addressList, type GuardSend } from 'agent-email-guard';

export interface HeldSend {
  readonly id: string;
  readonly fingerprint: string;
  readonly recipientHashes: readonly string[];
  readonly createdAt: string;
  approved: boolean;
}

interface Book {
  held: HeldSend[];
}

const chains = new Map<string, Promise<unknown>>();

function fingerprint(send: GuardSend): string {
  const body = JSON.stringify({
    to: [...addressList(send.to)].sort(),
    cc: [...addressList(send.cc)].sort(),
    bcc: [...addressList(send.bcc)].sort(),
    subject: send.subject ?? '',
    text: send.text ?? '',
    html: send.html ?? '',
  });
  return createHash('sha256').update(body).digest('hex');
}

export function recipientHashes(send: GuardSend): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const address of [...addressList(send.to), ...addressList(send.cc), ...addressList(send.bcc)]) {
    if (seen.has(address)) continue;
    seen.add(address);
    out.push(createHash('sha256').update(address).digest('hex'));
  }
  return out;
}

function readBook(path: string): Book {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Book;
    return { held: Array.isArray(parsed.held) ? parsed.held : [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { held: [] };
    throw err;
  }
}

function writeBook(path: string, book: Book): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(book)}\n`);
  renameSync(tmp, path);
}

function exclusive<T>(path: string, fn: (book: Book) => T): Promise<T> {
  const previous = chains.get(path) ?? Promise.resolve();
  const run = previous.then(() => {
    const book = readBook(path);
    const result = fn(book);
    writeBook(path, book);
    return result;
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

export interface ApprovalBook {
  hold(send: GuardSend): Promise<string>;
  isApproved(send: GuardSend): Promise<boolean>;
  consume(send: GuardSend): Promise<void>;
  approve(id: string): Promise<boolean>;
  list(): Promise<HeldSend[]>;
}

export function createApprovalBook(path: string): ApprovalBook {
  return {
    hold(send) {
      return exclusive(path, (book) => {
        const id = `ap_${randomBytes(8).toString('hex')}`;
        book.held.push({
          id,
          fingerprint: fingerprint(send),
          recipientHashes: recipientHashes(send),
          createdAt: new Date().toISOString(),
          approved: false,
        });
        return id;
      });
    },
    isApproved(send) {
      return exclusive(path, (book) => {
        const fp = fingerprint(send);
        return book.held.some((row) => row.fingerprint === fp && row.approved);
      });
    },
    consume(send) {
      return exclusive(path, (book) => {
        const fp = fingerprint(send);
        book.held = book.held.filter((row) => !(row.fingerprint === fp && row.approved));
      });
    },
    approve(id) {
      return exclusive(path, (book) => {
        const row = book.held.find((item) => item.id === id && !item.approved);
        if (!row) return false;
        row.approved = true;
        return true;
      });
    },
    list() {
      return exclusive(path, (book) => book.held.filter((row) => !row.approved));
    },
  };
}
