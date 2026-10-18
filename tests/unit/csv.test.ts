import { describe, expect, it } from 'vitest';
import { csvText } from '@/lib/client/csv';
describe('CSV exports', () => {
  it('escapes quoted fields and prevents formula execution including whitespace prefixes', () => {
    expect(csvText([['a,"b', '=HYPERLINK("https://bad")', '  +42', '@cmd', '-1', 'safe', null]])).toBe(
      '"a,""b","\'=HYPERLINK(""https://bad"")","\'  +42","\'@cmd","\'-1","safe",""\r\n',
    );
  });
});
