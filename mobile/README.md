# Rokela PDF for Android

A small Android app built with [Capacitor](https://capacitorjs.com): a native shell around a Vite + React web layer.
Shared browser code is imported from the web app with the `@/` alias (`../src`).

## What it does

| Feature            | Status | Notes                                                                                              |
| ------------------ | ------ | -------------------------------------------------------------------------------------------------- |
| Scan a document    | Ready  | Google ML Kit document scanner: edge detection, clean-up, gallery import, up to 50 pages, PDF out. |
| Open a PDF         | Ready  | File picker, plus "Open with" and "Share" from WhatsApp, Files, Gmail and other apps.              |
| View               | Ready  | pdf.js; pages render as they scroll into view.                                                     |
| Share and save     | Ready  | Android share sheet, or "Save" with Android's own Save-to dialog (no storage permission).          |
| Sign a PDF         | Ready  | Draw or type a signature, tap to place, drag and resize; drawn into the PDF on the phone.          |
| Word ⇄ PDF         | Ready  | Through rokelapdf.com's converter: needs internet and a signed-in account with a confirmed email.  |
| Play Store release | Later  | Step 3: needs a Play developer account, a 512 px icon and a release signing key.                   |

Signing reuses the web editor's export (`src/lib/editor`): signatures never leave the phone. Conversions call
`POST /api/v1/convert/:target` on `VITE_SITE_ORIGIN` (default `https://www.rokelapdf.com`) with the Supabase access
token. The API answers this app's WebView origin (`https://localhost`) only on that route and `GET /api/v1/config`
(see `docs/security.md`); the same limits as the website apply (50 MB, 6 a minute, 100 a day).

Files received from other apps are read only from `content://` URIs the sender granted, are capped at 50 MB, and must
start with `%PDF`. The app asks for no storage or camera permission: the scanner runs in Google Play services.

## Getting a test build

**For people installing the app:** <https://www.rokelapdf.com/android> has the download button, a QR code for computer
visitors and install steps. The button points at a link that never changes:
<https://github.com/baimasonga/Rokelapdf-online/releases/download/android/rokela-pdf.apk>.

Every push to the default branch that touches the app runs the **Android** workflow, which replaces that APK on the
`android` release. Pull requests upload the APK as the `rokela-pdf-debug-apk` artifact instead (kept 30 days). Test builds
are debug-signed with one key kept in the Actions cache, so a newer build installs over an older one; if the cache was
evicted, Android refuses the update and the old version must be uninstalled first. Play Store builds will use a release
key.

## Building locally

Needs Node 22, JDK 21 and the Android SDK (platform 36).

```sh
cd mobile
npm ci
npm run dev   # web layer in a browser (scanner and "Open with" need the app)
npm run apk   # typecheck, build, cap sync, then android/app/build/outputs/apk/debug/app-debug.apk
```

`android/` is the generated Capacitor project and is committed; native additions live in
`android/app/src/main/java/com/rokelapdf/app/` (`IncomingFilePlugin.java`) and the intent filters in
`AndroidManifest.xml`. App ID `com.rokelapdf.app`, minimum Android 7.0 (API 24), target API 36.
