import * as zlib from 'zlib';

// Minimal .xlsx writer (Office Open XML spreadsheet): one sheet, bold frozen header, numbers and
// booleans typed, everything else as inline strings. No dependencies; no vscode imports.

export type XlsxCell = string | number | boolean | null;

export interface XlsxSheet {
  name: string;
  columns: string[];
  /** Engine type per column (`numeric`, `date`, …); used to write numbers and dates as such. */
  types?: (string | undefined)[];
  rows: XlsxCell[][];
}

const NUMERIC_TYPE = /^(numeric|decimal|newdecimal|int\d*|integer|smallint|tinyint|mediumint|bigint|longlong|long|short|money|number|float\d*|double|real|binary_double|binary_float)\b/i;
const TEMPORAL_TYPE = /^(date|datetime\d*|smalldatetime|timestamp|timestamptz|newdate)\b/i;

const STYLE_HEADER = 1;
const STYLE_DATE = 2;
const STYLE_DATETIME = 3;

/** A numeric string as a number, only when the number prints back the same (no precision lost). */
export function exactNumber(text: string): number | undefined {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) {
    return undefined;
  }
  const fraction = (m[3] ?? '').replace(/0+$/, '');
  const integer = m[2].replace(/^0+(?=\d)/, '');
  const canonical = `${m[1]}${integer}${fraction ? `.${fraction}` : ''}`;
  const value = Number(canonical);
  return Number.isFinite(value) && String(value) === canonical.replace(/^-0$/, '0') ? value : undefined;
}

/** Excel serial date for `YYYY-MM-DD` or `YYYY-MM-DD[ T]hh:mm:ss[.fff][Z]`; undefined for anything else (offsets stay text). */
export function excelDate(text: string): { serial: number; time: boolean } | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|\+00(?::?00)?)?)?$/.exec(text.trim());
  if (!m) {
    return undefined;
  }
  const [y, mo, d, h = '0', mi = '0', s = '0', frac = ''] = m.slice(1);
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), frac ? Math.round(Number(frac) * 1000) : 0);
  if (Number.isNaN(ms)) {
    return undefined;
  }
  return { serial: ms / 86400000 + 25569, time: m[4] !== undefined };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A ZIP archive with deflated entries (what .xlsx files are). */
function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = zlib.deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt32LE(0, 10); // time/date
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, compressed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(0, 12);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += header.length + name.length + compressed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

// XML 1.0 forbids most control characters even when escaped.
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

function escapeXml(text: string): string {
  return text.replace(INVALID_XML, '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
}

/** A, B, …, Z, AA, AB… */
export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

/** Excel's limits: 31 characters, none of []:*?/\ in sheet names. */
function sheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Result';
}

const MAX_CELL = 32767;

function cell(ref: string, value: XlsxCell, style = 0, type?: string): string {
  if (typeof value === 'string' && type && !style) {
    if (NUMERIC_TYPE.test(type)) {
      const n = exactNumber(value);
      if (n !== undefined) {
        value = n;
      }
    } else if (TEMPORAL_TYPE.test(type)) {
      const date = excelDate(value);
      if (date) {
        return `<c r="${ref}" s="${date.time ? STYLE_DATETIME : STYLE_DATE}"><v>${date.serial}</v></c>`;
      }
    }
  }
  const s = style ? ` s="${style}"` : '';
  if (value === null || value === undefined || value === '') {
    return style ? `<c r="${ref}"${s}/>` : '';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  const text = String(value).slice(0, MAX_CELL);
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

export function buildXlsx(sheet: XlsxSheet): Buffer {
  const widths = sheet.columns.map((c, i) => {
    let max = c.length;
    for (const row of sheet.rows.slice(0, 500)) {
      const v = row[i];
      max = Math.max(max, v === null || v === undefined ? 0 : String(v).length);
    }
    return Math.min(60, Math.max(8, max + 2));
  });
  const lastCol = columnName(Math.max(sheet.columns.length, 1) - 1);
  const lastRow = sheet.rows.length + 1;
  const rows = [
    `<row r="1">${sheet.columns.map((c, i) => cell(`${columnName(i)}1`, c, STYLE_HEADER)).join('')}</row>`,
    ...sheet.rows.map(
      (row, r) => `<row r="${r + 2}">${row.map((v, i) => cell(`${columnName(i)}${r + 2}`, v, 0, sheet.types?.[i])).join('')}</row>`,
    ),
  ];

  const worksheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="A1:${lastCol}${lastRow}"/>` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    (widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '') +
    `<sheetData>${rows.join('')}</sheetData>` +
    (sheet.columns.length ? `<autoFilter ref="A1:${lastCol}${lastRow}"/>` : '') +
    '</worksheet>';

  const files: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets><sheet name="${escapeXml(sheetName(sheet.name))}" sheetId="1" r:id="rId1"/></sheets>` +
      (sheet.columns.length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${escapeXml(sheetName(sheet.name)).replace(/'/g, "''")}'!$A$1:$${lastCol}$${lastRow}</definedName></definedNames>` : '') +
      '</workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>',
    'xl/styles.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/></numFmts>' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>',
    'xl/worksheets/sheet1.xml': worksheet,
  };
  return zip(Object.entries(files).map(([name, xml]) => ({ name, data: Buffer.from(xml, 'utf8') })));
}
