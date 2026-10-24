# Rokela PDF for Android

A small Android app built with [Capacitor](https://capacitorjs.com): a native shell around a Vite + React web layer.
Shared browser code is imported from the web app with the `@/` alias (`../src`).

## What it does (prototype, step 1)

| Feature            | Status | Notes                                                                                              |
| ------------------ | ------ | -------------------------------------------------------------------------------------------------- |
| Scan a document    | Ready  | Google ML Kit document scanner: edge detection, clean-up, gallery import, up to 50 pages, PDF out. |
| Open a PDF         | Ready  | File picker, plus "Open with" and "Share" from WhatsApp, Files, Gmail and other apps.              |
| View               | Ready  | pdf.js; pages render as they scroll into view.                                                     |
| Share              | Ready  | Android share sheet.                                                                               |
| Sign a PDF         | Next   | Step 2, on the device with the web app's signing tools.                                            |
| Word ⇄ PDF         | Next   | Step 2, through the existing converter service (needs internet and sign-in).                       |
| Play Store release | Later  | Step 3: needs a Play developer account, a 512 px icon and a release signing key.                   |

Files received from other apps are read only from `content://` URIs the sender granted, are capped at 50 MB, and must
start with `%PDF`. The app asks for no storage or camera permission: the scanner runs in Google Play services.

## Getting a test build

Every pull request and push that touches `mobile/` runs the **Android** workflow, which uploads `app-debug.apk` as the
`rokela-pdf-debug-apk` artifact (kept 30 days). Download it on the phone, unzip, open the APK and allow installs from
that source when Android asks. Debug builds are signed with a throwaway key, so uninstall one before installing a
Play Store build later.

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
