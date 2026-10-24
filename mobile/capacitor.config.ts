import type { CapacitorConfig } from '@capacitor/cli';

// The app ships its own copy of the interface (dist/), so scanning, viewing and signing work offline.
const config: CapacitorConfig = {
  appId: 'com.rokelapdf.app',
  appName: 'Rokela PDF',
  webDir: 'dist',
  android: { allowMixedContent: false },
};

export default config;
