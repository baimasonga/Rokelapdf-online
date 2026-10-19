import { container } from '@/lib/server/container';
import { publicRedirect } from '@/lib/server/api/redirects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Clean public short URLs; /l/:code remains available for previously shared URLs. */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return publicRedirect(container(), req, 'public', (await params).code);
}
