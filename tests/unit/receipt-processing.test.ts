import { createHash } from 'node:crypto';
import jsQRModule from 'jsqr';
import { createCanvas } from '@napi-rs/canvas';
import { strToU8, zipSync } from 'fflate';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { buildFeeCertificate, type FeeCertificateFacts } from '@/lib/fees/certificate';
import { formatAmount, matchStatement, parseAmount, referenceKey } from '@/lib/fees/match';
import { guessColumns, parseCsv, parseStatementDate, parseXlsx, readStatement, statementLines } from '@/lib/fees/statement';

const jsQR = ((jsQRModule as unknown as { default?: unknown }).default ?? jsQRModule) as unknown as (
  data: Uint8ClampedArray,
  w: number,
  h: number,
) => { data: string } | null;

describe('fee amounts and references', () => {
  it('reads amounts as written on statements and receipts, in minor units', () => {
    expect(parseAmount('1,500.00')).toBe(150_000);
    expect(parseAmount('NLe 1 500')).toBe(150_000);
    expect(parseAmount('1500.5')).toBe(150_050);
    expect(parseAmount('(250.00)')).toBe(-25_000);
    expect(parseAmount('-250')).toBe(-25_000);
    expect(parseAmount('250.00 DR')).toBe(-25_000);
    expect(parseAmount('250.00CR')).toBe(25_000);
    expect(parseAmount('100 USD')).toBe(10_000);
    expect(parseAmount(1500)).toBe(150_000);
    for (const bad of ['', 'abc', '1.234', '1.2.3', '--5']) expect(parseAmount(bad), bad).toBeUndefined();
    expect(formatAmount(150_000, 'NLe')).toBe('NLe 1,500.00');
    expect(formatAmount(1_234_567_89, 'USD')).toBe('USD 1,234,567.89');
  });

  it('treats references with different spacing, case and punctuation as the same', () => {
    expect(referenceKey('ft-2628 1abc/12')).toBe('FT26281ABC12');
    expect(referenceKey('  ')).toBe('');
  });
});

describe('statement matching', () => {
  const claim = (id: string, ref: string, amount = 150_000, paidOn = '2026-10-01', studentId = 'FBC/2024/123') => ({
    id,
    referenceKey: referenceKey(ref),
    amount,
    paidOn,
    studentId,
  });
  const line = (reference: string, amount = 150_000, date = '2026-10-02', description = '') => ({ reference, amount, date, description });

  it('needs the reference, the exact amount and a date within the tolerance', () => {
    const r = matchStatement(
      [claim('a', 'FT1111'), claim('b', 'FT2222'), claim('c', 'FT3333'), claim('d', 'FT4444')],
      [line('FT1111'), line('FT2222', 140_000), line('FT3333', 150_000, '2026-10-20'), line('FT9999')],
      3,
      'NLe',
    );
    expect(r.matches).toEqual([{ claimId: 'a', line: 0, studentIdFound: false }]);
    expect(r.issues).toEqual([
      { claimId: 'b', issue: 'The reference is on the statement for NLe 1,400.00, not NLe 1,500.00.' },
      { claimId: 'c', issue: 'The reference is on the statement dated 2026-10-20, 19 days from the declared 2026-10-01.' },
    ]);
  });

  it('finds longer references inside the narrative, notes the student ID, and never uses a line twice', () => {
    const lines = [line('', 150_000, '2026-10-01', 'TRF FT26281ABC12 / FBC2024123 TUITION'), line('FT0001'), line('FT0001', 150_000, '2026-10-03')];
    const r = matchStatement([claim('a', 'FT26281ABC12'), claim('b', 'FT0001'), claim('c', 'FT0001')], lines, 3, 'NLe');
    expect(r.matches).toEqual([
      { claimId: 'a', line: 0, studentIdFound: true },
      { claimId: 'b', line: 1, studentIdFound: false },
      { claimId: 'c', line: 2, studentIdFound: false },
    ]);
    // Short references must match the reference column exactly; debits and used lines are ignored.
    expect(matchStatement([claim('x', 'AB12')], [line('', 150_000, '2026-10-01', 'XAB12Y')], 3, 'NLe').matches).toEqual([]);
    expect(matchStatement([claim('x', 'FT0001')], [line('FT0001', -150_000)], 3, 'NLe')).toEqual({ matches: [], issues: [] });
    expect(matchStatement([claim('x', 'FT0001')], [line('FT0001')], 3, 'NLe', new Set([0])).matches).toEqual([]);
  });
});

describe('statement files', () => {
  it('reads CSV exports with a preamble, quoted fields and credit columns', () => {
    const csv = [
      'Rokel Commercial Bank,Account statement',
      'Account,0012345678',
      '',
      'Value Date,Narration,Reference,Debit,Credit,Balance',
      '01/10/2026,"TUITION FBC/2024/123, KAMARA",FT26281ABC12,,"1,500.00","10,000.00"',
      '02/10/2026,BANK CHARGES,CHG01,25.00,,"9,975.00"',
      '3 Oct 2026,"Said ""hello""",FT9,,200,10175',
    ].join('\r\n');
    const grid = parseCsv(csv);
    const guess = guessColumns(grid)!;
    expect(guess).toEqual({ header: 2, columns: { date: 0, reference: 2, description: 1, amount: 4, signed: false } });
    expect(statementLines(grid, guess.header, guess.columns)).toEqual({
      lines: [
        { date: '2026-10-01', amount: 150_000, reference: 'FT26281ABC12', description: 'TUITION FBC/2024/123, KAMARA' },
        { date: '2026-10-03', amount: 20_000, reference: 'FT9', description: 'Said "hello"' },
      ],
      skipped: 1,
    });
    expect(parseCsv('Date;Amount\n2026-10-01;5')).toEqual([
      ['Date', 'Amount'],
      ['2026-10-01', '5'],
    ]);
  });

  it('reads dates in the forms banks use', () => {
    expect(parseStatementDate('2026-10-05')).toBe('2026-10-05');
    expect(parseStatementDate('05/10/2026')).toBe('2026-10-05');
    expect(parseStatementDate('10/05/2026', true)).toBe('2026-10-05');
    expect(parseStatementDate('05-Oct-26')).toBe('2026-10-05');
    expect(parseStatementDate('5 October 2026')).toBe('2026-10-05');
    expect(parseStatementDate('Oct 5, 2026')).toBe('2026-10-05');
    expect(parseStatementDate('46300')).toBe('2026-10-05');
    for (const bad of ['31/02/2026', 'yesterday', '', '13/13/2026']) expect(parseStatementDate(bad), bad).toBeUndefined();
  });

  it('reads the first worksheet of an Excel workbook', () => {
    const xlsx = zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet7.xml"/></Relationships>'),
      'xl/sharedStrings.xml': strToU8('<sst><si><t>Date</t></si><si><t>Amount</t></si><si><r><t>FT1 </t></r><r><t>&amp; co</t></r></si></sst>'),
      'xl/worksheets/sheet7.xml': strToU8(
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2"><v>46300</v></c><c r="B2" t="s"><v>2</v></c><c r="C2"><v>1500</v></c></row>' +
          '<row r="3"><c r="A3" t="inlineStr"><is><t>2026-10-06</t></is></c><c r="C3"><v>7.5</v></c></row></sheetData></worksheet>',
      ),
    });
    expect(parseXlsx(xlsx)).toEqual([
      ['Date', '', 'Amount'],
      ['46300', 'FT1 & co', '1500'],
      ['2026-10-06', '', '7.5'],
    ]);
    expect(() => readStatement('old.xls', new Uint8Array(4))).toThrow(/\.xls/);
    expect(() => readStatement('broken.xlsx', strToU8('not a zip'))).toThrow(/not an Excel/);
  });
});

describe('fee clearance certificate', () => {
  const facts: FeeCertificateFacts = {
    institution: 'University of Example',
    title: '2026/27 first semester tuition',
    studentName: 'Aminata Kamara',
    studentId: 'FBC/2024/123',
    amount: 'NLe 1,500.00',
    paidOn: '2026-10-01',
    bank: 'Rokel Commercial Bank',
    reference: 'FT26281ABC12',
    confirmedBy: 'statement',
    clearedOn: '2026-10-05',
    code: 'ABCDEFGHIJKLMNOPQRST',
    url: 'https://www.rokelapdf.com/v/ABCDEFGHIJKLMNOPQRST',
  };

  it('is the same file every time it is built from the same facts', async () => {
    const a = await buildFeeCertificate(facts);
    const b = await buildFeeCertificate(facts);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    // Certificates already issued are rebuilt for download and must still match their registered digest. If this
    // changes, every issued certificate stops downloading: change the layout only with a migration plan.
    expect(createHash('sha256').update(a).digest('hex')).toBe('7ec76e15dd4c6e5bae2bcf6ad07a5abaf7552aa88dcc417573b481543dcdf811');
    expect(Buffer.from(await buildFeeCertificate({ ...facts, studentName: 'Someone Else' })).equals(Buffer.from(a))).toBe(false);
  });

  it('prints the facts and a QR code for the verification page', async () => {
    const doc = await getDocument({ data: await buildFeeCertificate({ ...facts, studentName: 'Łukasz Ñúñez Ɛfua 李' }) }).promise;
    const page = await doc.getPage(1);
    const text = (await page.getTextContent()).items.map((t) => ('str' in t ? t.str : '')).join(' ');
    for (const s of ['University of Example', 'FEE CLEARANCE CERTIFICATE', 'Lukasz Ñúñez Efua ?', 'FBC/2024/123', 'NLe 1,500.00', 'FT26281ABC12', facts.code])
      expect(text).toContain(s);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, canvas: canvas as unknown as HTMLCanvasElement }).promise;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    expect(jsQR(new Uint8ClampedArray(img.data), img.width, img.height)?.data).toBe(facts.url);
  });
});
