import { TITLES, type BizDoc, type Business } from './model';
import { buildBizDoc } from './pdf';
import type { SavedDoc } from './docs';
import { TEMPLATES, newStamp, type StampDesign } from '../stamp/design';
import { renderStamp } from '../stamp/render';

// Making a saved document (docs.ts) again, on the website or in the Android app: its words as they were, with the
// business's details, signature and stamps as they are now. Its check QR code, if it had one, is printed again with
// the same code; that check's file fingerprint is the first file's, so the check page reads this copy as the same
// document but not the same file.

/** A stable number from text, so a document keeps the same stamp impression every time it is made. */
export const seedOf = (s: string) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);

export function againName(d: Pick<SavedDoc, 'kind' | 'number' | 'customer'>): string {
  return `${TITLES[d.kind].modern} ${d.number}${d.customer.trim() ? ` - ${d.customer.trim()}` : ''}.pdf`.replace(/[\\/:*?"<>|]+/g, ' ');
}

export async function makeAgain(
  biz: Business,
  saved: SavedDoc,
  o: { signature?: string; stamps: StampDesign[]; paidStamp: boolean },
): Promise<{ bytes: Uint8Array; name: string }> {
  const design = saved.stampId ? o.stamps.find((s) => s.id === saved.stampId) : undefined;
  const doc: BizDoc = {
    ...saved,
    signature: o.signature,
    stamp: design ? renderStamp(design, { seed: seedOf(saved.number + design.id) }).src : undefined,
    paidStamp: o.paidStamp
      ? renderStamp(newStamp({ ...TEMPLATES[2]!.design, numbered: false, bottom: (biz.name || '').toUpperCase().slice(0, 28), wear: 0.5 }), {
          seed: seedOf(saved.number),
          date: new Date(`${saved.date}T12:00:00`),
        }).src
      : undefined,
  };
  return { bytes: await buildBizDoc(biz, doc), name: againName(saved) };
}
