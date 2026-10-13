import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { HistoryEntry, QueryHistory } from '../../src/store/queryHistory';

const entry = (text: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
  time: new Date().toISOString(),
  connectionId: 'a',
  language: 'sql',
  text,
  ok: true,
  ...extra,
});

describe('QueryHistory', () => {
  const make = (limit = 500) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbclient-history-'));
    let current = limit;
    return { dir, history: new QueryHistory(dir, () => current), setLimit: (n: number) => (current = n) };
  };

  it('keeps entries per connection, newest first, and notifies', () => {
    const { history } = make();
    const changed: string[] = [];
    history.onDidChange((id) => changed.push(id));
    history.add(entry('select 1', { time: '2026-01-01T00:00:00.000Z', database: 'db1', rows: 1, durationMs: 3 }));
    history.add(entry('select 2', { time: '2026-01-01T00:00:01.000Z' }));
    history.add(entry('bad', { connectionId: 'b', time: '2026-01-01T00:00:02.000Z', ok: false, error: 'syntax' }));
    history.add(entry('   '));
    expect(history.list('a').map((e) => e.text)).toEqual(['select 2', 'select 1']);
    expect(history.list('a')[1]).toMatchObject({ database: 'db1', rows: 1, durationMs: 3 });
    expect(history.list('b')[0]).toMatchObject({ ok: false, error: 'syntax' });
    expect(history.all(['a', 'b']).map((e) => e.text)).toEqual(['bad', 'select 2', 'select 1']);
    expect(changed).toEqual(['a', 'a', 'b']);
  });

  it('caps each connection at the limit and compacts the file', () => {
    const { dir, history } = make(10);
    for (let i = 0; i < 40; i++) {
      history.add(entry(`select ${i}`));
    }
    const list = history.list('a');
    expect(list).toHaveLength(10);
    expect(list[0].text).toBe('select 39');
    expect(list[9].text).toBe('select 30');
    const lines = fs.readFileSync(path.join(dir, 'a.jsonl'), 'utf8').trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(15);
  });

  it('survives a truncated line and a fresh instance reads the file', () => {
    const { dir, history } = make();
    history.add(entry('select 1'));
    fs.appendFileSync(path.join(dir, 'a.jsonl'), '{"time":"2026');
    history.add(entry('select 2'));
    expect(new QueryHistory(dir, () => 500).list('a').map((e) => e.text)).toEqual(['select 2', 'select 1']);
  });

  it('records nothing when the limit is 0 and clears a connection', () => {
    const { history, setLimit } = make();
    history.add(entry('select 1'));
    setLimit(0);
    expect(history.enabled).toBe(false);
    history.add(entry('select 2'));
    expect(history.list('a')).toEqual([]);
    setLimit(500);
    expect(history.list('a').map((e) => e.text)).toEqual(['select 1']);
    history.clear('a');
    expect(history.list('a')).toEqual([]);
    history.clear('missing');
  });
});
