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

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function toBase64(bytes: Uint8Array) {
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

/** Opens the Android share sheet (save to Files or Drive, WhatsApp, email…) for a PDF. */
export async function sharePdf(f: PdfFile) {
  const name = f.name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'document.pdf';
  if (!native) {
    const url = URL.createObjectURL(new Blob([f.bytes as BlobPart], { type: 'application/pdf' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return;
  }
  const written = await Filesystem.writeFile({ path: name, data: toBase64(f.bytes), directory: Directory.Cache });
  await Share.share({ title: name, files: [written.uri] });
}

export { isPdf };
