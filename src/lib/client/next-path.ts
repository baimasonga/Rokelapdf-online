/** Only same-site relative paths may be used as a post-sign-in destination (no open redirect). */
export function safeNext(raw: string | null | undefined, fallback = '/app'): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || /[\u0000-\u001f]/.test(raw)) return fallback;
  return raw;
}
