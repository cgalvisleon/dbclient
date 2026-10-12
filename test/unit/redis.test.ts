import { describe, expect, it } from 'vitest';
import { groupKeys } from '../../src/drivers/redis';
import { commandLines, parseArgs, replyTable } from '../../src/editor/redisCommands';

describe('parseArgs', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(parseArgs('SET  user:1 "hello world"')).toEqual(['SET', 'user:1', 'hello world']);
    expect(parseArgs(`HSET h f '{"a": 1}'`)).toEqual(['HSET', 'h', 'f', '{"a": 1}']);
    expect(parseArgs('SET k "line\\nnext \\"q\\""')).toEqual(['SET', 'k', 'line\nnext "q"']);
    expect(parseArgs('SET k a"b c"d')).toEqual(['SET', 'k', 'ab cd']);
  });

  it('rejects unbalanced quotes', () => {
    expect(() => parseArgs('SET k "oops')).toThrow(/double quotes/);
  });
});

describe('commandLines', () => {
  it('skips blank and comment lines and keeps offsets', () => {
    const text = '# comment\n  GET a\n\n// other\nTTL a';
    const lines = commandLines(text, 100);
    expect(lines.map((l) => l.args)).toEqual([['GET', 'a'], ['TTL', 'a']]);
    expect(text.slice(lines[0].start - 100, lines[0].end - 100)).toBe('GET a');
  });
});

describe('replyTable', () => {
  it('shapes scalars, lists and field/value replies', () => {
    expect(replyTable(['GET', 'k'], 'v')).toEqual({ columns: ['value'], rows: [['v']] });
    expect(replyTable(['LRANGE', 'l', '0', '-1'], ['a', 'b'])).toEqual({ columns: ['#', 'value'], rows: [[1, 'a'], [2, 'b']] });
    expect(replyTable(['hgetall', 'h'], ['f1', 'v1', 'f2', 'v2'])).toEqual({ columns: ['field', 'value'], rows: [['f1', 'v1'], ['f2', 'v2']] });
    expect(replyTable(['ZRANGE', 'z', '0', '-1', 'WITHSCORES'], ['m', '1'])).toEqual({ columns: ['member', 'score'], rows: [['m', '1']] });
    expect(replyTable(['XRANGE', 's', '-', '+'], [['1-0', ['a', '1']]])).toEqual({ columns: ['id', 'fields'], rows: [['1-0', '{"a":"1"}']] });
    expect(replyTable(['INFO', 'server'], '# Server\r\nredis_version:7.2.4\r\n').rows).toEqual([['Server', 'redis_version', '7.2.4']]);
  });
});

describe('groupKeys', () => {
  it('groups one level below the prefix', () => {
    const keys = ['user:1', 'user:2', 'user:2:tags', 'session', 'cfg:a:b'];
    expect(groupKeys(keys, '', ':')).toEqual({
      folders: [
        { prefix: 'cfg:', label: 'cfg:', count: 1 },
        { prefix: 'user:', label: 'user:', count: 3 },
      ],
      keys: ['session'],
    });
    expect(groupKeys(['user:1', 'user:2', 'user:2:tags'], 'user:', ':')).toEqual({
      folders: [{ prefix: 'user:2:', label: '2:', count: 1 }],
      keys: ['user:1', 'user:2'],
    });
  });
});
