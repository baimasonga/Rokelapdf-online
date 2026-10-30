// Reads a bank statement export (CSV or Excel .xlsx) on the finance officer's device (docs/receipt-processing.md). Only the
// credit lines are sent for matching, never the file. Old binary .xls files are not read: save them as .xlsx or CSV.
import { strFromU8, unzipSync } from 'fflate';
import { isIsoDate, parseAmount, type StatementLine } from './match';

export type Grid = string[][];

/** RFC 4180 CSV (also semicolon- or tab-separated), quoted fields with embedded separators, quotes and newlines. */
export function parseCsv(text: string): Grid {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const);
  const sep = counts.sort((a, b) => b[1] - a[1])[0]![0];
  const rows: Grid = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
  );
const textOf = (xml: string) => unescapeXml([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
const column = (ref: string) => [...ref.replace(/\d+$/, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** The first worksheet of an .xlsx workbook as text cells (numbers as written, dates as Excel serial numbers). */
export function parseXlsx(bytes: Uint8Array): Grid {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => (f.name.startsWith('xl/') && f.name.endsWith('.xml')) || f.name.endsWith('.rels') });
  } catch {
    throw new Error('This is not an Excel .xlsx file. Save the statement as .xlsx or CSV and try again.');
  }
  const read = (name: string) => (files[name] ? strFromU8(files[name]!) : undefined);
  const workbook = read('xl/workbook.xml');
  if (!workbook) throw new Error('This is not an Excel .xlsx file. Save the statement as .xlsx or CSV and try again.');
  const firstSheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  const target = firstSheet && new RegExp(`<Relationship\\b[^>]*Id="${firstSheet}"[^>]*Target="([^"]+)"`).exec(read('xl/_rels/workbook.xml.rels') ?? '')?.[1];
  const sheetPath = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`) : 'xl/worksheets/sheet1.xml';
  const sheet = read(sheetPath);
  if (!sheet) throw new Error('The workbook has no worksheet to read.');
  const shared = [...(read('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));
  const rows: Grid = [];
  for (const r of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!;
      const body = c[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      const value =
        type === 's' ? (shared[Number(v)] ?? '') : type === 'inlineStr' ? textOf(body) : type === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : unescapeXml(v ?? '');
      const at = ref ? column(ref) : row.length;
      while (row.length < at) row.push('');
      row[at] = value.trim();
    }
    if (row.some(Boolean)) rows.push(row);
  }
  return rows;
}

export function readStatement(name: string, bytes: Uint8Array): Grid {
  if (/\.xlsx$/i.test(name)) return parseXlsx(bytes);
  if (/\.xls$/i.test(name)) throw new Error('Old Excel (.xls) files cannot be read. Save the statement as .xlsx or CSV and try again.');
  return parseCsv(new TextDecoder('utf-8').decode(bytes));
}

export interface Columns {
  date: number;
  reference: number;
  /** -1 when the statement has no separate description column. */
  description: number;
  /** A credit (money in) column, or a signed amount column when `signed`. */
  amount: number;
  signed: boolean;
}

const HEADS = {
  date: /^(value |transaction |trans\.? |posting |book(ing)? )?date$|^date/i,
  reference: /ref|transaction id|trans(action)? no|receipt|teller|cheque|instrument/i,
  description: /desc|narrat|details|particular|remark|memo|payee|depositor|purpose/i,
  credit: /credit|deposit|money in|paid in|^cr$|^cr\.?\s*amount|receipts?$/i,
  amount: /amount|value/i,
};

/** The header row (the first of the top 15 rows naming a date and an amount or credit) and a guess at its columns. */
export function guessColumns(grid: Grid): { header: number; columns: Columns } | undefined {
  for (let h = 0; h < Math.min(15, grid.length); h++) {
    const row = grid[h]!.map((c) => c.trim());
    const find = (re: RegExp, skip: number[] = []) => row.findIndex((c, i) => !skip.includes(i) && re.test(c));
    const date = find(HEADS.date);
    if (date < 0) continue;
    const credit = find(HEADS.credit, [date]);
    const amount = credit >= 0 ? credit : find(HEADS.amount, [date]);
    if (amount < 0) continue;
    const reference = find(HEADS.reference, [date, amount]);
    const description = find(HEADS.description, [date, amount, reference]);
    return { header: h, columns: { date, reference: reference >= 0 ? reference : description, description, amount, signed: credit < 0 } };
  }
  return undefined;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** YYYY-MM-DD from ISO, day-first (or month-first) numeric dates, "5 Oct 2026", "05-Oct-26" or an Excel serial. */
export function parseStatementDate(raw: string, monthFirst = false): string | undefined {
  const s = raw.trim();
  const iso = (y: number, m: number, d: number) => {
    const out = `${String(y < 100 ? 2000 + y : y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return isIsoDate(out) ? out : undefined;
  };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/.exec(s);
  if (m) return monthFirst ? iso(+m[3]!, +m[1]!, +m[2]!) : iso(+m[3]!, +m[2]!, +m[1]!);
  m = /^(\d{1,2})[\s/.-]*([A-Za-z]{3})[A-Za-z]*\.?[\s/.,-]*(\d{2}|\d{4})\b/.exec(s);
  if (m && MONTHS.includes(m[2]!.toLowerCase())) return iso(+m[3]!, MONTHS.indexOf(m[2]!.toLowerCase()) + 1, +m[1]!);
  m = /^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(s);
  if (m && MONTHS.includes(m[1]!.toLowerCase())) return iso(+m[3]!, MONTHS.indexOf(m[1]!.toLowerCase()) + 1, +m[2]!);
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s));
    if (serial > 20_000 && serial < 80_000) return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }
  return undefined;
}

/** Credit lines of the statement under its header row; rows without a readable date or a positive amount are skipped. */
export function statementLines(grid: Grid, header: number, c: Columns, monthFirst = false): { lines: StatementLine[]; skipped: number } {
  const lines: StatementLine[] = [];
  let skipped = 0;
  for (const row of grid.slice(header + 1)) {
    const date = parseStatementDate(row[c.date] ?? '', monthFirst);
    const amount = parseAmount(row[c.amount] ?? '');
    if (!date || amount === undefined || amount <= 0) {
      skipped++;
      continue;
    }
    lines.push({
      date,
      amount,
      reference: (row[c.reference] ?? '').slice(0, 120),
      description: c.description >= 0 && c.description !== c.reference ? (row[c.description] ?? '').slice(0, 140) : '',
    });
  }
  return { lines, skipped };
}
