import { serveApk } from '@/lib/server/android-apk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The Android APK, served from rokelapdf.com (src/lib/server/android-apk.ts). */
export function GET(req: Request) {
  return serveApk(req);
}

export function HEAD(req: Request) {
  return serveApk(req);
}
