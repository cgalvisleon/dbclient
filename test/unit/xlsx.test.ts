import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { buildXlsx, columnName, exactNumber, excelDate } from '../../src/export/xlsx';

// Reads the archive back with Python's zipfile (CRC-checked) to validate the container.
function unzip(file: string): Record<string, string> {
  const script = 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({n: z.read(n).decode() for n in z.namelist()}))';
  return JSON.parse(execFileSync('python3', ['-I', '-c', script, file], { encoding: 'utf8' }));
}

describe('columnName', () => {
  it('maps indexes to spreadsheet letters', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
});

describe('typed values', () => {
  it('turns numeric strings into numbers only without precision loss', () => {
    expect(exactNumber('1.50')).toBe(1.5);
    expect(exactNumber('-0012')).toBe(-12);
    expect(exactNumber('0.1')).toBe(0.1);
    expect(exactNumber('9007199254740991')).toBe(9007199254740991);
    expect(exactNumber('9007199254740993')).toBeUndefined();
    expect(exactNumber('123.45678901234567891')).toBeUndefined();
    expect(exactNumber('1e3')).toBeUndefined();
    expect(exactNumber('abc')).toBeUndefined();
  });

  it('turns ISO dates without offset into Excel serials', () => {
    expect(excelDate('1970-01-01')).toEqual({ serial: 25569, time: false });
    expect(excelDate('2026-01-02 12:00:00')).toEqual({ serial: 46024.5, time: true });
    expect(excelDate('2026-01-02T12:00:00.000Z')).toEqual({ serial: 46024.5, time: true });
    expect(excelDate('2026-01-02 12:00:00-05')).toBeUndefined();
    expect(excelDate('ayer')).toBeUndefined();
  });
});

describe('buildXlsx', () => {
  it('writes a valid package with typed cells, bold frozen header and escaped text', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbclient-xlsx-')), 'r.xlsx');
    fs.writeFileSync(
      file,
      buildXlsx({
        name: 'select * from [x]',
        columns: ['id', 'name', 'ok', 'note'],
        rows: [
          [1, 'Ana & <b>', true, null],
          [2.5, 'línea\nnueva\u0001', false, '9007199254740993'],
        ],
      }),
    );
    const parts = unzip(file);
    expect(Object.keys(parts).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    const sheet = parts['xl/worksheets/sheet1.xml'];
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">id</t></is></c>');
    expect(sheet).toContain('<c r="A2"><v>1</v></c>');
    expect(sheet).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">Ana &amp; &lt;b&gt;</t></is></c>');
    expect(sheet).toContain('<c r="C2" t="b"><v>1</v></c>');
    expect(sheet).not.toContain('r="D2"');
    expect(sheet).toContain('<c r="A3"><v>2.5</v></c>');
    expect(sheet).toContain('línea\nnueva</t>');
    // Big integers arrive as strings and stay text, so no precision is lost.
    expect(sheet).toContain('<t xml:space="preserve">9007199254740993</t>');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<dimension ref="A1:D3"/>');
    expect(parts['xl/workbook.xml']).toContain('<sheet name="select   from  x" sheetId="1" r:id="rId1"/>');
  });

  it('writes numeric and date columns as numbers and dates', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbclient-xlsx-')), 't.xlsx');
    fs.writeFileSync(
      file,
      buildXlsx({
        name: 't',
        columns: ['amount', 'big', 'day', 'at', 'label'],
        types: ['numeric', 'int8', 'date', 'timestamp', 'text'],
        rows: [['1.50', '9007199254740993', '2026-01-02', '2026-01-02 12:00:00', '42']],
      }),
    );
    const sheet = unzip(file)['xl/worksheets/sheet1.xml'];
    expect(sheet).toContain('<c r="A2"><v>1.5</v></c>');
    expect(sheet).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">9007199254740993</t>');
    expect(sheet).toContain('<c r="C2" s="2"><v>46024</v></c>');
    expect(sheet).toContain('<c r="D2" s="3"><v>46024.5</v></c>');
    expect(sheet).toContain('<c r="E2" t="inlineStr"><is><t xml:space="preserve">42</t>');
  });

  it('handles results with no rows', () => {
    const parts = buildXlsx({ name: 'empty', columns: ['a'], rows: [] });
    expect(parts.length).toBeGreaterThan(500);
  });
});
