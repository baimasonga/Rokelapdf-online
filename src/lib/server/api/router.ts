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
  /** Readable by Rokela PDF's own apps (see APP_ORIGINS). */
  app?: boolean;
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
  /** Lets Rokela PDF's apps call an already-listed route from their WebView (CORS for APP_ORIGINS only). */
  allowApp(method: string, path: string) {
    const parts = path.split('/').filter(Boolean);
    const route = this.routes.find((r) => r.method === method && r.parts.join('/') === parts.join('/'));
    if (!route) throw new Error(`allowApp: no route ${method} ${path}`);
    route.app = true;
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
    const origin = req.headers.get('origin');
    let cors: string | undefined;
    try {
      if (req.method === 'OPTIONS')
        return preflight(this.#match(req.headers.get('access-control-request-method') ?? '', url.pathname)?.route, origin, requestId);
      const m = this.#match(req.method, url.pathname);
      if (!m) throw new DomainError('not_found', 'not found');
      if (m.route.app) cors = appOrigin(origin) ?? '';
      const ip = clientIp(req, c.config.trustProxy);
      if (
        m.route.mode === 'public' &&
        !(await c.rateLimiter.hit(`ip:${ip}:${m.route.parts.slice(0, 4).join('/')}`, m.route.limit ?? c.config.rateLimitPerMinute))
      )
        throw new DomainError('rate_limited', 'rate limit exceeded');
      let user: UserPrincipal | undefined;
      if (m.route.mode !== 'public') {
        user = await authenticate(c.verifier, req.headers.get('authorization'));
        await c.workspaces.sync(user);
        if (m.route.mode === 'operator' && !(await c.workspaces.isOperator(user.userId))) throw new DomainError('forbidden', 'insufficient permissions');
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
      if (out instanceof Response) return withHeaders(out, requestId, cors);
      return withHeaders(json(out === undefined ? null : toWire(out)), requestId, cors);
    } catch (e) {
      return withHeaders(errorResponse(e, requestId), requestId, cors);
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

export function clientIp(req: Request, trustedProxies: number): string {
  // Each trusted proxy appends the address it received the request from, so the client is the entry that many places
  // from the right. Entries further left were supplied by the client and are never used. Without a trusted proxy no
  // forwarding header is believed and every caller shares one bucket.
  if (trustedProxies < 1) return 'unknown';
  const hops = (req.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return (hops[hops.length - trustedProxies] ?? 'unknown').slice(0, 64);
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
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [snake(k), toWire(x)]));
  return v;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function errorResponse(e: unknown, requestId: string): Response {
  if (e instanceof DomainError)
    return json({ code: e.code, message: e.message, request_id: requestId, ...(e.details ? { details: e.details } : {}) }, e.status);
  // Also a ZodError from another bundle's copy of zod (see DomainError).
  if (e instanceof ZodError || (e instanceof Error && e.name === 'ZodError' && Array.isArray((e as ZodError).issues))) {
    const d = zodError(e as ZodError);
    return json({ code: d.code, message: d.message, request_id: requestId, details: d.details }, 400);
  }
  console.error(JSON.stringify({ level: 'error', msg: 'unhandled error', request_id: requestId, name: (e as Error)?.name, message: (e as Error)?.message }));
  return json({ code: 'internal', message: 'internal error', request_id: requestId }, 500);
}

/**
 * Origins of Rokela PDF's own apps: Capacitor serves the Android app's pages from https://localhost inside its
 * WebView. The API authenticates with bearer tokens and never cookies, so allowing an origin gives it no ambient
 * authority; it only lets the app read responses to requests it could already send. Only routes marked with
 * `allowApp` answer cross-origin, and no other origin is ever allowed.
 */
export const APP_ORIGINS: readonly string[] = ['https://localhost'];
const appOrigin = (origin: string | null) => (origin && APP_ORIGINS.includes(origin) ? origin : undefined);

/** CORS preflight: allowed only for an app origin asking about an app route; anything else is an empty 404. */
function preflight(route: Route | undefined, origin: string | null, requestId: string): Response {
  const allowed = route?.app ? appOrigin(origin) : undefined;
  if (!allowed) return withHeaders(new Response(null, { status: 404 }), requestId, route?.app ? '' : undefined);
  const res = new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-methods': route!.method,
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '600',
    },
  });
  return withHeaders(res, requestId, allowed);
}

/** `cors`: undefined for routes apps cannot use, '' for an app route requested from another origin. */
function withHeaders(res: Response, requestId: string, cors?: string): Response {
  const h = new Headers(res.headers);
  if (cors !== undefined) h.append('vary', 'origin');
  if (cors) {
    h.set('access-control-allow-origin', cors);
    h.set('access-control-expose-headers', 'content-disposition, x-request-id');
  }
  h.set('x-request-id', requestId);
  h.set('cache-control', 'no-store');
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'no-referrer');
  return new Response(res.body, { status: res.status, headers: h });
}
