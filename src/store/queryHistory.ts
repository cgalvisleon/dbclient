import * as fs from 'fs';
import * as path from 'path';

// Executed statements per connection, newest last, in `<dir>/<connectionId>.jsonl`. Appending is
// one write; the file is compacted to the newest `limit` entries once it grows past 1.5× that.

export interface HistoryEntry {
  /** ISO timestamp. */
  time: string;
  connectionId: string;
  database?: string;
  /** Editor language the text runs in: `sql` or `redis`. */
  language: string;
  text: string;
  ok: boolean;
  durationMs?: number;
  /** Rows fetched or affected, when the engine reports them. */
  rows?: number;
  error?: string;
}

const MAX_TEXT = 100_000;

export class QueryHistory {
  private readonly lines = new Map<string, number>();
  private readonly listeners = new Set<(connectionId: string) => void>();

  /** `limit` = entries kept per connection; 0 disables the history. */
  constructor(
    private readonly dir: string,
    private readonly limit: () => number,
  ) {}

  onDidChange(listener: (connectionId: string) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private file(connectionId: string): string {
    return path.join(this.dir, `${connectionId}.jsonl`);
  }

  get enabled(): boolean {
    return this.limit() > 0;
  }

  add(entry: HistoryEntry): void {
    const limit = this.limit();
    if (limit <= 0 || !entry.text.trim()) {
      return;
    }
    const record = { ...entry, text: entry.text.length > MAX_TEXT ? entry.text.slice(0, MAX_TEXT) : entry.text };
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(entry.connectionId);
    // A crash may leave a partial last line; start on a fresh one so the new entry stays readable.
    fs.appendFileSync(file, (endsWithNewline(file) ? '' : '\n') + JSON.stringify(record) + '\n');
    const count = (this.lines.get(entry.connectionId) ?? this.read(entry.connectionId).length - 1) + 1;
    this.lines.set(entry.connectionId, count);
    if (count > limit * 1.5) {
      this.write(entry.connectionId, this.read(entry.connectionId).slice(-limit));
    }
    this.listeners.forEach((l) => l(entry.connectionId));
  }

  /** Newest first, at most `limit` entries. */
  list(connectionId: string): HistoryEntry[] {
    const limit = this.limit();
    return limit > 0 ? this.read(connectionId).slice(-limit).reverse() : [];
  }

  /** Every connection's history merged, newest first. */
  all(connectionIds: string[]): HistoryEntry[] {
    return connectionIds.flatMap((id) => this.list(id)).sort((a, b) => b.time.localeCompare(a.time));
  }

  clear(connectionId: string): void {
    fs.rmSync(this.file(connectionId), { force: true });
    this.lines.set(connectionId, 0);
    this.listeners.forEach((l) => l(connectionId));
  }

  private read(connectionId: string): HistoryEntry[] {
    let content: string;
    try {
      content = fs.readFileSync(this.file(connectionId), 'utf8');
    } catch {
      return [];
    }
    const entries: HistoryEntry[] = [];
    for (const line of content.split('\n')) {
      if (!line) {
        continue;
      }
      try {
        entries.push(JSON.parse(line));
      } catch {
        // A line cut by a crash: skip it.
      }
    }
    this.lines.set(connectionId, entries.length);
    return entries;
  }

  private write(connectionId: string, entries: HistoryEntry[]): void {
    const target = this.file(connectionId);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, entries.map((e) => JSON.stringify(e) + '\n').join(''));
    fs.renameSync(temp, target);
    this.lines.set(connectionId, entries.length);
  }
}

function endsWithNewline(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (!size) {
      return true;
    }
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/** Redis commands whose arguments may carry credentials; they are never recorded. */
export const SECRET_REDIS_COMMANDS = new Set(['AUTH', 'HELLO', 'ACL', 'MIGRATE', 'CONFIG']);
