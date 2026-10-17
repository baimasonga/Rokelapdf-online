import { PDFDocument as SecureDocument } from '@cantoo/pdf-lib';
import { EditorError } from '../editor/export';

// Password protection (AES-256) and unlocking. Uses @cantoo/pdf-lib, a maintained pdf-lib fork with encryption
// support, loaded only by these two tools. Runs in the browser; files are never uploaded.

const fail = (msg: string): never => {
  throw new EditorError(msg);
};

export interface ProtectOptions {
  password: string;
  allowPrinting: boolean;
  allowCopying: boolean;
  allowEditing: boolean;
}

function randomOwnerPassword() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Encrypts a PDF with AES-256. Opening it needs `password`. The owner password is random and never shown, so the
 * chosen restrictions (printing, copying, editing) cannot be lifted with the open password. Viewers enforce those
 * restrictions; they are not a guarantee against determined copying.
 */
export async function protectPdf(bytes: Uint8Array, o: ProtectOptions): Promise<Uint8Array> {
  if (o.password.length < 6) fail('Use a password of at least 6 characters.');
  if (o.password.length > 127) fail('Use a password of at most 127 characters.');
  let d: SecureDocument;
  try {
    d = await SecureDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return fail('This file is not a readable PDF.');
  }
  if (d.isEncrypted) fail('This PDF is already protected. Unlock it first, then protect it again.');
  d.encrypt({
    userPassword: o.password,
    ownerPassword: randomOwnerPassword(),
    permissions: {
      printing: o.allowPrinting ? 'highResolution' : false,
      copying: o.allowCopying,
      contentAccessibility: true,
      modifying: o.allowEditing,
      annotating: o.allowEditing,
      fillingForms: true,
      documentAssembly: o.allowEditing,
    },
  });
  return d.save({ useObjectStreams: false });
}

/** Removes password protection from a PDF you can open (the password is needed). */
export async function unlockPdf(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  let probe: SecureDocument;
  try {
    probe = await SecureDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return fail('This file is not a readable PDF.');
  }
  if (!probe.isEncrypted) fail('This PDF is not password-protected.');
  let d: SecureDocument;
  try {
    d = await SecureDocument.load(bytes, { password, updateMetadata: false });
  } catch {
    return fail('That password is not correct.');
  }
  return d.save({ useObjectStreams: true });
}
