import { z } from 'zod';
import { DomainError } from '../kernel';
import * as s from './schemas';
import { ROLES } from '../workspaces';
import { Router, created, json, parse, type Ctx } from './router';

const date = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(v));
const dateOpt = (v: string | undefined) => (v === undefined ? undefined : new Date(v));
const teamBody = z.object({ name: z.string().min(1).max(200) }).strict();
const memberBody = z.object({ email: z.string().min(3).max(254), role: z.enum(ROLES) }).strict();

/**
 * Every API route. Workspace routes are session-authenticated and the services authorize membership and role;
 * public routes are rate-limited per IP and re-evaluate link state on every request; operator routes require the
 * operator flag (set only by deployment tooling).
 */
export function buildRouter(): Router {
  const r = new Router();
  const me = (x: Ctx) => x.user!;
  const org = (x: Ctx) => parse(s.sharingOrgParams, x.params).orgId;
  const ids = (x: Ctx) => parse(s.idParams, x.params);
  const sh = (x: Ctx) => x.c.sharing;
  const P = '/api/v1/workspaces/:orgId/sharing';

  // Public, non-secret client configuration (read at runtime, not baked into the build).
  r.add(
    'GET',
    '/api/v1/config',
    'public',
    async (x) => ({ supabaseUrl: x.c.config.supabaseUrl, supabasePublishableKey: x.c.config.supabasePublishableKey }),
    600,
  );

  // ---- account and workspaces ------------------------------------------------------------------------
  r.add('GET', '/api/v1/me', 'user', async (x) => ({
    user: { id: me(x).userId, email: me(x).email, emailVerified: me(x).emailVerified },
    workspaces: await x.c.workspaces.list(me(x)),
  }));
  r.add('POST', '/api/v1/workspaces', 'user', async (x) => created(await x.c.workspaces.createTeam(me(x), parse(teamBody, await x.body()).name)));
  r.add('GET', '/api/v1/workspaces/:orgId/members', 'user', async (x) => ({ items: await x.c.workspaces.members(me(x), org(x)) }));
  r.add('POST', '/api/v1/workspaces/:orgId/members', 'user', async (x) => {
    const b = parse(memberBody, await x.body());
    return created(await x.c.workspaces.addMember(me(x), org(x), b.email, b.role));
  });

  // ---- overview and documents ------------------------------------------------------------------------
  r.add('GET', `${P}/overview`, 'user', async (x) => sh(x).overview(me(x), org(x)));
  r.add('GET', `${P}/documents`, 'user', async (x) => ({ items: await sh(x).listDocuments(me(x), org(x)) }));
  r.add('POST', `${P}/documents`, 'user', async (x) => {
    const b = parse(s.documentBody, await x.body());
    return created(await sh(x).createDocument(me(x), org(x), { title: b.title, requireApproval: b.require_approval }));
  });
  r.add('GET', `${P}/documents/:id`, 'user', async (x) => sh(x).getDocument(me(x), ids(x).orgId, ids(x).id));
  r.add('POST', `${P}/documents/:id/export`, 'user', async (x) => {
    const b = parse(s.exportBody, await x.body());
    return created(await sh(x).exportVersion(me(x), ids(x).orgId, ids(x).id, { note: b.note, fileName: b.file_name }));
  });
  r.add('POST', `${P}/documents/:id/publish`, 'user', async (x) => {
    const b = parse(s.publishBody, await x.body());
    return sh(x).publishVersion(me(x), ids(x).orgId, ids(x).id, { versionId: b.version_id, replacementNote: b.replacement_note });
  });
  r.add('POST', `${P}/documents/:id/delete`, 'user', async (x) => {
    parse(s.emptyBody, await x.body());
    return sh(x).deleteDocument(me(x), ids(x).orgId, ids(x).id);
  });
  r.add('GET', `${P}/documents/:id/versions/:versionId/review`, 'user', async (x) => {
    const p = parse(s.docVersionParams, x.params);
    return sh(x).reviewThread(me(x), p.orgId, p.id, p.versionId);
  });

  // ---- transfers --------------------------------------------------------------------------------------
  r.add('GET', `${P}/transfers`, 'user', async (x) => ({ items: await sh(x).listTransfers(me(x), org(x)) }));
  r.add('POST', `${P}/transfers`, 'user', async (x) => {
    const b = parse(s.transferBody, await x.body());
    return created(await sh(x).createTransfer(me(x), org(x), { title: b.title, message: b.message, kind: b.kind, expiresAt: date(b.expires_at) }));
  });
  r.add('GET', `${P}/transfers/:id`, 'user', async (x) => sh(x).getTransfer(me(x), ids(x).orgId, ids(x).id));
  r.add('PATCH', `${P}/transfers/:id`, 'user', async (x) => {
    const b = parse(s.transferPatchBody, await x.body());
    return sh(x).updateTransfer(me(x), ids(x).orgId, ids(x).id, { title: b.title, message: b.message, expiresAt: date(b.expires_at) });
  });
  r.add('POST', `${P}/transfers/:id/revoke`, 'user', async (x) =>
    sh(x).revokeTransfer(me(x), ids(x).orgId, ids(x).id, parse(s.optionalReasonBody, await x.body()).reason),
  );
  r.add('POST', `${P}/transfers/:id/delete`, 'user', async (x) => {
    parse(s.emptyBody, await x.body());
    return sh(x).deleteTransfer(me(x), ids(x).orgId, ids(x).id);
  });
  r.add('POST', `${P}/transfers/:id/files/:fileId/remove`, 'user', async (x) => {
    const p = parse(s.transferFileParams, x.params);
    parse(s.emptyBody, await x.body());
    return sh(x).removeTransferFile(me(x), p.orgId, p.id, p.fileId);
  });

  // ---- uploads ----------------------------------------------------------------------------------------
  r.add('POST', `${P}/uploads`, 'user', async (x) => {
    const b = parse(s.uploadBody, await x.body());
    return created(
      await sh(x).beginUpload(me(x), org(x), {
        target: b.target,
        transferId: b.transfer_id,
        fileId: b.file_id,
        documentId: b.document_id,
        name: b.name,
        folderPath: b.folder_path,
        size: b.size,
        note: b.note,
      }),
    );
  });
  r.add('POST', `${P}/uploads/:id/parts`, 'user', async (x) =>
    sh(x).signUploadParts(me(x), ids(x).orgId, ids(x).id, parse(s.partsBody, await x.body()).part_numbers),
  );
  r.add('GET', `${P}/uploads/:id`, 'user', async (x) => sh(x).uploadStatus(me(x), ids(x).orgId, ids(x).id));
  r.add('POST', `${P}/uploads/:id/complete`, 'user', async (x) => {
    parse(s.emptyBody, await x.body());
    return sh(x).completeUpload(me(x), ids(x).orgId, ids(x).id);
  });
  r.add('POST', `${P}/uploads/:id/abort`, 'user', async (x) => {
    parse(s.emptyBody, await x.body());
    return sh(x).abortUpload(me(x), ids(x).orgId, ids(x).id);
  });
  r.add('POST', `${P}/files/download`, 'user', async (x) => sh(x).ownerFileUrl(me(x), org(x), parse(s.ownerFileBody, await x.body())));

  // ---- share links ------------------------------------------------------------------------------------
  r.add('GET', `${P}/links`, 'user', async (x) => {
    const q = parse(s.linksQuery, Object.fromEntries(x.query));
    return { items: await sh(x).listLinks(me(x), org(x), { targetId: q.target_id }) };
  });
  r.add('POST', `${P}/links`, 'user', async (x) => {
    const b = parse(s.linkBody, await x.body());
    return created(
      await sh(x).createLink(me(x), org(x), {
        targetType: b.target_type,
        targetId: b.target_id,
        versionMode: b.version_mode,
        versionId: b.version_id,
        permission: b.permission,
        password: b.password,
        expiresAt: dateOpt(b.expires_at),
        maxDownloads: b.max_downloads,
        restriction: b.restriction,
        recipients: b.recipients,
        notifyOnAccess: b.notify_on_access,
        label: b.label,
      }),
    );
  });
  r.add('GET', `${P}/links/:id`, 'user', async (x) => sh(x).getLink(me(x), ids(x).orgId, ids(x).id));
  r.add('PATCH', `${P}/links/:id`, 'user', async (x) => {
    const b = parse(s.linkPatchBody, await x.body());
    return sh(x).updateLink(me(x), ids(x).orgId, ids(x).id, {
      label: b.label,
      expiresAt: date(b.expires_at),
      maxDownloads: b.max_downloads,
      password: b.password,
      restriction: b.restriction,
      recipients: b.recipients,
      notifyOnAccess: b.notify_on_access,
      permission: b.permission,
      versionId: b.version_id,
    });
  });
  r.add('POST', `${P}/links/:id/status`, 'user', async (x) => {
    const b = parse(s.statusBody, await x.body());
    return sh(x).setLinkStatus(me(x), ids(x).orgId, ids(x).id, b.action, b.reason);
  });
  r.add('GET', `${P}/links/:id/activity`, 'user', async (x) => sh(x).linkActivity(me(x), ids(x).orgId, ids(x).id));

  // ---- short links ------------------------------------------------------------------------------------
  r.add('GET', `${P}/short-links`, 'user', async (x) => ({
    items: await sh(x).listShortLinks(me(x), org(x), parse(s.shortLinksQuery, Object.fromEntries(x.query))),
  }));
  r.add('POST', `${P}/short-links`, 'user', async (x) => {
    const b = parse(s.shortLinkBody, await x.body());
    return created(
      await sh(x).createShortLink(me(x), org(x), {
        kind: b.kind,
        destinationType: b.destination_type,
        destinationUrl: b.destination_url,
        targetId: b.target_id,
        alias: b.alias,
        domainId: b.domain_id,
        expiresAt: dateOpt(b.expires_at),
        password: b.password,
        requireAuth: b.require_auth,
        label: b.label,
        folder: b.folder,
        tags: b.tags,
      }),
    );
  });
  r.add('POST', `${P}/short-links/bulk`, 'user', async (x) => sh(x).bulkShortLinks(me(x), org(x), parse(s.bulkBody, await x.body())));
  r.add('GET', `${P}/short-links/:id`, 'user', async (x) => sh(x).getShortLink(me(x), ids(x).orgId, ids(x).id));
  r.add('PATCH', `${P}/short-links/:id`, 'user', async (x) => {
    const b = parse(s.shortLinkPatchBody, await x.body());
    return sh(x).updateShortLink(me(x), ids(x).orgId, ids(x).id, {
      destinationUrl: b.destination_url,
      targetId: b.target_id,
      reason: b.reason,
      expiresAt: date(b.expires_at),
      password: b.password,
      requireAuth: b.require_auth,
      label: b.label,
      folder: b.folder,
      tags: b.tags,
    });
  });
  r.add('POST', `${P}/short-links/:id/status`, 'user', async (x) => {
    const b = parse(s.statusBody, await x.body());
    return sh(x).setShortLinkStatus(me(x), ids(x).orgId, ids(x).id, b.action, b.reason);
  });
  r.add('GET', `${P}/short-links/:id/history`, 'user', async (x) => ({ items: await sh(x).shortLinkHistory(me(x), ids(x).orgId, ids(x).id) }));
  r.add('GET', `${P}/short-links/:id/stats`, 'user', async (x) => sh(x).shortLinkStats(me(x), ids(x).orgId, ids(x).id));
  r.add('GET', `${P}/short-links/:id/qr.svg`, 'user', async (x) => {
    const qr = await sh(x).shortLinkQr(me(x), ids(x).orgId, ids(x).id);
    return new Response(qr.svg, {
      headers: {
        'content-type': 'image/svg+xml',
        'content-disposition': `attachment; filename="${qr.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
        'content-security-policy': "default-src 'none'",
      },
    });
  });

  // ---- upload requests, notifications, branding, domains ----------------------------------------------
  r.add('GET', `${P}/upload-requests`, 'user', async (x) => ({ items: await sh(x).listUploadRequests(me(x), org(x)) }));
  r.add('POST', `${P}/upload-requests`, 'user', async (x) => {
    const b = parse(s.uploadRequestBody, await x.body());
    return created(
      await sh(x).createUploadRequest(me(x), org(x), {
        title: b.title,
        instructions: b.instructions,
        requirements: b.requirements.map((q) => ({ key: q.key, label: q.label, accept: q.accept, required: q.required, maxFiles: q.max_files })),
        deadline: new Date(b.deadline),
        maxFileBytes: b.max_file_bytes,
        maxTotalBytes: b.max_total_bytes,
        password: b.password,
        notify: b.notify,
        retentionDays: b.retention_days,
      }),
    );
  });
  r.add('GET', `${P}/upload-requests/:id`, 'user', async (x) => sh(x).getUploadRequest(me(x), ids(x).orgId, ids(x).id));
  r.add('POST', `${P}/upload-requests/:id/status`, 'user', async (x) =>
    sh(x).closeUploadRequest(me(x), ids(x).orgId, ids(x).id, parse(s.requestActionBody, await x.body()).action),
  );
  r.add('GET', `${P}/notifications`, 'user', async (x) => ({ items: await sh(x).listNotifications(me(x), org(x)) }));
  r.add('POST', `${P}/notifications/read`, 'user', async (x) => sh(x).markNotificationsRead(me(x), org(x), parse(s.notificationsReadBody, await x.body()).ids));
  r.add('GET', `${P}/branding`, 'user', async (x) => sh(x).getBranding(me(x), org(x)));
  r.add('PUT', `${P}/branding`, 'user', async (x) => {
    const b = parse(s.brandingBody, await x.body());
    return sh(x).setBranding(me(x), org(x), { displayName: b.display_name, accentColor: b.accent_color });
  });
  r.add('GET', `${P}/domains`, 'user', async (x) => ({ items: await sh(x).listDomains(me(x), org(x)) }));
  r.add('POST', `${P}/domains`, 'user', async (x) => created(await sh(x).addDomain(me(x), org(x), parse(s.domainBody, await x.body()))));
  r.add('POST', `${P}/domains/:id/verify`, 'user', async (x) => sh(x).verifyDomain(me(x), ids(x).orgId, ids(x).id));
  r.add('POST', `${P}/domains/:id/remove`, 'user', async (x) => sh(x).removeDomain(me(x), ids(x).orgId, ids(x).id));

  // ---- public: shares, short-link unlock, upload requests, abuse ----------------------------------------
  const tok = (x: Ctx) => parse(s.shareTokenParams, x.params).token;
  const secret = (x: Ctx) => {
    const v = x.req.headers.get('x-submission-secret');
    if (!v) throw new DomainError('unauthenticated', 'submission not found');
    return v.slice(0, 200);
  };
  const S = '/api/v1/public/shares/:token';
  r.add('POST', `${S}/open`, 'public', async (x) => sh(x).openShare(tok(x), parse(s.openBody, await x.body()), await x.publicCtx()));
  r.add('POST', `${S}/files/url`, 'public', async (x) => {
    const b = parse(s.fileUrlBody, await x.body());
    return sh(x).shareFileUrl(tok(x), { grant: b.grant, fileId: b.file_id, disposition: b.disposition }, await x.publicCtx());
  });
  r.add('POST', `${S}/acknowledge`, 'public', async (x) => {
    const b = parse(s.acknowledgeBody, await x.body());
    return sh(x).acknowledgeShare(tok(x), { grant: b.grant, declaredName: b.declared_name }, await x.publicCtx());
  });
  r.add('GET', `${S}/comments`, 'public', async (x) => sh(x).reviewComments(tok(x), x.req.headers.get('x-share-grant') ?? undefined, await x.publicCtx()));
  r.add('POST', `${S}/comments`, 'public', async (x) => {
    const b = parse(s.commentBody, await x.body());
    return created(await sh(x).addComment(tok(x), { grant: b.grant, body: b.body, page: b.page }, await x.publicCtx()));
  });
  r.add('POST', `${S}/review`, 'public', async (x) => {
    const b = parse(s.decisionBody, await x.body());
    return sh(x).decideReview(tok(x), { grant: b.grant, decision: b.decision, note: b.note }, await x.publicCtx());
  });
  r.add('POST', '/api/v1/public/short-links/:code/unlock', 'public', async (x) => {
    const { code } = parse(s.shortCodeParams, x.params);
    return sh(x).unlockShortLink(x.req.headers.get('host') ?? undefined, code, parse(s.openBody, await x.body()), await x.publicCtx());
  });
  const R = '/api/v1/public/upload-requests/:token';
  r.add('POST', `${R}/open`, 'public', async (x) => sh(x).openUploadRequest(tok(x), parse(s.openBody, await x.body()), await x.publicCtx()));
  r.add('POST', `${R}/submissions`, 'public', async (x) =>
    created(await sh(x).startSubmission(tok(x), parse(s.submissionStartBody, await x.body()), await x.publicCtx())),
  );
  r.add('GET', `${R}/submission`, 'public', async (x) => sh(x).submissionStatus(tok(x), secret(x)));
  r.add('POST', `${R}/submission/submit`, 'public', async (x) => {
    parse(s.emptyBody, await x.body());
    return sh(x).submit(tok(x), secret(x), await x.publicCtx());
  });
  r.add('POST', `${R}/uploads`, 'public', async (x) => {
    const b = parse(s.submissionUploadBody, await x.body());
    return created(await sh(x).beginSubmissionUpload(tok(x), secret(x), { requirementKey: b.requirement_key, name: b.name, size: b.size }));
  });
  const up = (x: Ctx) => parse(s.submissionUploadParams, x.params);
  r.add('POST', `${R}/uploads/:uploadId/parts`, 'public', async (x) =>
    sh(x).signSubmissionParts(up(x).token, secret(x), up(x).uploadId, parse(s.partsBody, await x.body()).part_numbers),
  );
  r.add('GET', `${R}/uploads/:uploadId`, 'public', async (x) => sh(x).submissionUploadStatus(up(x).token, secret(x), up(x).uploadId));
  r.add('POST', `${R}/uploads/:uploadId/complete`, 'public', async (x) => {
    parse(s.emptyBody, await x.body());
    return sh(x).completeSubmissionUpload(up(x).token, secret(x), up(x).uploadId);
  });
  r.add('POST', `${R}/uploads/:uploadId/abort`, 'public', async (x) => {
    parse(s.emptyBody, await x.body());
    return sh(x).abortSubmissionUpload(up(x).token, secret(x), up(x).uploadId);
  });
  r.add('POST', '/api/v1/public/abuse-reports', 'public', async (x) => json(await sh(x).reportAbuse(parse(s.abuseBody, await x.body())), 202), 10);

  // ---- operators --------------------------------------------------------------------------------------
  r.add('GET', '/api/v1/admin/sharing/abuse-reports', 'operator', async (x) => ({
    items: await sh(x).listAbuseReports(parse(s.abuseQuery, Object.fromEntries(x.query)).status),
  }));
  r.add('POST', '/api/v1/admin/sharing/abuse-reports/:id/resolve', 'operator', async (x) => {
    const { id } = parse(s.abuseParams, x.params);
    return sh(x).resolveAbuseReport(me(x).userId, id, parse(s.abuseResolveBody, await x.body()));
  });
  r.add('POST', '/api/v1/admin/workspaces/:orgId/sharing/:type/:id/hold', 'operator', async (x) => {
    const p = parse(s.holdParams, x.params);
    const b = parse(s.holdBody, await x.body());
    return sh(x).setOperatorHold(me(x).userId, p.orgId, p.type, p.id, b.hold, b.reason);
  });
  return r;
}
