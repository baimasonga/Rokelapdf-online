# Paid tools and licences

Some tools are paid, on the website and in the Android app alike: **editing, signing, text recognition (OCR),
password protection, splitting and merging**. Every other tool stays free and needs no account. The list, and which
website tools and app tools belong to each, is in [`src/lib/licensing.ts`](../src/lib/licensing.ts).

- **Licence**: one per person, tied to their email address, for one year. Operators grant it after payment.
- **Free month**: every account can use the paid tools for 30 days from its first sign-in (or from the launch date, for
  accounts that signed in before it). It needs no action.
- **Confirmed email**: both the licence and the free month need a confirmed email, so nobody can sign up with someone
  else's address and use their licence.

## Launch date

Nothing is locked until `PAID_FEATURES_FROM` is set to a date (`2026-12-01`, midnight UTC). Before that date, and while
it is unset, every tool is free for everyone. On that date the locks switch on everywhere at once, website and app,
with no app update: the app asks the server.

Set it in Railway (and any Cloudflare backup) and redeploy. The pre-deploy step (`npm run deploy:prepare`) refuses a
value it cannot read, so a typo fails the deploy instead of locking or unlocking anything.

## Granting a licence

Licences are changed only by operators, from a machine with the owner connection (`DATABASE_MIGRATE_URL`), like plans.
Each change needs a reason and is written to the audit log.

```sh
npm run license:grant  -- --email person@example.com --by ops@example.com --reason "Orange Money ref 12345"
npm run license:grant  -- --email person@example.com --years 2 --by ops@example.com --reason "two years"
npm run license:show   -- --email person@example.com
npm run license:revoke -- --email person@example.com --by ops@example.com --reason "refunded"
```

- The person need not have an account yet; the licence applies when they sign in with that email.
- Granting again renews: the years are added to the end of a licence that is still running, so paying early loses
  nothing. An expired licence starts again from today.
- Revoking ends the licence now and keeps the record.

## How the check works

`GET /api/v1/me/access` answers a signed-in person with `access` (`open`, `license`, `trial` or `none`), `until` and,
when there is no access, a `reason` (`trial_ended`, `license_ended`, `verify_email`). `GET /api/v1/config` includes
`paid_features_from`, so the website and app know before anyone signs in whether the tools are locked.

The app keeps the last answer until its `until` date, so a licensed person can keep working offline.

The paid tools run on the person's own device, so the locks are in the website and the app, not on the server. Someone
determined could get around them by modifying the app; only server-side work, such as Office conversion, can be fully
enforced.
