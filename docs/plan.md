# Cost model and phased plan

## Monthly cost (approximate list prices — check current pricing before budgeting)

| Item                         | Pilot / small                                             | Growing                                                                |
| ---------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| Railway — app (0.5–1 GB RAM) | Hobby plan, ~$5–10                                        | Pro plan, ~$20 + usage; add a replica when needed                      |
| Railway — ClamAV (~2 GB RAM) | optional at first (`MALWARE_SCAN_DISABLED=true`), ~$10–20 | recommended before opening sign-ups widely                             |
| Supabase                     | Free (pauses when idle — not for production)              | Pro, $25 (8 GB database, 100k monthly active users included)           |
| Cloudflare R2                | free tier: 10 GB-month, 1M writes, 10M reads              | $0.015 per GB-month; writes $4.50/M, reads $0.36/M; **no egress fees** |
| Email (SMTP provider)        | free tiers usually suffice                                | ~$10–20                                                                |

Sharing drives storage and requests rather than bandwidth: R2 has no egress fees, so downloads by recipients cost
read operations only. Plan entitlements (`docs/deploy.md` §4) bound each workspace's storage, file size, retention,
bandwidth estimate and API changes, so a free account cannot create unbounded cost.

## Phases

**Phase 1 — this build**

- Supabase accounts; personal and team workspaces with roles.
- Browser PDF editor: text, highlight, box, freehand, whiteout; rotate/reorder/delete/merge/blank pages; undo/redo;
  download or save as a private draft.
- Documents: draft → export immutable versions → explicit publish (optional approval); review/comment/approve links.
- Transfers with resumable direct-to-R2 file and folder uploads, replace-in-place, temporary or persistent.
- Share links: permissions, password, expiry, download limits, recipients, suspend/revoke, receipts, activity.
- Short links: public (alias, editable destination with history, folders/tags/search/bulk, aggregate stats) and
  confidential; QR codes.
- Upload requests with checklists and deadlines; in-app notifications.
- Operator tooling: abuse reports, holds, audited plan changes. CI, browser end-to-end test, Railway config.

**Phase 2 — next**

- Email notifications (the sharing service has a mailer port; wire an SMTP/Resend adapter).
- Billing (e.g. Stripe) driving `org_plans` instead of the operator command.
- Branding and custom domains in the UI (the API and data model already exist).
- Editor: Unicode fonts (embed a font for non-Latin text), signatures, form filling, true redaction.
- Admin UI for abuse reports (API exists).

**Phase 3 — later**

- E-signature workflows, page-anchored review comments, OCR, organization SSO, data export and audit log viewer.
