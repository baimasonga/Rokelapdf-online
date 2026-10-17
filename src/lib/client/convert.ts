'use client';
import { api, apiSendFile } from './api';

// Office conversions run on the server (see src/lib/server/convert.ts): the file is sent once, the converted file
// comes back in the same response, and nothing is kept.

let enabled: Promise<boolean> | undefined;
/** Whether the server has a converter configured (public config, cached for the page's lifetime). */
export function convertEnabled(): Promise<boolean> {
  enabled ??= api<{ convert?: boolean }>('/api/v1/config', { auth: false }).then(
    (c) => !!c.convert,
    () => {
      enabled = undefined;
      return false;
    },
  );
  return enabled;
}

export function convertOnServer(target: 'docx' | 'xlsx' | 'pptx' | 'pdf', file: File): Promise<Blob> {
  return apiSendFile(`/api/v1/convert/${target}?name=${encodeURIComponent(file.name.slice(0, 255))}`, file);
}
