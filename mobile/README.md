# Rokela PDF for Android

A small Android app built with [Capacitor](https://capacitorjs.com): a native shell around a Vite + React web layer.
Shared browser code is imported from the web app with the `@/` alias (`../src`).

## What it does

| Feature                                       | Where it runs | Notes                                                                                            |
| --------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------ |
| Scan a document                               | Phone         | Google ML Kit document scanner: edge detection, clean-up, gallery import, up to 50 pages.        |
| Open, view, save, share                       | Phone         | "Open with"/"Share" from other apps; Save uses Android's Save-to dialog (no storage permission). |
| Sign                                          | Phone         | Draw or type a signature, place, drag and resize.                                                |
| Edit                                          | Phone         | Add text, highlight, draw, cover (white-out) and pictures. Cover + text replaces words.          |
| Pages                                         | Phone         | Reorder, rotate, delete, add pages from another PDF.                                             |
| Combine PDFs, Photos → PDF                    | Phone         |                                                                                                  |
| Compress                                      | Phone         | Light / Recommended / Strong; never returns a bigger file.                                       |
| Protect / unlock                              | Phone         | AES-256 password; protected PDFs ask for the password when opened and open an unlocked copy.     |
| Make text searchable (OCR)                    | Phone         | Tesseract (English) bundled in the app; pages that already have text are skipped.                |
| Fill in a form                                | Phone         | Text, checkbox, list and radio fields; optional "lock the answers" (flatten).                    |
| PDF → Word / Excel / PowerPoint, Office → PDF | rokelapdf.com | Needs internet and a signed-in account with a confirmed email.                                   |
| Play Store release                            |               | Later: needs a Play developer account, a 512 px icon and a release signing key.                  |

The tools are the website's own (`src/lib/tools`, `src/lib/editor`, `src/lib/client/{ocr,raster}.ts`), shared through the
`@/` alias; `src/pdfjs-shim.ts` stands in for the website's pdf.js loader. `npm run build` first copies pdf.js data and the
OCR engine into `public/` (`tools/copy-assets.mjs`, not committed). `npm run smoke` drives every tool in a phone-sized
browser and checks each saved PDF (CI runs it before building the APK).

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

## Video adverts

`npm run ads` makes three adverts from the real app: a 30 s and a 15 s vertical video (1080×1920, for TikTok, Reels and
WhatsApp Status) and a 30 s 16:9 video (1920×1080, for YouTube and Facebook). It needs ffmpeg on the PATH and takes about
15 minutes. The MP4s land in `ads-out/` (not committed).

Sound is optional, and neither file is committed (music licences allow use in a video, not redistributing the file):

```sh
ADS_MUSIC=~/music.mp3 ADS_VOICE=~/voices/en_GB-cori-high.onnx npm run ads
```

- `ADS_MUSIC`: background music, faded in and out, and lowered by about 13 dB while the voice speaks.
- `ADS_VOICE`: a [Piper](https://github.com/rhasspy/piper) voice (`pip install piper-tts`; voices at
  <https://huggingface.co/rhasspy/piper-voices>) that reads each scene's `vo` line. Set `PIPER` if the `piper` command is
  not on the PATH. A scene stretches when its line needs longer. Check a voice's licence before using it in an ad: Cori
  (`en_GB-cori-high`) is public domain, while several others are for non-commercial use only.

Without either, the adverts are silent and music can be added on the platform. The mix is levelled to -14 LUFS, the
loudness TikTok, Instagram and YouTube play at.

- `tools/ads/capture.mjs` builds sample documents, drives the app through each feature in a phone-sized browser and
  screenshots it, recording where each tap lands.
- `tools/ads/ad.html` lays out the phone, captions and tap marks; every frame is a function of time, set by `render(t)`.
  The scenes, their captions, voiceover lines (`vo`) and timings are the `FULL` and `SHORT` lists in it. Keep `SHORT`
  within 15 s, the limit of an Instagram story.
- `tools/ads/render.mjs` speaks the lines, fits the scenes to them, renders every frame, encodes it with ffmpeg and mixes
  the sound. `node tools/ads/render.mjs 1080 1920 short test`
  re-renders one advert without capturing again.

Re-run it after changing the app's look so the adverts show the current version.

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

## Basic usage reporting

Native Android builds report app opens and home-screen tool selections to Warrior's
fixed `/v1/mobile/rokela-pdf/events` endpoint. **Usage privacy → Share basic app usage**
on the home screen disables reporting and clears unsent events. Reports contain a
random installation ID, app version, Android major version and phone/tablet class;
no document content, filename, account ID, advertising ID or GPS is sent. Warrior
hashes the installation ID and retains reports for 30 days. Country is inferred
server-side from IP only when trusted ingress and a local country database are
configured; otherwise it remains unknown. The client does not request location access.

The offline queue holds at most 100 events for seven days and sends at most 20 per
batch, with stable IDs for retries. A five-second timeout and backoff keep failures
independent of document tools. These are unverified usage assertions, not installation
verification or completed-tool results. Browser preview builds do not send reports.

Run `npm run test:analytics` in `mobile/` for queue, retry, privacy and acknowledgement
checks. The Android release workflow runs these before building the APK. Existing
installed APKs require an update to start reporting.
