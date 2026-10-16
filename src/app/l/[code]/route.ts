import { container } from '@/lib/server/container';
import { publicRedirect } from '@/lib/server/api/redirects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public short link: 302 to its destination, or to the unlock page when a password or sign-in is required. */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return publicRedirect(container(), req, 'public', (await params).code);
}
