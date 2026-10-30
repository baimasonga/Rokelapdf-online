# Rokela PDF Pro Web

Browser PDF editor and 30 PDF tools — 24 private, in-browser tools (including OCR) and Office conversion (PDF ↔ Word,
Excel, PowerPoint) for signed-in users — with integrated file sharing and link shortening.

- **Hosting:** Railway (Next.js app + background worker, and the private Office converter in [`converter/`](converter/README.md)),
  Supabase (Auth + PostgreSQL), Cloudflare R2 (private file storage).
- **Stack:** Next.js 16 (App Router) + TypeScript, `pg`, `zod`, `pdf-lib`, `pdfjs-dist`, `@supabase/supabase-js`.

## Architecture in one paragraph

Supabase Auth issues sessions; the browser sends `Authorization: Bearer <access token>` to the Next.js API
(no cookies, so no CSRF surface). The server verifies the token with Supabase, then does **all** data access
itself with application-level authorization. Data lives in a private Postgres schema (`rokela`, not exposed
through the Supabase Data API) accessed by a least-privilege role. Files never pass through the app: uploads
and downloads use short-lived signed URLs directly against R2.

## Documentation

- [Architecture](docs/architecture.md) — components, identity, data, documents/links, file flow, editor
- [Deploying on Supabase + Cloudflare R2 + Railway](docs/deploy.md) — step by step, with a first-deploy checklist
- [Security model](docs/security.md) — trust boundaries, controls, honest limits, retention
- [Cost model and phased plan](docs/plan.md)
- [Verified documents](docs/verified-documents.md) and [receipt processing](docs/receipt-processing.md) (university fee clearance)

## Development

```bash
npm install
npm test            # unit + API tests against a throwaway PostgreSQL 16 cluster (or DATABASE_URL)
npm run test:approle  # same suite as the least-privilege app role
npm run typecheck
npm run dev         # needs DATABASE_URL; uses local file storage on :3001 in development
npm run build && npm run e2e   # browser end-to-end smoke test (Chromium) against the production build
npm run check       # format, lint, typecheck, tests — run before pushing
(cd converter && python3 -m unittest -v)   # Office converter tests (needs LibreOffice + converter/requirements.txt)
```

Production refuses to start on weak or missing configuration (`src/lib/server/config.ts`): R2 storage,
a strong `SHARING_SECRET`, HTTPS origins, Supabase settings and ClamAV (or an explicit opt-out) are required.
