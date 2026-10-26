// Where the Android app is published. The Android workflow replaces the APK on the fixed "android" GitHub release
// after every change on the default branch, so these links never change.
export const ANDROID_PAGE = 'https://www.rokelapdf.com/android';
/** The release asset on GitHub: where the APK actually lives. */
export const ANDROID_APK_SOURCE = 'https://github.com/baimasonga/Rokelapdf-online/releases/download/android/rokela-pdf.apk';
/**
 * The download link people use: rokelapdf.com serves the APK itself (src/app/android/rokela-pdf.apk/route.ts), for
 * networks that cannot reach GitHub's file servers.
 */
export const ANDROID_APK = '/android/rokela-pdf.apk';
