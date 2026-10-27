import { sha256Hex } from '../client/sha256';
import { totals, type BizDoc, type Business } from './model';
import { buildBizDoc } from './pdf';

// Receipt checks from the device's side (docs/receipt-checks.md), shared by the website and the Android app: register
// the document's facts, print the QR code, then record the finished file's SHA-256. The PDF itself is never sent.

/** A registered receipt check, as the API returns it. */
export interface Check {
  id: string;
  code: string;
  url: string;
  sha256: string | null;
}

/** The last check registered on this device, and the facts it vouches for, so making the same document again reuses it. */
export interface Issued {
  facts: string;
  doc: string;
  check: Check;
}

/** POSTs JSON to the API as the signed-in person and returns the parsed answer (each caller adds its own auth). */
export type Post = <T>(path: string, body: unknown) => Promise<T>;

/** Shown in previews until the document is registered: the real code is made when it is shared or saved. */
export const PREVIEW_CODE = 'XXXXXXXXXXXXXXXX';

export function checkFacts(biz: Business, doc: BizDoc) {
  return {
    kind: doc.kind,
    business_name: biz.name.trim(),
    number: doc.number.trim(),
    issued_on: doc.date,
    currency: doc.currency,
    total: totals(doc).total,
    ...(doc.customer.trim() ? { customer_name: doc.customer.trim() } : {}),
  };
}

/**
 * The document with its check QR code. A document whose facts and file are unchanged reuses its check; if its facts
 * or its look changed after it was registered, it gets a new check and the previous one for the same number is
 * cancelled as replaced, so only the latest file reads as valid.
 */
export async function checkedPdf(biz: Business, doc: BizDoc, post: Post, prev: Issued | undefined): Promise<{ bytes: Uint8Array; issued: Issued }> {
  const facts = checkFacts(biz, doc);
  const key = JSON.stringify(facts);
  if (prev?.facts === key) {
    const bytes = await buildBizDoc(biz, { ...doc, check: prev.check });
    if (prev.check.sha256 === (await sha256Hex(bytes))) return { bytes, issued: prev };
  }
  const check = await post<Check>('/api/v1/me/receipt-checks', facts);
  const bytes = await buildBizDoc(biz, { ...doc, check });
  check.sha256 = (await post<Check>(`/api/v1/me/receipt-checks/${encodeURIComponent(check.id)}/digest`, { sha256: await sha256Hex(bytes) })).sha256;
  const docKey = `${facts.kind} ${facts.number}`;
  if (prev?.doc === docKey) await post(`/api/v1/me/receipt-checks/${encodeURIComponent(prev.check.id)}/cancel`, { reason: 'replaced' }).catch(() => undefined);
  return { bytes, issued: { facts: key, doc: docKey, check } };
}
