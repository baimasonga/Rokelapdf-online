import { container } from '@/lib/server/container';
import { buildRouter } from '@/lib/server/api/routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const router = buildRouter();
const handle = (req: Request) => router.handle(container(), req);
export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE, handle as OPTIONS };
