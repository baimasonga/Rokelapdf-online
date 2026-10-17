import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { protectPdf, unlockPdf } from '@/lib/tools/security';

const FONTS = `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/`;
async function sample() {
  const d = await PDFDocument.create();
  d.addPage([400, 600]).drawText('Salary statement', { x: 40, y: 500, size: 18, font: await d.embedFont(StandardFonts.Helvetica) });
  return d.save();
}
/** Opens with pdf.js (an independent reader); returns the first page's text and the permission flags. */
async function open(bytes: Uint8Array, password?: string) {
  const doc = await getDocument({ data: bytes.slice(), standardFontDataUrl: FONTS, ...(password ? { password } : {}) }).promise;
  const text = (await (await doc.getPage(1)).getTextContent()).items.map((i) => (i as { str: string }).str).join('');
  return { text, permissions: await doc.getPermissions() };
}

describe('protect and unlock PDF', () => {
  it('encrypts so the file only opens with the password, and unlocking restores open access', async () => {
    const locked = await protectPdf(await sample(), { password: 'river-stone', allowPrinting: true, allowCopying: false, allowEditing: false });
    expect(new TextDecoder('latin1').decode(locked)).not.toContain('Salary statement');
    await expect(open(locked)).rejects.toMatchObject({ name: 'PasswordException' });
    await expect(open(locked, 'wrong-pass')).rejects.toMatchObject({ name: 'PasswordException' });
    const opened = await open(locked, 'river-stone');
    expect(opened.text).toBe('Salary statement');
    expect(opened.permissions).not.toBeNull(); // restrictions recorded

    const unlocked = await unlockPdf(locked, 'river-stone');
    const plain = await open(unlocked);
    expect(plain.text).toBe('Salary statement');
    expect(plain.permissions).toBeNull();
  });

  it('refuses weak passwords, double protection, wrong passwords and unprotected files', async () => {
    const pdf = await sample();
    await expect(protectPdf(pdf, { password: 'abc', allowPrinting: true, allowCopying: true, allowEditing: true })).rejects.toThrow(/at least 6/);
    const locked = await protectPdf(pdf, { password: 'river-stone', allowPrinting: true, allowCopying: true, allowEditing: true });
    await expect(protectPdf(locked, { password: 'another-one', allowPrinting: true, allowCopying: true, allowEditing: true })).rejects.toThrow(
      /already protected/,
    );
    await expect(unlockPdf(locked, 'nope-nope')).rejects.toThrow(/not correct/);
    await expect(unlockPdf(pdf, 'whatever')).rejects.toThrow(/not password-protected/);
    await expect(unlockPdf(new TextEncoder().encode('junk'), 'x')).rejects.toThrow(/not a readable PDF/);
  });
});
