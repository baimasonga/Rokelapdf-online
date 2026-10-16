// A minimal stand-in for Supabase Auth (GoTrue) for local end-to-end tests only: sign-up (auto-confirmed),
// password sign-in, refresh, sign-out and GET /auth/v1/user. Never used outside tests.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

export function startFakeSupabase(port) {
  const users = new Map(); // email -> { id, email, password, created_at }
  const tokens = new Map(); // access token -> email
  const refresh = new Map(); // refresh token -> email
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const session = (u) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: u.id, email: u.email, exp, aud: 'authenticated', role: 'authenticated' })}.${randomBytes(16).toString('base64url')}`;
    const rt = randomBytes(16).toString('hex');
    tokens.set(access, u.email);
    refresh.set(rt, u.email);
    return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: rt, user: view(u) };
  };
  const view = (u) => ({
    id: u.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: u.email,
    email_confirmed_at: u.created_at,
    app_metadata: { provider: 'email' },
    user_metadata: {},
    identities: [],
    created_at: u.created_at,
    updated_at: u.created_at,
  });
  const server = createServer(async (req, res) => {
    const cors = {
      'access-control-allow-origin': req.headers.origin ?? '*',
      'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    };
    const send = (status, body) => {
      res.writeHead(status, { ...cors, 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return send(204);
    const url = new URL(req.url, 'http://x');
    let body = {};
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
    }
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (url.pathname === '/auth/v1/signup' && req.method === 'POST') {
      const email = String(body.email).toLowerCase();
      if (users.has(email)) return send(422, { code: 'user_already_exists', msg: 'User already registered' });
      const u = { id: randomUUID(), email, password: body.password, created_at: new Date().toISOString() };
      users.set(email, u);
      return send(200, session(u));
    }
    if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
      if (url.searchParams.get('grant_type') === 'password') {
        const u = users.get(String(body.email).toLowerCase());
        if (!u || u.password !== body.password) return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        return send(200, session(u));
      }
      const email = refresh.get(body.refresh_token);
      if (!email) return send(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
      return send(200, session(users.get(email)));
    }
    if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
      const email = tokens.get(bearer);
      return email ? send(200, view(users.get(email))) : send(401, { code: 'bad_jwt', msg: 'invalid JWT' });
    }
    if (url.pathname === '/auth/v1/logout') {
      tokens.delete(bearer);
      return send(204);
    }
    send(404, { msg: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
