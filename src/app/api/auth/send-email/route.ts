import { authEmailOptions, handleAuthEmail } from '@/lib/server/auth-email';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: Request) {
  try {
    return await handleAuthEmail(req, authEmailOptions());
  } catch {
    return Response.json(
      { error: { http_code: 503, message: 'Authentication email delivery unavailable' } },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
