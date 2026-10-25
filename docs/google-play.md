# Publishing Rokela PDF on Google Play

The website keeps offering the test APK (`rokelapdf.com/android`); Google Play gets a release build: an Android App
Bundle (`.aab`) signed with the **upload key**. Google Play re-signs what it delivers with its own app signing key
(Play App Signing), so a lost upload key can be replaced through Play Console support; it cannot be replaced by
anyone who does not control the Play Console account.

App ID: `com.rokelapdf.app`. Version code: the Android workflow's run number, so every build is higher than the last.

## 1. The upload key (once)

The upload key is a PKCS12 keystore (`rokela-upload.jks`, alias `rokela-upload`, RSA 4096, valid 10,000 days). It is
never committed (`*.jks` is ignored). Keep the keystore and its password together in a password manager or another
safe place outside GitHub.

To make a new one: `keytool -genkeypair -storetype PKCS12 -keystore rokela-upload.jks -alias rokela-upload -keyalg RSA
-keysize 4096 -validity 10000` (store and key password are the same for PKCS12).

In GitHub: **Settings → Secrets and variables → Actions → New repository secret**, four secrets:

| Secret                             | Value                                                   |
| ---------------------------------- | ------------------------------------------------------- |
| `ANDROID_UPLOAD_KEYSTORE_BASE64`   | the keystore as base64 (`base64 -w0 rokela-upload.jks`) |
| `ANDROID_UPLOAD_KEYSTORE_PASSWORD` | the keystore password                                   |
| `ANDROID_UPLOAD_KEY_ALIAS`         | `rokela-upload`                                         |
| `ANDROID_UPLOAD_KEY_PASSWORD`      | the same password                                       |

## 2. Getting a bundle

Every run of the **Android** workflow builds the release bundle (`./gradlew bundleRelease`). With the secrets set, it
is signed and kept for 30 days as the `rokela-pdf-google-play-aab` artifact of the run: **Actions → Android → the run →
Artifacts**. Unzip it to get `app-release.aab`. To make one on demand: **Actions → Android → Run workflow**.

## 3. Play Console checklist

1. **Create app**: name _Rokela PDF_, default language English (United Kingdom), app, free.
2. **App signing**: accept Play App Signing (Google generates the app signing key) and upload the first
   `app-release.aab`; the key it was signed with becomes the upload key.
3. **Store listing**: the text below and the images from `node tools/store/render.mjs` (in `mobile/`, after
   `node tools/ads/capture.mjs`), written to `mobile/ads-out/store/`:
   - App icon: `icon-512.png` (512 × 512)
   - Feature graphic: `feature-graphic-1024x500.png`
   - Phone screenshots: `phone-1-home.png` … `phone-8-compress.png` (1080 × 1920)
4. **App content**:
   - Privacy policy: `https://www.rokelapdf.com/privacy`
   - Ads: no ads.
   - App access: some features need an account; give the reviewers a test account (an email and password on
     rokelapdf.com, with a licence granted by `npm run license:grant`, so every tool can be reviewed).
   - Content rating: questionnaire; a utility with no user-generated public content, no violence, no gambling.
   - Target audience: 18 and over (business documents).
   - Data safety: see below.
5. **Testing**: personal developer accounts must run a closed test with at least 12 testers for 14 days before
   production; organisation accounts can go straight to production.
6. **Production release**: upload the `.aab`, write release notes, choose countries (include Sierra Leone), send for
   review.

### Data safety answers

- **Collected**: email address (account sign-in, optional; used for the account and licences); files the person
  chooses to convert to or from Word, Excel or PowerPoint (sent to rokelapdf.com for that conversion, deleted right
  after, not shared).
- **Not collected**: location, contacts, photos outside files the person picks, device identifiers; no analytics or
  advertising SDKs.
- Data is encrypted in transit (HTTPS). People can ask for their account to be deleted at contact@quantixsl.com.
- Scanning, viewing, editing, signing, splitting, merging, compressing and protecting happen on the phone; those files
  are not uploaded.

### Paid tools on Google Play

Google Play requires purchases that unlock features in an app to use Google Play Billing, and does not allow linking or
pointing people to another way to pay. Before the first Play release, the Play build must not show the "Email
contact@quantixsl.com" licence instructions or prices; it can say that the tool needs a Pro licence and let people
sign in with a licence they already have.

## Store listing text

**App name** (30 characters max): `Rokela PDF: Scan, Edit & Sign`

**Short description** (80 characters max):

> Scan, edit, sign, split and convert PDFs on your phone. Works offline.

**Full description** (4,000 characters max):

> Rokela PDF puts the PDF tools you need for work and school on your Android phone.
>
> SCAN PAPER TO PDF
> Point your camera at a page: Rokela PDF finds the edges, straightens and cleans up the page, and saves a PDF. Put
> several pages in one PDF, and make scans searchable with text recognition.
>
> EDIT AND SIGN
> Add text, highlight, draw and cover up parts of any PDF. Sign with your finger; your signature stays on your phone.
> Fill in PDF forms.
>
> SPLIT, MERGE AND ORGANISE
> Split a PDF into one file per page, every few pages or page ranges, and share every part at once. Combine several
> PDFs into one. Reorder, rotate and delete pages. Turn photos into a PDF.
>
> COMPRESS AND PROTECT
> Make files smaller to send over WhatsApp or email, choosing the quality you need. Lock a PDF with a password and
> choose whether people may print, copy or change it.
>
> CONVERT
> Turn PDFs into Word, Excel and PowerPoint, and Office files back into PDF. Conversions need internet and a free
> rokelapdf.com account; the file is deleted straight after.
>
> WORKS OFFLINE, FILES STAY WITH YOU
> Scanning, editing, signing, splitting, merging, compressing and protecting all happen on your phone, with no
> internet needed. Open PDFs straight from WhatsApp, email or your files, and share the result in one tap.
>
> PRO TOOLS
> Editing, signing, text recognition, password protection, splitting and merging are Pro tools. Every new account
> gets them free for the first month; after that they need a yearly Pro licence, which also works on rokelapdf.com.
> Every other tool stays free.
>
> Made in Freetown by Quantix Sierra Leone.

**Category**: Productivity. **Contact email**: contact@quantixsl.com. **Website**: https://www.rokelapdf.com.
