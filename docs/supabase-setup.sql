-- One-time Supabase setup for Rokela PDF Pro Web. Run in the Supabase SQL editor (as `postgres`).
--
-- Creates the least-privilege role the web app connects as. It owns nothing; the schema and tables are created by
-- `npm run deploy:prepare` (migrations, then grants) using the `postgres` connection.
-- Choose a long random password (e.g. `openssl rand -base64 32`) and keep it in Railway's variables only.

CREATE ROLE rokela_app LOGIN NOINHERIT;
ALTER ROLE rokela_app PASSWORD 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';

-- Statement timeout keeps a stuck request from holding connections.
ALTER ROLE rokela_app SET statement_timeout = '15s';

-- The app's schema (`rokela`) is NOT in Supabase's exposed schemas (Settings → API → Exposed schemas keeps only
-- `public`), so the auto-generated Data API cannot read it. `db:grants` also revokes it from `anon` and
-- `authenticated`. Nothing needs to be created in `public`.
