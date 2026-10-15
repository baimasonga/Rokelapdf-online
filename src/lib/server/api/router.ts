import { ZodError, type z } from 'zod';
import { DomainError, type UserPrincipal } from '../kernel';
import { authenticate } from '../auth';
import type { Container } from '../container';
import type { PublicContext } from '../sharing';

// A small, explicit router: every route is listed once with its method, path pattern, auth mode and handler.
// Unknown request fields are rejected by strict zod schemas; errors never echo submitted values.

export interface Ctx {
  c: Container;
  req: Request;
  params: Record<string, string>;
  query: URLSearchParams;
  ip: string;
  /** Parsed JSON body (lazy). */
  body(): Promise<unknown>;
  /** Required session (route mode 'user' guarantees it). */
  user: UserPrincipal | undefined;
  /** Facts for public endpoints: optional principal, user agent and referrer. */
  publicCtx(): Promise<PublicContext>;
}
type Handler = (ctx: Ctx) => Promise<unknown>;
type Mode = 'user' | 'public' | 'operator';
interface Route {
  method: string;
  parts: string[];
  mode: Mode;
  handler: Handler;
  /** Per-IP limit per minute for public routes (defaults to config). */
  limit?: number;
}

export class Router {
  readonly routes: Route[] = [];
  add(method: string, path: string, mode: Mode, handler: Handler, limit?: number) {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), mode, handler, ...(limit ? { limit } : {}) });
    return this;
  }
  #match(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
    const segs = path.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length && ok; i++) {
        const p = r.parts[i]!;
        if (p.startsWith(':')) {
          try {
            params[p.slice(1)] = decodeURIComponent(segs[i]!);
          } catch {
            ok = false;
          }
        } else ok = p === segs[i];
      }
      if (ok) return { route: r, params };
    }
    return undefined;
  }

  async handle(c: Container, req: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(req.url);
    try {
      const m = this.#match(req.method, url.pathname);
      if (!m) throw new DomainError('not_found', 'not found');
      const ip = clientIp(req, c.config.trustProxy);
      if (m.route.mode === 'public' && !(await c.rateLimiter.hit(`ip:${ip}:${m.route.parts.slice(0, 4).join('/')}`, m.route.limit ?? c.config.rateLimitPerMinute)))
        throw new DomainError('rate_limited', 'rate limit exceeded');
      let user: UserPrincipal | undefined;
      if (m.route.mode !== 'public') {
        user = await authenticate(c.verifier, req.headers.get('authorization'));
        await c.workspaces.sync(user);
        if (m.route.mode === 'operator' && !(await c.workspaces.isOperator(user.userId)))
          throw new DomainError('forbidden', 'insufficient permissions');
      }
      let bodyCache: Promise<unknown> | undefined;
      const ctx: Ctx = {
        c,
        req,
        params: m.params,
        query: url.searchParams,
        ip,
        user,
        body: () => (bodyCache ??= readJson(req)),
        publicCtx: async () => {
          let principal: UserPrincipal | undefined;
          // Optional session: a presented token must be valid; no token means anonymous (fewer rights).
          if (req.headers.get('authorization')) {
            principal = await authenticate(c.verifier, req.headers.get('authorization'));
            await c.workspaces.sync(principal);
          }
          const h = (n: string) => req.headers.get(n)?.slice(0, 1024) ?? undefined;
          return { principal: principal ? { ...principal } : undefined, userAgent: h('user-agent'), referer: h('referer') };
        },
      };
      const out = await m.route.handler(ctx);
      if (out instanceof Response) return withHeaders(out, requestId);
      return withHeaders(json(out === undefined ? null : toWire(out)), requestId);
    } catch (e) {
      return withHeaders(errorResponse(e, requestId), requestId);
    }
  }
}

/** A 201 response for handlers that create a resource. */
export const created = (body: unknown) => json(toWire(body), 201);

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > 64 * 1024) throw new DomainError('invalid_request', 'request body too large');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError('invalid_request', 'invalid JSON');
  }
}

export function clientIp(req: Request, trustProxy: boolean): string {
  // Behind Railway's proxy the left-most X-Forwarded-For entry is the client; otherwise do not trust the header.
  const xff = trustProxy ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() : undefined;
  return (xff || req.headers.get('x-real-ip') || 'unknown').slice(0, 64);
}

export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw zodError(r.error);
  return r.data;
}
function zodError(e: ZodError) {
  const issues = e.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(body)'}: ${i.code}`);
  return new DomainError('invalid_request', 'request validation failed', { issues });
}

const snake = (s: string) => s.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
/** Domain objects are camelCase; the wire format is snake_case. */
export function toWire(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(toWire);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [snake(k), toWire(x)]));
  return v;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function errorResponse(e: unknown, requestId: string): Response {
  if (e instanceof DomainError)
    return json({ code: e.code, message: e.message, request_id: requestId, ...(e.details ? { details: e.details } : {}) }, e.status);
  if (e instanceof ZodError) {
    const d = zodError(e);
    return json({ code: d.code, message: d.message, request_id: requestId, details: d.details }, 400);
  }
  console.error(JSON.stringify({ level: 'error', msg: 'unhandled error', request_id: requestId, name: (e as Error)?.name, message: (e as Error)?.message }));
  return json({ code: 'internal', message: 'internal error', request_id: requestId }, 500);
}

function withHeaders(res: Response, requestId: string): Response {
  const h = new Headers(res.headers);
  h.set('x-request-id', requestId);
  h.set('cache-control', 'no-store');
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'no-referrer');
  return new Response(res.body, { status: res.status, headers: h });
}
