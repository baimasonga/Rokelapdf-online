// Fee clearance certificate, issued by receipt processing (docs/receipt-processing.md). Built on the server from the facts recorded at clearance, so the
// same facts always give the same bytes: the verification record holds this file's SHA-256, and the student's and
// finance's downloads are rebuilt rather than stored. Changing this layout changes every certificate's bytes; the
// golden digest in tests/unit/fee-certificate.test.ts makes that a deliberate decision.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { encodeQr } from '../qr';

/** What a certificate prints, recorded when the claim is cleared. */
export interface FeeCertificateFacts {
  institution: string;
  title: string;
  studentName: string;
  studentId: string;
  amount: string;
  paidOn: string;
  bank: string;
  reference: string;
  confirmedBy: 'statement' | 'manual';
  clearedOn: string;
  code: string;
  url: string;
}

const A4 = { w: 595.28, h: 841.89 };
const NAVY = rgb(0.07, 0.15, 0.3);
const INK = rgb(0.12, 0.12, 0.14);
const MUTED = rgb(0.38, 0.4, 0.45);

// Letters with no accent-free decomposition, including Ɛ and Ɔ used in Sierra Leonean languages.
const PLAIN: Record<string, string> = {
  Ł: 'L',
  ł: 'l',
  Ø: 'O',
  ø: 'o',
  Đ: 'D',
  đ: 'd',
  Ɛ: 'E',
  ɛ: 'e',
  Ɔ: 'O',
  ɔ: 'o',
  Ŋ: 'N',
  ŋ: 'n',
  Ħ: 'H',
  ħ: 'h',
  ı: 'i',
};

/** Standard PDF fonts cover Western European text only; anything else prints as "?" rather than failing. */
function printable(font: PDFFont, s: string): string {
  return [...s.normalize('NFC')]
    .map((ch) => {
      try {
        font.encodeText(ch);
        return ch;
      } catch {
        const plain = PLAIN[ch] ?? ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
        try {
          font.encodeText(plain);
          return plain;
        } catch {
          return '?';
        }
      }
    })
    .join('');
}

/** Wraps `text` to lines no wider than `width`. */
function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function buildFeeCertificate(f: FeeCertificateFacts): Promise<Uint8Array> {
  // Fixed metadata: no creation time, producer or random file identifier, so equal facts give equal bytes.
  const doc = await PDFDocument.create({ updateMetadata: false });
  const at = new Date(`${f.clearedOn}T00:00:00Z`);
  doc.setCreationDate(at);
  doc.setModificationDate(at);
  doc.setProducer('Rokela PDF');
  doc.setCreator('Rokela PDF fee clearance');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(printable(regular, `Fee clearance certificate — ${f.studentName}`));
  const page: PDFPage = doc.addPage([A4.w, A4.h]);
  const left = 64;
  const width = A4.w - left * 2;
  const draw = (s: string, x: number, y: number, size: number, font = regular, color = INK) => page.drawText(printable(font, s), { x, y, size, font, color });

  page.drawRectangle({ x: 0, y: A4.h - 12, width: A4.w, height: 12, color: NAVY });
  let y = A4.h - 88;
  for (const line of wrap(bold, printable(bold, f.institution), 20, width)) {
    draw(line, left, y, 20, bold, NAVY);
    y -= 26;
  }
  y -= 8;
  draw('FEE CLEARANCE CERTIFICATE', left, y, 13, bold, INK);
  y -= 22;
  for (const line of wrap(regular, printable(regular, f.title), 12, width)) {
    draw(line, left, y, 12, regular, MUTED);
    y -= 16;
  }
  y -= 10;
  page.drawLine({ start: { x: left, y }, end: { x: A4.w - left, y }, thickness: 0.8, color: rgb(0.8, 0.82, 0.86) });
  y -= 30;

  const statement = `This certifies that the student named below has paid the fees stated, and that the payment was ${
    f.confirmedBy === 'statement' ? "confirmed against the institution's bank statement" : 'confirmed by the finance office'
  }.`;
  for (const line of wrap(regular, printable(regular, statement), 11, width)) {
    draw(line, left, y, 11);
    y -= 15;
  }
  y -= 18;

  const rows: Array<[string, string]> = [
    ['Student name', f.studentName],
    ['Student ID', f.studentId],
    ['Amount paid', f.amount],
    ['Payment date', f.paidOn],
    ['Bank', f.bank],
    ['Bank reference', f.reference],
    ['Cleared on', f.clearedOn],
  ];
  for (const [label, value] of rows) {
    draw(label, left, y, 10, regular, MUTED);
    const lines = wrap(bold, printable(bold, value), 12, width - 150);
    lines.forEach((line, i) => draw(line, left + 150, y - i * 16, 12, bold));
    y -= 16 * lines.length + 12;
  }

  // Verification block: QR code (4-module quiet zone) and the address and code beside it.
  const qr = encodeQr(f.url);
  const size = 104;
  const cell = size / (qr.size + 8);
  const qx = left;
  const qy = 92;
  page.drawRectangle({ x: qx, y: qy, width: size, height: size, color: rgb(1, 1, 1) });
  for (let r = 0; r < qr.size; r++)
    for (let c = 0; c < qr.size; c++)
      if (qr.modules[r]![c]) page.drawRectangle({ x: qx + (c + 4) * cell, y: qy + size - (r + 5) * cell, width: cell, height: cell, color: rgb(0, 0, 0) });
  const tx = qx + size + 16;
  draw('Check this certificate', tx, qy + size - 24, 11, bold);
  draw('Scan the code or open:', tx, qy + size - 42, 10, regular, MUTED);
  draw(f.url.replace(/^https?:\/\//, ''), tx, qy + size - 58, 10);
  draw(`Code ${f.code}`, tx, qy + size - 76, 10, regular, MUTED);
  for (const [i, line] of wrap(
    regular,
    'The verification page shows whether this certificate is still valid. A copy that was edited or re-saved will not match the original.',
    8,
    width - size - 16,
  ).entries())
    draw(line, tx, qy + 8 - i * 10 + 10, 8, regular, MUTED);
  draw('Issued with Rokela PDF', left, 48, 8, regular, MUTED);

  return doc.save({ useObjectStreams: false });
}
