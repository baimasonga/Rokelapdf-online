import { container } from '@/lib/server/container';
import { publicRedirect } from '@/lib/server/api/redirects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Confidential short link: 302 to its share or upload-request page, whose own access policy then applies. */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return publicRedirect(container(), req, 'confidential', (await params).code);
}
