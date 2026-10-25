import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { DocumentScanner } from '@capacitor-mlkit/document-scanner';

/** A PDF in memory: nothing is uploaded unless the person chooses a server feature (conversion). */
export interface PdfFile {
  name: string;
  bytes: Uint8Array;
}

/** Files another app sent with "Open with" or "Share" (android/…/IncomingFilePlugin.java). */
interface IncomingFilePlugin {
  take(): Promise<{ name?: string; data?: string; type?: string }>;
  addListener(event: 'fileReceived', fn: () => void): Promise<PluginListenerHandle>;
}
const IncomingFile = registerPlugin<IncomingFilePlugin>('IncomingFile');

/** Android's "Save to…" dialog (android/…/SaveFilePlugin.java): the person picks the folder; no storage permission. */
interface SaveFilePlugin {
  save(o: { name: string; mime: string; data: string }): Promise<{ saved: boolean }>;
}
const SaveFile = registerPlugin<SaveFilePlugin>('SaveFile');

export const PDF_MIME = 'application/pdf';
/** File types the app saves and shares; SaveFilePlugin.java accepts exactly these. */
export const MIME = {
  pdf: PDF_MIME,
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

export const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export function toBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const isPdf = (b: Uint8Array) => b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF
export const native = Capacitor.isNativePlatform();

/** The PDF this launch or a later "Open with" delivered, if any. Non-PDF content is refused. */
export async function takeIncoming(): Promise<PdfFile | undefined> {
  if (!native) return undefined;
  const f = await IncomingFile.take();
  if (!f.data) return undefined;
  const bytes = fromBase64(f.data);
  if (!isPdf(bytes)) throw new Error('That file is not a PDF.');
  return { name: f.name || 'document.pdf', bytes };
}
export const onIncoming = (fn: () => void) => (native ? IncomingFile.addListener('fileReceived', fn) : undefined);

/** Google's on-device document scanner: edge detection, cropping and clean-up; returns one PDF. */
export async function scanDocument(): Promise<PdfFile | undefined> {
  if (!native) throw new Error('Scanning needs the Android app.');
  const { available } = await DocumentScanner.isGoogleDocumentScannerModuleAvailable();
  if (!available) await DocumentScanner.installGoogleDocumentScannerModule();
  const result = await DocumentScanner.scanDocument({ galleryImportAllowed: true, pageLimit: 50, resultFormats: 'PDF', scannerMode: 'FULL' });
  if (!result.pdf) return undefined; // cancelled
  const file = await Filesystem.readFile({ path: result.pdf.uri });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return { name: `scan-${stamp}.pdf`, bytes: fromBase64(file.data as string) };
}

const safeName = (name: string) => name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'document';

function download(name: string, bytes: Uint8Array, mime: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Opens the Android share sheet (Drive, WhatsApp, email…). */
export async function shareFile(name: string, bytes: Uint8Array, mime = PDF_MIME) {
  const n = safeName(name);
  if (!native) return download(n, bytes, mime);
  const written = await Filesystem.writeFile({ path: n, data: toBase64(bytes), directory: Directory.Cache });
  await Share.share({ title: n, files: [written.uri] });
}

/** Saves to a folder the person chooses. Resolves false when they cancel. */
export async function saveFile(name: string, bytes: Uint8Array, mime = PDF_MIME): Promise<boolean> {
  const n = safeName(name);
  if (!native) {
    download(n, bytes, mime);
    return true;
  }
  return (await SaveFile.save({ name: n, mime, data: toBase64(bytes) })).saved;
}

export { isPdf };
