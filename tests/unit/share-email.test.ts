import { expect, it } from 'vitest';
import { shareEmailHtml } from '@/lib/server/share-email';

it('escapes sender content and preserves message lines without allowing HTML injection', () => {
  const html = shareEmailHtml({
    from: 'sender@example.com',
    title: '<img src=x onerror=alert(1)>',
    message: 'Hello\n<script>bad()</script>',
    url: 'https://www.rokelapdf.com/s/test',
    origin: 'https://www.rokelapdf.com',
    expiresAt: new Date('2026-10-26T00:00:00Z'),
    password: true,
    reminder: false,
  });
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img src=x');
  expect(html).toContain('Hello<br>&lt;script&gt;');
  expect(html).toContain('View and download files');
  expect(html).toContain('https://www.rokelapdf.com/s/test');
  expect(html).toContain('26 Oct 2026');
  expect(html).toContain('password protected');
});
