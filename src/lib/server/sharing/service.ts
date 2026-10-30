import type { Mailer } from '../mail';
import { inviteEmailHtml, shareEmailHtml } from '../share-email';
import { createHash, randomBytes } from 'node:crypto';
import { buildFeeCertificate, type FeeCertificateFacts } from '../../fees/certificate';
import {
  FEE_CURRENCIES,
  STATEMENT_BATCH,
  certificateFileName,
  formatAmount,
  isIsoDate,
  matchStatement,
  parseAmount,
  referenceKey,
  type StatementLine,
} from '../../fees/match';
import { newId } from '../kernel';
import { DomainError, type Clock, type UserPrincipal } from '../kernel';
import type {
  AbuseRow,
  BlobRow,
  DestinationType,
  DocumentRow,
  DomainRow,
  EventKind,
  EventRow,
  FeeClaimRow,
  FeeDeskRow,
  JobRow,
  LinkRow,
  Requirement,
  ShortLinkRow,
  SharingRepo,
  SharingStore,
  SharingTx,
  SubmissionRow,
  TransferRow,
  UploadRequestRow,
  UploadTarget,
  VerifiedDocumentRow,
  VersionRow,
} from './model';
import { FEE_REJECTION_REASONS } from './model';
import {
  DOCUMENT_EXTS,
  FILE_KINDS,
  PERMISSIONS,
  contentDisposition,
  stripControl,
  dayKey,
  effectiveLinkState,
  looksAutomated,
  monthKey,
  normalizeEmail,
  permits,
  planParts,
  referrerHost,
  requireFileKind,
  resolveLimits,
  sanitizeFileName,
  sanitizeFolderPath,
  validateAccentColor,
  validateAlias,
  validateExternalDestination,
  publicShortPath,
  validateHostname,
  type DestinationPolicy,
  type EffectiveLinkState,
  type SharePermission,
  type SharingLimits,
} from './policy';
import { qrSvg } from './qr';
import { objectKey, type FileScanner, type ObjectStore } from './storage';
import { newPublicCode, newSalt, newSubmissionSecret, tokenHash, type GrantClaims, type SharingKeys } from './tokens';

export type SharePerm = 'share:read' | 'share:create' | 'share:manage';

export interface SharingConfig {
  trialMode: boolean;
  /** Origin of the portal and public share pages (`/s/`, `/r/`, `/d/`). */
  publicOrigin: string;
  /** Default origin for public short links (`/l/`). May equal `publicOrigin`. */
  shortOrigin: string;
  grantTtlSeconds: number;
  downloadUrlTtlSeconds: number;
  uploadUrlTtlSeconds: number;
  uploadSessionHours: number;
  passwordMaxFailures: number;
  passwordLockMinutes: number;
  eventRetentionDays: number;
  statRetentionDays: number;
  notificationRetentionDays: number;
  scanMaxAttempts: number;
  /** A file whose checks keep failing (scanner unreachable) is retried this long before it is rejected. */
  scanGiveUpHours: number;
  jobLeaseSeconds: number;
  partBytes: number;
  /** How often verified custom domains are re-checked, and how long a missing record is tolerated. */
  domainRecheckHours: number;
  domainGraceDays: number;
}

export const DEFAULT_SHARING_CONFIG: Omit<SharingConfig, 'publicOrigin' | 'shortOrigin'> = {
  trialMode: false,
  grantTtlSeconds: 900,
  downloadUrlTtlSeconds: 60,
  uploadUrlTtlSeconds: 900,
  uploadSessionHours: 24,
  passwordMaxFailures: 10,
  passwordLockMinutes: 15,
  eventRetentionDays: 180,
  statRetentionDays: 400,
  notificationRetentionDays: 90,
  scanMaxAttempts: 6,
  scanGiveUpHours: 24,
  jobLeaseSeconds: 300,
  partBytes: 8 * 1024 * 1024,
  domainRecheckHours: 24,
  domainGraceDays: 14,
};

export interface SharingDeps {
  store: SharingStore;
  objects: ObjectStore;
  scanner: FileScanner;
  keys: SharingKeys;
  clock: Clock;
  config: SharingConfig;
  destinations: DestinationPolicy;
  /** Org-scoped authorization: non-members get 404, members lacking the permission get 403. */
  authorize(p: UserPrincipal, orgId: string, permission: SharePerm): Promise<void>;
  identity(userId: string): Promise<{ email: string; emailVerified: boolean } | undefined>;
  isMember(orgId: string, userId: string): Promise<boolean>;
  /** Server-resolved entitlements of the organization's currently valid licenses. */
  entitlements(orgId: string): Promise<Array<Record<string, unknown>>>;
  passwords: {
    hash(pw: string): Promise<string>;
    verify(pw: string, hash: string): Promise<boolean>;
  };
  /** Optional email delivery for opt-in notifications (sent by the job worker, never inline). */
  mailer?: Mailer;
  /** DNS TXT lookup for custom-domain verification. DNS only: the platform never fetches tenant URLs. */
  resolveTxt?: (name: string) => Promise<string[][]>;
  /** Users allowed to manage a workspace's sharing settings (owners and admins), for domain warnings. */
  managers?: (orgId: string) => Promise<string[]>;
  /** A pending team invitation, for its email (undefined once answered, cancelled or expired). */
  invitation?: (id: string) => Promise<{ email: string; workspaceName: string; invitedBy: string; role: string; expiresAt: Date } | undefined>;
  /** Name and kind of a workspace, for the issuer shown on verified documents. */
  organization?: (orgId: string) => Promise<{ name: string; kind: 'personal' | 'team' } | undefined>;
}

export interface UploadRequestInput {
  title: string;
  instructions?: string | undefined;
  requirements: Array<{
    key: string;
    label: string;
    accept?: string[] | undefined;
    required?: boolean | undefined;
    maxFiles?: number | undefined;
  }>;
  deadline: Date;
  maxFileBytes: number;
  maxTotalBytes: number;
  password?: string | undefined;
  notify?: boolean | undefined;
  retentionDays?: number | null | undefined;
}

/** Request facts for public endpoints. Only coarse, non-identifying attributes are ever stored. */
export interface PublicContext {
  principal?: UserPrincipal | undefined;
  userAgent?: string | undefined;
  referer?: string | undefined;
}

const notFound = () => new DomainError('not_found', 'not found');
const VERIFICATION_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** 20 symbols from 32: each random byte's low 5 bits are uniform, giving 100 bits. */
const verificationCode = () => Array.from(randomBytes(20), (b) => VERIFICATION_ALPHABET[b & 31]).join('');
const VERIFICATION_MAX_DETAILS = 8;
const VERIFICATION_RESERVED_LABELS = new Set(['document', 'issuedby', 'issuer', 'issuedon', 'issued', 'code', 'status', 'valid', 'verified', 'revoked']);
const VERIFICATION_RESERVATION_MS = 60 * 60 * 1000;
export const VERIFICATION_REVOCATION_REASONS = ['issued_in_error', 'superseded', 'payment_reversed', 'fraud_suspected', 'other'] as const;
const invalid = (m: string) => new DomainError('invalid_request', m);
const duplicatePayment = () => new DomainError('conflict', 'This bank payment has already been submitted. If it is your payment, contact the finance office.');
/** Certificates issued per request (each is a PDF built on the server). */
const FEE_CERTIFICATE_BATCH = 50;
const FEE_RECEIPT_TYPES = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'pdf'];
const FEE_REASON_TEXT: Record<(typeof FEE_REJECTION_REASONS)[number], string> = {
  not_on_statement: 'The payment was not found on the bank statement.',
  amount_differs: 'The amount does not match the bank statement.',
  duplicate: 'This payment was already used for another claim.',
  unreadable_receipt: 'The bank receipt could not be read.',
  other: 'The finance office could not confirm this payment.',
};

export interface FeePaymentInput {
  payerId?: string | undefined;
  bank: string;
  reference: string;
  amount: string;
  paidOn: string;
}
const quota = (what: string) => new DomainError('quota_exceeded', `${what} limit reached for this plan`);
const unavailable = (state: string) => new DomainError('link_unavailable', 'this link is no longer available', { state });

/**
 * Jobs that only a worker with a mailer can run. Both app instances (Railway and the Cloudflare backup) share the job
 * queue, and a worker without email settings used to mark these done without sending; now it leaves them alone.
 */
export const EMAIL_JOBS: readonly JobRow['kind'][] = ['share_email', 'notify_email', 'member_invite'];
/** An email still unsent this long after it fell due is dropped (no worker can send it, and it is stale). */
const STALE_EMAIL_MS = 7 * 86_400_000;

// Unfinished uploads one upload request may hold at a time: a count, and room for this many full submissions.
const MAX_PENDING_REQUEST_UPLOADS = 10;
const PENDING_REQUEST_SUBMISSIONS = 2;

const NOTICES = [
  'View-only access cannot prevent screenshots, photos of the screen or other copying.',
  'Revoking a link stops future access through it; it cannot remove copies already downloaded.',
];

const text = (raw: string | undefined | null, max: number, field: string): string | null => {
  if (raw === undefined || raw === null) return null;
  const v = stripControl(raw.normalize('NFC')).trim();
  if (v.length > max) throw invalid(`${field} is too long`);
  return v.length ? v : null;
};
const title = (raw: string, field = 'title') => {
  const v = text(raw, 200, field);
  if (!v) throw invalid(`${field} is required`);
  return v;
};

/**
 * File sharing, document publication, short links and upload requests (ADR-021).
 *
 * Invariants (each has a negative-path test in services/platform-api/test/sharing*.test.ts):
 *  - Every workspace method authorizes org membership first; another tenant's ids are indistinguishable from
 *    unknown ids (404).
 *  - Drafts are never reachable through a link; `latest` links serve only the explicitly published version.
 *  - Public access re-evaluates the link on EVERY request (revocation, expiry, recipients), not only at grant.
 *  - Bytes are served only after quarantine checks pass, from the isolated content origin.
 *  - Quotas are checked under the organization's account lock before uploads are accepted and before exports.
 *  - State changes and their audit events commit together; transaction callbacks have no external effects.
 */
export class SharingService {
  readonly #d: SharingDeps;
  readonly #c: SharingConfig;

  constructor(deps: SharingDeps) {
    this.#d = deps;
    this.#c = deps.config;
  }

  get config(): SharingConfig {
    return this.#c;
  }

  #now(): Date {
    return this.#d.clock.now();
  }
  #at(ms: number): Date {
    return new Date(this.#now().getTime() + ms);
  }

  async limits(orgId: string): Promise<SharingLimits> {
    return resolveLimits(await this.#d.entitlements(orgId), this.#c.trialMode);
  }

  /** Authorize, then run `fn` in a transaction holding the account lock, after metering one API mutation. */
  async #mutate<T>(p: UserPrincipal, orgId: string, perm: SharePerm, fn: (tx: SharingTx, ctx: { now: Date; limits: SharingLimits }) => Promise<T>): Promise<T> {
    await this.#d.authorize(p, orgId, perm);
    const limits = await this.limits(orgId);
    return this.#d.store.transaction(async (tx) => {
      const now = this.#now();
      await tx.lockAccount(orgId, now);
      const n = await tx.addUsage(orgId, monthKey(now), 'api_requests', 1);
      if (n > limits.apiRequestsPerMonth) throw quota('API request');
      return fn(tx, { now, limits });
    });
  }

  /** Creators manage their own items; anything else needs `share:manage` (admins/owners). */
  async #requireManager(p: UserPrincipal, orgId: string, createdBy: string | null): Promise<void> {
    if (createdBy !== p.userId) await this.#d.authorize(p, orgId, 'share:manage');
  }

  async #isManager(p: UserPrincipal, orgId: string, createdBy: string | null): Promise<boolean> {
    try {
      await this.#requireManager(p, orgId, createdBy);
      return true;
    } catch (e) {
      if (e instanceof DomainError && e.code === 'forbidden') return false;
      throw e;
    }
  }

  #audit(
    tx: SharingTx,
    actor: { type: 'user' | 'system' | 'anonymous' | 'operator'; id?: string },
    orgId: string,
    action: string,
    target: { type: string; id: string },
    metadata?: Record<string, unknown>,
    reason?: string | null,
  ) {
    return tx.audit.append({
      actor,
      action,
      target,
      orgId,
      ...(reason ? { reason } : {}),
      ...(metadata ? { metadata } : {}),
    });
  }

  // =============================================================================================
  // Overview and usage
  // =============================================================================================

  async overview(p: UserPrincipal, orgId: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    const limits = await this.limits(orgId);
    const period = monthKey(this.#now());
    const [storageBytes, usage] = await Promise.all([this.#d.store.storageBytes(orgId), this.#d.store.usage(orgId, period)]);
    return {
      period,
      limits,
      usage: {
        storageBytes,
        bandwidthBytes: usage.bandwidth_bytes,
        apiRequests: usage.api_requests,
        processingBytes: usage.processing_bytes,
        uploadBytes: usage.upload_bytes,
      },
    };
  }

  // =============================================================================================
  // Documents: private drafts → immutable exported versions → explicit publication
  // =============================================================================================

  async createDocument(p: UserPrincipal, orgId: string, input: { title: string; requireApproval?: boolean }) {
    const t = title(input.title);
    return this.#mutate(p, orgId, 'share:create', async (tx, { now }) => {
      const doc: DocumentRow = {
        id: newId('doc'),
        orgId,
        title: t,
        createdBy: p.userId,
        draftBlobId: null,
        draftUpdatedAt: null,
        publishedVersionId: null,
        publishedAt: null,
        requireApproval: input.requireApproval ?? false,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert('document', doc);
      await this.#audit(
        tx,
        { type: 'user', id: p.userId },
        orgId,
        'share.document.created',
        {
          type: 'share_document',
          id: doc.id,
        },
        { require_approval: doc.requireApproval },
      );
      return documentView(doc);
    });
  }

  async listDocuments(p: UserPrincipal, orgId: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    return (await this.#d.store.list('document', orgId, { status: 'active' })).map(documentView);
  }

  async getDocument(p: UserPrincipal, orgId: string, documentId: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    const s = this.#d.store;
    const doc = await s.get('document', orgId, documentId);
    if (!doc || doc.status !== 'active') throw notFound();
    const versions = await s.list('version', orgId, { documentId }, { limit: 1000 });
    const reviews = await s.list('review', orgId, { documentId }, { limit: 5000 });
    const draft = doc.draftBlobId ? await s.get('blob', orgId, doc.draftBlobId) : undefined;
    const pendingDraft = (await s.list('blob', orgId, { targetType: 'draft', targetId: documentId }, { limit: 5 }))
      .filter((b) => b.status === 'uploading' || b.status === 'quarantined' || b.status === 'rejected')
      .map((b) => ({
        uploadId: b.id,
        status: fileStatus(b.status),
        rejectReason: b.rejectReason,
        createdAt: b.createdAt,
      }));
    return {
      ...documentView(doc),
      draft: draft ? { size: draft.size, updatedAt: doc.draftUpdatedAt, sha256: draft.sha256 } : null,
      draftUploads: pendingDraft,
      versions: versions
        .sort((a, b) => b.number - a.number)
        .map((v) => ({
          ...versionView(v),
          published: v.id === doc.publishedVersionId,
          approvals: reviews.filter((r) => r.versionId === v.id && r.decision === 'approved').length,
          changesRequested: reviews.filter((r) => r.versionId === v.id && r.decision === 'changes_requested').length,
        })),
    };
  }

  /** Workflow 1: create an immutable export from the current private draft. Drafts are never shared. */
  async exportVersion(p: UserPrincipal, orgId: string, documentId: string, input: { note?: string | undefined; fileName?: string | undefined }) {
    const note = text(input.note, 1000, 'note');
    return this.#mutate(p, orgId, 'share:create', async (tx, { now, limits }) => {
      const doc = await tx.getForUpdate('document', orgId, documentId);
      if (!doc || doc.status !== 'active') throw notFound();
      await this.#requireManager(p, orgId, doc.createdBy);
      if (!doc.draftBlobId) throw new DomainError('conflict', 'save a draft before exporting');
      const blob = await tx.getForUpdate('blob', orgId, doc.draftBlobId);
      if (!blob || blob.status !== 'clean') throw new DomainError('conflict', 'the draft is not ready');
      // Exports reference the immutable draft object (no copy), but an organization already over its storage
      // allowance (for example after a downgrade) cannot create more exports until it frees space.
      if ((await tx.storageBytes(orgId)) > limits.storageBytes) throw quota('storage');
      const versions = await tx.list('version', orgId, { documentId }, { limit: 1 });
      if (versions[0]?.blobId === blob.id) throw new DomainError('conflict', `no changes since version ${versions[0].number}`);
      const number = await tx.nextVersionNumber(orgId, documentId);
      const fileName = sanitizeFileName(input.fileName ?? `${doc.title.replace(/[\\/]/g, '-').slice(0, 150)} v${number}.pdf`);
      requireFileKind(fileName, DOCUMENT_EXTS);
      const v: VersionRow = {
        id: newId('ver'),
        orgId,
        documentId,
        number,
        blobId: blob.id,
        fileName,
        note,
        createdBy: p.userId,
        createdAt: now,
        publishedAt: null,
        replacementNote: null,
      };
      await tx.insert('version', v);
      await tx.update('document', orgId, documentId, { updatedAt: now });
      await this.#audit(
        tx,
        { type: 'user', id: p.userId },
        orgId,
        'share.document.exported',
        {
          type: 'share_document',
          id: documentId,
        },
        { version_id: v.id, number, sha256: blob.sha256 },
      );
      return versionView(v);
    });
  }

  /**
   * Workflows 2/5: make a version the one `latest` links serve. Explicit only; nothing else changes it. With
   * `requireApproval`, the version needs an approval from someone other than its author and no open
   * change request.
   */
  async publishVersion(p: UserPrincipal, orgId: string, documentId: string, input: { versionId: string; replacementNote?: string | undefined }) {
    const note = text(input.replacementNote, 1000, 'replacement note');
    return this.#mutate(p, orgId, 'share:create', async (tx, { now }) => {
      const doc = await tx.getForUpdate('document', orgId, documentId);
      if (!doc || doc.status !== 'active') throw notFound();
      await this.#requireManager(p, orgId, doc.createdBy);
      const v = await tx.getForUpdate('version', orgId, input.versionId);
      if (!v || v.documentId !== documentId) throw notFound();
      if (doc.requireApproval && !(await this.#approved(tx, orgId, v)))
        throw new DomainError('conflict', 'this version needs an approval before it can be published');
      if (doc.publishedVersionId === v.id) return versionView(v);
      await tx.update('version', orgId, v.id, {
        publishedAt: v.publishedAt ?? now,
        replacementNote: doc.publishedVersionId ? note : null,
      });
      await tx.update('document', orgId, documentId, {
        publishedVersionId: v.id,
        publishedAt: now,
        updatedAt: now,
      });
      await this.#audit(
        tx,
        { type: 'user', id: p.userId },
        orgId,
        'share.document.published',
        {
          type: 'share_document',
          id: documentId,
        },
        { version_id: v.id, number: v.number, previous_version_id: doc.publishedVersionId },
      );
      return versionView({
        ...v,
        publishedAt: v.publishedAt ?? now,
        replacementNote: doc.publishedVersionId ? note : null,
      });
    });
  }

  async #approved(r: SharingRepo, orgId: string, v: VersionRow): Promise<boolean> {
    const reviews = await r.list('review', orgId, { versionId: v.id }, { limit: 1000 });
    return reviews.some((x) => x.decision === 'approved' && x.reviewerUserId !== v.createdBy) && !reviews.some((x) => x.decision === 'changes_requested');
  }

  async reviewThread(p: UserPrincipal, orgId: string, documentId: string, versionId: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    const v = await this.#d.store.get('version', orgId, versionId);
    if (!v || v.documentId !== documentId) throw notFound();
    return this.#thread(orgId, v);
  }

  async #thread(orgId: string, v: VersionRow) {
    const s = this.#d.store;
    const [comments, reviews] = await Promise.all([
      s.list('comment', orgId, { versionId: v.id }, { limit: 1000, order: 'oldest' }),
      s.list('review', orgId, { versionId: v.id }, { limit: 1000, order: 'oldest' }),
    ]);
    const emails = new Map<string, string>();
    for (const id of new Set([...comments.map((c) => c.authorUserId), ...reviews.map((r) => r.reviewerUserId)]))
      emails.set(id, (await this.#d.identity(id))?.email ?? 'unknown');
    return {
      versionId: v.id,
      number: v.number,
      comments: comments.map((c) => ({
        id: c.id,
        author: emails.get(c.authorUserId),
        page: c.page,
        body: c.body,
        createdAt: c.createdAt,
      })),
      reviews: reviews.map((r) => ({
        reviewer: emails.get(r.reviewerUserId),
        decision: r.decision,
        note: r.note,
        updatedAt: r.updatedAt,
      })),
    };
  }

  async deleteDocument(p: UserPrincipal, orgId: string, documentId: string) {
    return this.#mutate(p, orgId, 'share:create', async (tx, { now }) => {
      const doc = await tx.getForUpdate('document', orgId, documentId);
      if (!doc || doc.status !== 'active') throw notFound();
      await this.#requireManager(p, orgId, doc.createdBy);
      await tx.update('document', orgId, documentId, { status: 'deleted', updatedAt: now });
      const blobs = new Set((await tx.list('version', orgId, { documentId }, { limit: 10_000 })).map((v) => v.blobId));
      if (doc.draftBlobId) blobs.add(doc.draftBlobId);
      for (const b of blobs) await this.#enqueue(tx, orgId, 'delete_blob', b, now);
      await this.#audit(tx, { type: 'user', id: p.userId }, orgId, 'share.document.deleted', {
        type: 'share_document',
        id: documentId,
      });
      return { deleted: true };
    });
  }

  // =============================================================================================
  // Transfers
  // =============================================================================================

  #transferExpiry(kind: 'temporary' | 'persistent', expiresAt: Date | null | undefined, limits: SharingLimits, now: Date): Date | null {
    if (kind === 'persistent') {
      if (!limits.persistent) throw new DomainError('forbidden', 'persistent sharing is not included in this plan');
      if (expiresAt && expiresAt <= now) throw invalid('expiry must be in the future');
      return expiresAt ?? null;
    }
    const max = now.getTime() + limits.maxRetentionDays * 86_400_000;
    const exp = expiresAt ?? new Date(Math.min(max, now.getTime() + 7 * 86_400_000));
    if (exp <= now) throw invalid('expiry must be in the future');
    if (exp.getTime() > max) throw new DomainError('quota_exceeded', `temporary transfers may last at most ${limits.maxRetentionDays} days on this plan`);
    return exp;
  }

  async createTransfer(
    p: UserPrincipal,
    orgId: string,
    input: {
      title: string;
      message?: string | undefined;
      kind: 'temporary' | 'persistent';
      expiresAt?: Date | null | undefined;
    },
  ) {
    const t = title(input.title);
    const message = text(input.message, 2000, 'message');
    return this.#mutate(p, orgId, 'share:create', async (tx, { now, limits }) => {
      const tr: TransferRow = {
        id: newId('trf'),
        orgId,
        createdBy: p.userId,
        title: t,
        message,
        kind: input.kind,
        status: 'active',
        expiresAt: this.#transferExpiry(input.kind, input.expiresAt, limits, now),
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert('transfer', tr);
      await this.#audit(
        tx,
        { type: 'user', id: p.userId },
        orgId,
        'share.transfer.created',
        {
          type: 'share_transfer',
          id: tr.id,
        },
        { kind: tr.kind, expires_at: tr.expiresAt?.toISOString() ?? null },
      );
      return transferView(tr);
    });
  }

  async listTransfers(p: UserPrincipal, orgId: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    const rows = (await this.#d.store.list('transfer', orgId, {}, { limit: 500 })).filter((t) => t.status !== 'purged' && t.status !== 'deleted');
    const now = this.#now();
    // A summary per transfer for the "sent" list: files, size, recipients (links) and downloads.
    return Promise.all(
      rows.map(async (t) => {
        const [files, links] = await Promise.all([
          this.#d.store.list('transferFile', orgId, { transferId: t.id, status: 'current' }, { limit: 5000 }),
          this.#d.store.list('link', orgId, { targetId: t.id }, { limit: 1000 }),
        ]);
        return {
          ...transferView(t, now),
          fileCount: files.length,
          totalBytes: files.reduce((n, f) => n + f.size, 0),
          linkCount: links.length,
          downloads: links.reduce((n, l) => n + l.downloadCount, 0),
        };
      }),
    );
  }

  async getTransfer(p: UserPrincipal, orgId: string, transferId: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    const tr = await this.#d.store.get('transfer', orgId, transferId);
    if (!tr || tr.status === 'deleted' || tr.status === 'purged') throw notFound();
    const files = await this.#transferFiles(orgId, tr.id);
    const pending = (await this.#d.store.list('blob', orgId, { targetType: 'transfer_replace' }, { limit: 500 }))
      .filter((b) => files.some((f) => f.id === b.targetId) && ['uploading', 'quarantined'].includes(b.status))
      .map((b) => ({ uploadId: b.id, fileId: b.targetId, status: fileStatus(b.status) }));
    return { ...transferView(tr, this.#now()), files, pendingReplacements: pending };
  }

  async #transferFiles(orgId: string, transferId: string, r: SharingRepo = this.#d.store) {
    const files = await r.list('transferFile', orgId, { transferId, status: 'current' }, { limit: 5000, order: 'oldest' });
    const out = [];
    for (const f of files) {
      const b = await r.get('blob', orgId, f.blobId);
      out.push({
        id: f.id,
        name: f.name,
        folderPath: f.folderPath,
        size: f.size,
        contentType: FILE_KINDS[f.ext]?.contentType ?? 'application/octet-stream',
        inline: !!FILE_KINDS[f.ext]?.inline,
        status: fileStatus(b?.status ?? 'deleted'),
        rejectReason: b?.rejectReason ?? null,
        revision: f.revision,
        replacedAt: f.replacedAt,
        replacementNote: f.replacementNote,
        uploadId: b && b.status === 'uploading' ? b.id : null,
      });
    }
    return out;
  }

  async updateTransfer(
    p: UserPrincipal,
    orgId: string,
    transferId: string,
    input: {
      title?: string | undefined;
      message?: string | null | undefined;
      expiresAt?: Date | null | undefined;
    },
  ) {
    return this.#mutate(p, orgId, 'share:create', async (tx, { now, limits }) => {
      const tr = await tx.getForUpdate('transfer', orgId, transferId);
      if (!tr || tr.status !== 'active') throw notFound();
      await this.#requireManager(p, orgId, tr.createdBy);
      const patch: Partial<TransferRow> = { updatedAt: now };
      if (input.title !== undefined) patch.title = title(input.title);
      if (input.message !== undefined) patch.message = text(input.message, 2000, 'message');
      if (input.expiresAt !== undefined) patch.expiresAt = this.#transferExpiry(tr.kind, input.expiresAt, limits, now);
      await tx.update('transfer', orgId, transferId, patch);
      await this.#audit(
        tx,
        { type: 'user', id: p.userId },
        orgId,
        'share.transfer.updated',
        {
          type: 'share_transfer',
          id: transferId,
        },
        { expires_at: (patch.expiresAt ?? tr.expiresAt)?.toISOString() ?? null },
      );
      return transferView({ ...tr, ...patch }, now);
    });
  }

  /** Revocation stops future access through every link to the transfer. Temporary files are still removed at expiry. */
  async revokeTransfer(p: UserPrincipal, orgId: string, transferId: string, reason?: string) {
    return this.#mutate(p, orgId, 'share:create', async (tx, { now }) => {
      const tr = await tx.getForUpdate('transfer', orgId, transferId);
      if (!tr || tr.status === 'deleted' || tr.status === 'purged') throw notFound();
      await this.#requireManager(p, orgId, tr.createdBy);
      if (tr.status === 'active') {
        await tx.update('transfer', orgId, transferId, { status: 'revoked', updatedAt: now });
        await this.#audit(
          tx,
          { type: 'user', id: p.userId },
          orgId,
          'share.transfer.revoked',
          {
            type: 'share_transfer',
            id: transferId,
          },
          undefined,
          text(reason, 500, 'reason'),
        );
      }
      return transferView({ ...tr, status: tr.status === 'active' ? 'revoked' : tr.status }, now);
    });
  }

  /** Deletes the transfer; its files are removed by the next retention pass. */
  async deleteTransfer(p: UserPrincipal, orgId: string, transferId: string) {
    return this.#mutate(p, orgId, 'share:create', async (tx, { now }) => {
      const tr = await tx.getForUpdate('transfer', orgId, transferId);
      if (!tr || tr.status === 'deleted' || tr.status === 'purged') throw notFound();
      await this.#requireManager(p, orgId, tr.createdBy);
      await tx.update('transfer', orgId, transferId, { status: 'deleted', updatedAt: now });
      await this.#audit(tx, { type: 'user', id: p.userId }, orgId, 'share.transfer.deleted', {
        type: 'share_transfer',
        id: transferId,
      });
      return { deleted: true };
    });
  }

  async removeTransferFile(p: UserPrincipal, orgId: string, transferId: string, fileId: string) {
    return this.#mutate(p, orgId, 'share:create', async (tx, { now }) => {
      const tr = await tx.getForUpdate('transfer', orgId, transferId);
      if (!tr || tr.status !== 'active') throw notFound();
      await this.#requireManager(p, orgId, tr.createdBy);
      const f = await tx.getForUpdate('transferFile', orgId, fileId);
      if (!f || f.transferId !== transferId || f.status !== 'current') throw notFound();
      await tx.update('transferFile', orgId, fileId, { status: 'removed', updatedAt: now });
      await this.#enqueue(tx, orgId, 'delete_blob', f.blobId, now);
      await this.#audit(
        tx,
        { type: 'user', id: p.userId },
        orgId,
        'share.transfer.file_removed',
        {
          type: 'share_transfer',
          id: transferId,
        },
        { file_id: fileId },
      );
      return { removed: true };
    });
  }

  // =============================================================================================
  // Resumable uploads (owner side)
  // =============================================================================================

  /**
   * Starts a resumable multipart upload directly to private object storage. Quotas (file size, storage,
   * processing) are applied here, before any byte is accepted; the declared size is reserved until completion.
   */
  async beginUpload(
    p: UserPrincipal,
    orgId: string,
    input: {
      target: 'transfer' | 'replace' | 'draft';
      transferId?: string | undefined;
      fileId?: string | undefined;
      documentId?: string | undefined;
      name: string;
      folderPath?: string | undefined;
      size: number;
      note?: string | undefined;
    },
  ) {
    await this.#d.authorize(p, orgId, 'share:create');
    const name = sanitizeFileName(input.name);
    const kind = requireFileKind(name, input.target === 'draft' ? DOCUMENT_EXTS : undefined);
    const folderPath = sanitizeFolderPath(input.folderPath);
    const note = text(input.note, 1000, 'replacement note');
    const targetType: UploadTarget = input.target === 'transfer' ? 'transfer_file' : input.target === 'replace' ? 'transfer_replace' : 'draft';
    const targetRef = input.target === 'draft' ? input.documentId : input.target === 'replace' ? input.fileId : input.transferId;
    if (!targetRef) throw invalid('upload target is required');

    return this.#startMultipart(
      orgId,
      kind.ext,
      kind.contentType,
      input.size,
      async (tx, blob, limits) => {
        const n = await tx.addUsage(orgId, monthKey(blob.createdAt), 'api_requests', 1);
        if (n > limits.apiRequestsPerMonth) throw quota('API request');
        blob.createdBy = p.userId;
        blob.targetType = targetType;
        blob.note = note;
        if (input.target === 'draft') {
          const doc = await tx.getForUpdate('document', orgId, targetRef);
          if (!doc || doc.status !== 'active') throw notFound();
          await this.#requireManager(p, orgId, doc.createdBy);
          blob.targetId = doc.id;
          await tx.insert('blob', blob);
          return { fileId: null };
        }
        const transferId = input.target === 'transfer' ? targetRef : input.transferId;
        const tr = transferId ? await tx.getForUpdate('transfer', orgId, transferId) : undefined;
        if (!tr || tr.status !== 'active') throw notFound();
        await this.#requireManager(p, orgId, tr.createdBy);
        if (input.target === 'replace') {
          const f = await tx.get('transferFile', orgId, targetRef);
          if (!f || f.transferId !== tr.id || f.status !== 'current') throw notFound();
          if (f.ext !== kind.ext) throw invalid('a replacement must have the same file type as the original');
          blob.targetId = f.id;
          await tx.insert('blob', blob);
          return { fileId: f.id };
        }
        const fileId = newId('tfl');
        blob.targetId = fileId;
        await tx.insert('blob', blob);
        await tx.insert('transferFile', {
          id: fileId,
          orgId,
          transferId: tr.id,
          blobId: blob.id,
          name,
          folderPath,
          ext: kind.ext,
          size: input.size,
          status: 'current',
          revision: 1,
          replacedAt: null,
          replacementNote: null,
          createdAt: blob.createdAt,
          updatedAt: blob.createdAt,
        });
        return { fileId };
      },
      name,
    );
  }

  async #startMultipart(
    orgId: string,
    ext: string,
    contentType: string,
    size: number,
    attach: (tx: SharingTx, blob: BlobRow, limits: SharingLimits) => Promise<{ fileId: string | null }>,
    fileName: string,
  ) {
    const limits = await this.limits(orgId);
    if (!Number.isSafeInteger(size) || size < 1) throw invalid('invalid size');
    if (size > limits.maxFileBytes) throw quota('file size');
    const { partSize, partCount } = planParts(size, this.#c.partBytes, this.#d.objects.minPartBytes);
    const blobId = newId('blb');
    const key = objectKey(orgId, blobId);
    const { uploadId } = await this.#d.objects.createMultipart(key, contentType);
    try {
      return await this.#d.store.transaction(async (tx) => {
        const now = this.#now();
        await tx.lockAccount(orgId, now);
        if ((await tx.storageBytes(orgId)) + size > limits.storageBytes) throw quota('storage');
        const usage = await tx.usage(orgId, monthKey(now));
        if (usage.processing_bytes + size > limits.processingBytesPerMonth) throw quota('processing');
        const blob: BlobRow = {
          id: blobId,
          orgId,
          objectKey: key,
          ext,
          contentType,
          declaredSize: size,
          size: null,
          sha256: null,
          status: 'uploading',
          rejectReason: null,
          multipartId: uploadId,
          partSize,
          partCount,
          uploadExpiresAt: new Date(now.getTime() + this.#c.uploadSessionHours * 3_600_000),
          targetType: 'transfer_file',
          targetId: '',
          note: null,
          createdBy: null,
          createdAt: now,
          completedAt: null,
          scannedAt: null,
          deletedAt: null,
        };
        const { fileId } = await attach(tx, blob, limits);
        await tx.addUsage(orgId, monthKey(now), 'upload_bytes', size);
        return uploadView(blob, fileId, fileName);
      });
    } catch (e) {
      await this.#d.objects.abortMultipart(key, uploadId).catch(() => undefined);
      throw e;
    }
  }

  async #ownerUpload(p: UserPrincipal, orgId: string, uploadId: string): Promise<BlobRow> {
    await this.#d.authorize(p, orgId, 'share:create');
    const b = await this.#d.store.get('blob', orgId, uploadId);
    if (!b || b.targetType === 'submission_file') throw notFound();
    await this.#requireManager(p, orgId, b.createdBy);
    // A finished upload whose document or file was since removed cannot be resumed: the client starts again.
    if (b.status !== 'uploading' && !(await this.#uploadTargetLive(b))) throw notFound();
    return b;
  }

  async #uploadTargetLive(b: BlobRow) {
    const s = this.#d.store;
    if (b.targetType === 'draft') return (await s.get('document', b.orgId, b.targetId))?.status === 'active';
    if (b.targetType !== 'transfer_file' && b.targetType !== 'transfer_replace') return true;
    const f = await s.get('transferFile', b.orgId, b.targetId);
    return f?.status === 'current' && (await s.get('transfer', b.orgId, f.transferId))?.status === 'active';
  }

  async signUploadParts(p: UserPrincipal, orgId: string, uploadId: string, partNumbers: number[]) {
    return this.#signParts(await this.#ownerUpload(p, orgId, uploadId), partNumbers);
  }
  async uploadStatus(p: UserPrincipal, orgId: string, uploadId: string) {
    return this.#uploadStatus(await this.#ownerUpload(p, orgId, uploadId));
  }
  async completeUpload(p: UserPrincipal, orgId: string, uploadId: string) {
    return this.#complete(await this.#ownerUpload(p, orgId, uploadId));
  }
  async abortUpload(p: UserPrincipal, orgId: string, uploadId: string) {
    return this.#abort(await this.#ownerUpload(p, orgId, uploadId));
  }

  #partBytes(b: BlobRow, n: number): number {
    return n < b.partCount ? b.partSize : b.declaredSize - b.partSize * (b.partCount - 1);
  }

  async #signParts(b: BlobRow, partNumbers: number[]) {
    const now = this.#now();
    if (b.status !== 'uploading' || !b.multipartId || !b.uploadExpiresAt || b.uploadExpiresAt <= now)
      throw new DomainError('conflict', 'this upload is no longer accepting data');
    const nums = [...new Set(partNumbers)];
    if (!nums.length || nums.length > 100 || nums.some((n) => !Number.isInteger(n) || n < 1 || n > b.partCount)) throw invalid('invalid part numbers');
    const exp = new Date(Math.min(b.uploadExpiresAt.getTime(), now.getTime() + this.#c.uploadUrlTtlSeconds * 1000));
    const parts = [];
    for (const n of nums.sort((x, y) => x - y))
      parts.push({
        partNumber: n,
        size: this.#partBytes(b, n),
        url: await this.#d.objects.signPart(b.objectKey, b.multipartId, n, this.#partBytes(b, n), exp),
      });
    return { uploadId: b.id, expiresAt: exp, parts };
  }

  /** Resume point after an interruption: which parts storage already holds. */
  async #uploadStatus(b: BlobRow) {
    if (b.status !== 'uploading' || !b.multipartId)
      return {
        uploadId: b.id,
        status: fileStatus(b.status),
        partSize: b.partSize,
        partCount: b.partCount,
        uploadedParts: [],
        bytesUploaded: b.size ?? 0,
        rejectReason: b.rejectReason,
      };
    const held = (await this.#d.objects.listParts(b.objectKey, b.multipartId)).filter(
      (x) => x.partNumber <= b.partCount && x.size === this.#partBytes(b, x.partNumber),
    );
    return {
      uploadId: b.id,
      status: 'uploading' as const,
      partSize: b.partSize,
      partCount: b.partCount,
      uploadedParts: held.map((x) => x.partNumber).sort((x, y) => x - y),
      bytesUploaded: held.reduce((n, x) => n + x.size, 0),
      expiresAt: b.uploadExpiresAt,
      rejectReason: null,
    };
  }

  async #complete(b: BlobRow) {
    if (b.status !== 'uploading') return this.#uploadStatus(b);
    if (!b.multipartId || !b.uploadExpiresAt || b.uploadExpiresAt <= this.#now()) throw new DomainError('conflict', 'this upload is no longer accepting data');
    const held = await this.#d.objects.listParts(b.objectKey, b.multipartId);
    const byNum = new Map(held.map((x) => [x.partNumber, x]));
    const missing: number[] = [];
    for (let n = 1; n <= b.partCount; n++) {
      const part = byNum.get(n);
      if (!part || part.size !== this.#partBytes(b, n)) missing.push(n);
    }
    if (missing.length)
      throw new DomainError('conflict', 'upload is incomplete', {
        missing_parts: missing.slice(0, 100),
      });
    let size: number;
    try {
      size = (
        await this.#d.objects.completeMultipart(
          b.objectKey,
          b.multipartId,
          [...byNum.values()].filter((x) => x.partNumber <= b.partCount).sort((x, y) => x.partNumber - y.partNumber),
        )
      ).size;
    } catch (e) {
      // A concurrent completion may have won; report its outcome.
      const now = await this.#d.store.get('blob', b.orgId, b.id);
      if (now && now.status !== 'uploading') return this.#uploadStatus(now);
      throw e;
    }
    return this.#d.store.transaction(async (tx) => {
      const now = this.#now();
      const cur = await tx.getForUpdate('blob', b.orgId, b.id);
      if (!cur) throw notFound();
      if (cur.status !== 'uploading') return this.#uploadStatus(cur);
      const ok = size === cur.declaredSize;
      await tx.update('blob', b.orgId, b.id, {
        status: ok ? 'quarantined' : 'rejected',
        rejectReason: ok ? null : 'size_mismatch',
        size,
        completedAt: now,
        uploadExpiresAt: null,
      });
      await this.#enqueue(tx, b.orgId, ok ? 'scan' : 'delete_blob', b.id, now);
      return {
        uploadId: b.id,
        status: ok ? ('processing' as const) : ('rejected' as const),
        partSize: cur.partSize,
        partCount: cur.partCount,
        uploadedParts: [],
        bytesUploaded: size,
        rejectReason: ok ? null : 'size_mismatch',
      };
    });
  }

  async #abort(b: BlobRow) {
    return this.#d.store.transaction(async (tx) => {
      const now = this.#now();
      const cur = await tx.getForUpdate('blob', b.orgId, b.id);
      if (!cur) throw notFound();
      if (cur.status !== 'uploading') throw new DomainError('conflict', 'only an unfinished upload can be cancelled');
      await this.#detachUpload(tx, cur, now);
      return { aborted: true };
    });
  }

  /** Marks an unfinished upload for deletion and removes the file entry it created. */
  async #detachUpload(tx: SharingTx, b: BlobRow, now: Date) {
    await tx.update('blob', b.orgId, b.id, { status: 'deleting' });
    if (b.targetType === 'transfer_file') await tx.update('transferFile', b.orgId, b.targetId, { status: 'removed', updatedAt: now });
    if (b.targetType === 'submission_file') await tx.update('submissionFile', b.orgId, b.targetId, { status: 'removed' });
    await this.#enqueue(tx, b.orgId, 'delete_blob', b.id, now);
  }

  /** Owner download of any clean object in the organization's workspace (draft, version, transfer or submission). */
  async ownerFileUrl(
    p: UserPrincipal,
    orgId: string,
    ref: {
      type: 'draft' | 'version' | 'transfer_file' | 'submission_file';
      id: string;
      documentId?: string;
    },
  ) {
    await this.#d.authorize(p, orgId, 'share:read');
    const s = this.#d.store;
    let blobId: string | undefined;
    let name = 'download';
    if (ref.type === 'draft') {
      const d = await s.get('document', orgId, ref.id);
      if (d?.status === 'active' && d.draftBlobId) [blobId, name] = [d.draftBlobId, `${d.title} (draft).pdf`];
    } else if (ref.type === 'version') {
      const v = await s.get('version', orgId, ref.id);
      const d = v && (await s.get('document', orgId, v.documentId));
      if (v && d?.status === 'active') [blobId, name] = [v.blobId, v.fileName];
    } else if (ref.type === 'transfer_file') {
      const f = await s.get('transferFile', orgId, ref.id);
      if (f?.status === 'current') [blobId, name] = [f.blobId, f.name];
    } else {
      const f = await s.get('submissionFile', orgId, ref.id);
      const request = f && (await s.get('uploadRequest', orgId, f.requestId));
      if (f?.status === 'current' && request && (await this.#isManager(p, orgId, request.createdBy))) [blobId, name] = [f.blobId, f.name];
    }
    const b = blobId ? await s.get('blob', orgId, blobId) : undefined;
    if (!b) throw notFound();
    if (b.status !== 'clean')
      throw new DomainError('conflict', 'the file is not available', {
        status: fileStatus(b.status),
      });
    const limits = await this.limits(orgId);
    await s.transaction(async (tx) => {
      const now = this.#now();
      await tx.lockAccount(orgId, now);
      if ((await tx.addUsage(orgId, monthKey(now), 'bandwidth_bytes', b.size ?? 0)) > limits.bandwidthBytesPerMonth) throw quota('bandwidth');
    });
    return this.#signedDownload(b, name, 'attachment');
  }

  async #signedDownload(b: BlobRow, filename: string, disposition: 'inline' | 'attachment', ttlSeconds = this.#c.downloadUrlTtlSeconds) {
    const expiresAt = this.#at(ttlSeconds * 1000);
    const url = await this.#d.objects.signDownload(b.objectKey, {
      filename,
      contentType: FILE_KINDS[b.ext]?.contentType ?? 'application/octet-stream',
      disposition,
      expiresAt,
    });
    return { url, expiresAt, disposition: contentDisposition(disposition, filename) };
  }

  // =============================================================================================
  // Share links (access policies)
  // =============================================================================================

  #shareUrl(l: Pick<LinkRow, 'id' | 'salt'>) {
    return `${this.#c.publicOrigin}/s/${this.#d.keys.token('share', l.id, l.salt)}`;
  }

  async createLink(
    p: UserPrincipal,
    orgId: string,
    input: {
      targetType: 'transfer' | 'document';
      targetId: string;
      versionMode?: 'latest' | 'fixed' | undefined;
      versionId?: string | undefined;
      permission: SharePermission;
      password?: string | undefined;
      expiresAt?: Date | undefined;
      maxDownloads?: number | undefined;
      restriction?: 'none' | 'members' | 'recipients' | undefined;
      recipients?: string[] | undefined;
      notifyOnAccess?: boolean | undefined;
      label?: string | undefined;
    },
  ) {
    if (!PERMISSIONS.includes(input.permission)) throw invalid('invalid permission');
    const restriction = input.restriction ?? 'none';
    const recipients = [...new Set((input.recipients ?? []).map(normalizeEmail))];
    if (recipients.length > 50) throw invalid('at most 50 recipients');
    if (restriction === 'recipients' && !recipients.length) throw invalid('name at least one recipient');
    if (restriction !== 'recipients' && recipients.length) throw invalid('recipients require restriction "recipients"');
    if (input.permission === 'review' && restriction === 'none') throw invalid('review links must be restricted to authenticated recipients');
    const passwordHash = await this.#passwordHash(input.password);
    const label = text(input.label, 200, 'label');
    if (input.maxDownloads !== undefined && (!Number.isInteger(input.maxDownloads) || input.maxDownloads < 1 || input.maxDownloads > 100_000))
      throw invalid('invalid download limit');
    return this.#mutate(p, orgId, 'share:create', async (tx, { now }) => {
      if (input.expiresAt && input.expiresAt <= now) throw invalid('expiry must be in the future');
      const target = await this.#checkTarget(tx, p, orgId, input);
      const salt = newSalt();
      const id = newId('lnk');
      const token = this.#d.keys.token('share', id, salt);
      const link: LinkRow = {
        id,
        orgId,
        salt,
        tokenHash: tokenHash(token),
        createdBy: p.userId,
        label,
        targetType: input.targetType,
        targetId: input.targetId,
        versionMode: target.versionMode,
        versionId: target.versionId,
        permission: input.permission,
        passwordHash,
        expiresAt: input.expiresAt ?? null,
        maxDownloads: input.maxDownloads ?? null,
        downloadCount: 0,
        restriction,
        recipients,
        notifyOnAccess: input.notifyOnAccess ?? false,
        status: 'active',
        statusReason: null,
        operatorHold: false,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert('link', link);
      await this.#audit(
        tx,
        { type: 'user', id: p.userId },
        orgId,
        'share.link.created',
        { type: 'share_link', id },
        {
          target_type: link.targetType,
          target_id: link.targetId,
          version_mode: link.versionMode,
          version_id: link.versionId,
          permission: link.permission,
          restriction,
          recipients: recipients.length,
          password: !!passwordHash,
          expires_at: link.expiresAt?.toISOString() ?? null,
          max_downloads: link.maxDownloads,
        },
      );
      return this.#linkView(link, now, true);
    });
  }

  /** Whether links can be emailed from this deployment (a mail provider is configured). */
  get emailEnabled(): boolean {
    return !!this.#d.mailer;
  }

  /**
   * Emails a share link to recipients with an optional personal message (WeTransfer-style "send by email"). The worker
   * sends each email and derives the link token again at that moment; it is never stored in the job. Senders must have
   * a confirmed address (it is shown to the recipient and used as reply-to), and emails are capped per month.
   */
  async emailLink(
    p: UserPrincipal,
    orgId: string,
    linkId: string,
    input: { to: string[]; message?: string | undefined; remindBeforeExpiry?: boolean | undefined },
  ) {
    if (!this.#d.mailer) throw new DomainError('conflict', 'email delivery is not set up yet; copy the link and send it yourself');
    if (!p.emailVerified) throw new DomainError('forbidden', 'confirm your email address before sending emails');
    const to = [...new Set(input.to.map(normalizeEmail))];
    if (!to.length || to.length > 20) throw invalid('send to between 1 and 20 addresses');
    const message = text(input.message, 2000, 'message');
    return this.#mutate(p, orgId, 'share:create', async (tx, { now, limits }) => {
      const l = await tx.getForUpdate('link', orgId, linkId);
      if (!l) throw notFound();
      await this.#requireManager(p, orgId, l.createdBy);
      if (effectiveLinkState(l, now, true) !== 'active') throw invalid('this link is no longer active');
      const transfer = l.targetType === 'transfer' ? await tx.get('transfer', orgId, l.targetId) : undefined;
      const expires = [l.expiresAt, transfer?.expiresAt].filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0];
      const remindAt = input.remindBeforeExpiry && expires && expires.getTime() > now.getTime() + 86400000 ? new Date(expires.getTime() - 86400000) : undefined;
      const emailCount = to.length * (remindAt ? 2 : 1);
      if ((await tx.addUsage(orgId, monthKey(now), 'emails_sent', emailCount)) > limits.emailsPerMonth) throw quota('email');
      for (const addr of to) {
        await this.#enqueue(tx, orgId, 'share_email', l.id, now, { to: addr, from: p.email, message: message ?? '' });
        if (remindAt) await this.#enqueue(tx, orgId, 'share_email', l.id, remindAt, { to: addr, from: p.email, message: '', mode: 'expiry_reminder' });
      }
      await this.#audit(tx, { type: 'user', id: p.userId }, orgId, 'share.link.emailed', { type: 'share_link', id: l.id }, { recipients: to.length });
      return { sent: to.length };
    });
  }

  async #checkTarget(
    r: SharingRepo,
    p: UserPrincipal,
    orgId: string,
    input: {
      targetType: 'transfer' | 'document';
      targetId: string;
      versionMode?: 'latest' | 'fixed' | undefined;
      versionId?: string | undefined;
      permission: SharePermission;
    },
  ): Promise<{ versionMode: 'latest' | 'fixed' | null; versionId: string | null }> {
    if (input.targetType === 'transfer') {
      if (input.versionMode || input.versionId) throw invalid('transfers have no versions');
      if (input.permission === 'review') throw invalid('review links are available for documents');
      const tr = await r.get('transfer', orgId, input.targetId);
      if (!tr || tr.status !== 'active') throw notFound();
      await this.#requireManager(p, orgId, tr.createdBy);
      return { versionMode: null, versionId: null };
    }
    const doc = await r.get('document', orgId, input.targetId);
    if (!doc || doc.status !== 'active') throw notFound();
    await this.#requireManager(p, orgId, doc.createdBy);
    if (input.versionMode === 'latest') {
      if (input.versionId) throw invalid('latest links follow the published version; omit version_id');
      return { versionMode: 'latest', versionId: null };
    }
    if (input.versionMode !== 'fixed' || !input.versionId) throw invalid('choose "latest" or a fixed version_id');
    const v = await r.get('version', orgId, input.versionId);
    if (!v || v.documentId !== doc.id) throw notFound();
    if (doc.requireApproval && input.permission !== 'review' && !v.publishedAt && !(await this.#approved(r, orgId, v)))
      throw new DomainError('conflict', 'only approved or published versions can be shared for viewing or download');
    return { versionMode: 'fixed', versionId: v.id };
  }

  async #passwordHash(pw: string | undefined | null): Promise<string | null> {
    if (pw === undefined || pw === null) return null;
    if (pw.length < 8 || pw.length > 128) throw invalid('passwords must be 8–128 characters');
    return this.#d.passwords.hash(pw);
  }

  async listLinks(p: UserPrincipal, orgId: string, filter?: { targetId?: string | undefined }) {
    await this.#d.authorize(p, orgId, 'share:read');
    const rows = await this.#d.store.list('link', orgId, filter?.targetId ? { targetId: filter.targetId } : {}, { limit: 1000 });
    const now = this.#now();
    return Promise.all(rows.map((l) => this.#linkView(l, now, false)));
  }

  async getLink(p: UserPrincipal, orgId: string, linkId: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    const l = await this.#d.store.get('link', orgId, linkId);
    if (!l) throw notFound();
    return this.#linkView(l, this.#now(), true);
  }

  async #linkView(l: LinkRow, now: Date, withUrl: boolean) {
    const target = await this.#resolveTarget(this.#d.store, l, now);
    return {
      id: l.id,
      label: l.label,
      url: withUrl ? this.#shareUrl(l) : undefined,
      targetType: l.targetType,
      targetId: l.targetId,
      versionMode: l.versionMode,
      versionId: l.versionId,
      servesVersion: target.version ? target.version.number : null,
      permission: l.permission,
      restriction: l.restriction,
      recipients: l.recipients,
      hasPassword: !!l.passwordHash,
      expiresAt: l.expiresAt,
      maxDownloads: l.maxDownloads,
      downloadCount: l.downloadCount,
      notifyOnAccess: l.notifyOnAccess,
      status: l.status,
      operatorHold: l.operatorHold,
      state: effectiveLinkState(l, now, target.usable),
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
    };
  }

  async updateLink(
    p: UserPrincipal,
    orgId: string,
    linkId: string,
    input: {
      label?: string | null | undefined;
      expiresAt?: Date | null | undefined;
      maxDownloads?: number | null | undefined;
      password?: string | null | undefined;
      restriction?: 'none' | 'members' | 'recipients' | undefined;
      recipients?: string[] | undefined;
      notifyOnAccess?: boolean | undefined;
      permission?: SharePermission | undefined;
      versionId?: string | undefined;
    },
  ) {
    const newHash = input.password === undefined ? undefined : await this.#passwordHash(input.password);
    return this.#mutate(p, orgId, 'share:create', async (tx, { now }) => {
      const l = await tx.getForUpdate('link', orgId, linkId);
      if (!l || l.status === 'revoked') throw notFound();
      await this.#requireManager(p, orgId, l.createdBy);
      const next: LinkRow = { ...l, updatedAt: now };
      if (input.label !== undefined) next.label = text(input.label, 200, 'label');
      if (input.expiresAt !== undefined) {
        if (input.expiresAt && input.expiresAt <= now) throw invalid('expiry must be in the future');
        next.expiresAt = input.expiresAt;
      }
      if (input.maxDownloads !== undefined) {
        if (input.maxDownloads !== null && (!Number.isInteger(input.maxDownloads) || input.maxDownloads < 1 || input.maxDownloads > 100_000))
          throw invalid('invalid download limit');
        if (input.maxDownloads !== null && input.maxDownloads < l.downloadCount)
          throw invalid(`the limit cannot be lower than the ${l.downloadCount} downloads already made`);
        next.maxDownloads = input.maxDownloads;
      }
      if (newHash !== undefined) next.passwordHash = newHash;
      if (input.restriction !== undefined) next.restriction = input.restriction;
      if (input.recipients !== undefined) next.recipients = [...new Set(input.recipients.map(normalizeEmail))];
      if (input.notifyOnAccess !== undefined) next.notifyOnAccess = input.notifyOnAccess;
      if (input.permission !== undefined) {
        if (!PERMISSIONS.includes(input.permission)) throw invalid('invalid permission');
        next.permission = input.permission;
      }
      if (input.versionId !== undefined) {
        if (l.versionMode !== 'fixed') throw invalid('only fixed-version links can be re-pinned');
        next.versionId = input.versionId;
      }
      if (next.recipients.length > 50) throw invalid('at most 50 recipients');
      if (next.restriction === 'recipients' && !next.recipients.length) throw invalid('name at least one recipient');
      if (next.restriction !== 'recipients') next.recipients = [];
      if (next.permission === 'review' && next.restriction === 'none') throw invalid('review links must be restricted to authenticated recipients');
      await this.#checkTarget(tx, p, orgId, {
        targetType: next.targetType,
        targetId: next.targetId,
        versionMode: next.versionMode ?? undefined,
        versionId: next.versionId ?? undefined,
        permission: next.permission,
      });
      await tx.update('link', orgId, linkId, next);
      await this.#audit(
        tx,
        { type: 'user', id: p.userId },
        orgId,
        'share.link.updated',
        { type: 'share_link', id: linkId },
        {
          changed: Object.keys(input)
            .filter((k) => (input as Record<string, unknown>)[k] !== undefined)
            .sort(),
          version_id: next.versionId,
          permission: next.permission,
          restriction: next.restriction,
          expires_at: next.expiresAt?.toISOString() ?? null,
        },
      );
      return this.#linkView(next, now, true);
    });
  }

  /** Revocation (terminal), suspension and resumption by the owner. Operator holds cannot be lifted here. */
  async setLinkStatus(p: UserPrincipal, orgId: string, linkId: string, action: 'revoke' | 'suspend' | 'resume', reason?: string) {
    return this.#mutate(p, orgId, 'share:create', async (tx, { now }) => {
      const l = await tx.getForUpdate('link', orgId, linkId);
      if (!l) throw notFound();
      await this.#requireManager(p, orgId, l.createdBy);
      const status = nextStatus(l, action);
      await tx.update('link', orgId, linkId, {
        status,
        statusReason: text(reason, 500, 'reason'),
        updatedAt: now,
      });
      await this.#audit(
        tx,
        { type: 'user', id: p.userId },
        orgId,
        `share.link.${action === 'revoke' ? 'revoked' : action === 'suspend' ? 'suspended' : 'resumed'}`,
        {
          type: 'share_link',
          id: linkId,
        },
        undefined,
        text(reason, 500, 'reason'),
      );
      return this.#linkView({ ...l, status, updatedAt: now }, now, true);
    });
  }

  /** Delivery receipts: distinct visit, authenticated access, view, download and acknowledgement events. */
  async linkActivity(p: UserPrincipal, orgId: string, linkId: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    const l = await this.#d.store.get('link', orgId, linkId);
    if (!l) throw notFound();
    const since = dayKey(new Date(this.#now().getTime() - 400 * 86_400_000));
    const [events, stats] = await Promise.all([
      this.#d.store.list('event', orgId, { subjectType: 'share', subjectId: linkId }, { limit: 500 }),
      this.#d.store.listStats(orgId, 'share', linkId, since),
    ]);
    return {
      linkId,
      totals: totals(stats),
      events: events.map(eventView),
      notes: [
        'A visit or access event shows the link was opened. It is not proof that anyone read the document.',
        'Email security scanners and link previews can open links automatically; obvious bots are counted separately.',
        'Acknowledgements are explicit confirmations. Unauthenticated acknowledgements carry a self-declared name.',
      ],
    };
  }

  // =============================================================================================
  // Public share access
  // =============================================================================================

  async #resolveTarget(r: SharingRepo, l: LinkRow, now: Date): Promise<ResolvedTarget> {
    if (l.targetType === 'transfer') {
      const tr = await r.get('transfer', l.orgId, l.targetId);
      const usable = !!tr && tr.status === 'active' && (!tr.expiresAt || tr.expiresAt > now);
      return { usable, transfer: tr, document: undefined, version: undefined };
    }
    const doc = await r.get('document', l.orgId, l.targetId);
    if (!doc || doc.status !== 'active') return { usable: false, transfer: undefined, document: doc, version: undefined };
    const versionId = l.versionMode === 'fixed' ? l.versionId : doc.publishedVersionId;
    const v = versionId ? await r.get('version', l.orgId, versionId) : undefined;
    const ok = !!v && v.documentId === doc.id;
    return { usable: ok, transfer: undefined, document: doc, version: ok ? v : undefined };
  }

  async #linkByToken(token: string): Promise<LinkRow> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw notFound();
    const l = await this.#d.store.findUnique('link', 'tokenHash', tokenHash(token));
    if (!l) throw notFound();
    return l;
  }

  /** Server-side recipient restriction. Same message for every refusal so membership is not revealed. */
  async #recipient(l: { orgId: string; restriction: LinkRow['restriction']; recipients: string[] }, principal: UserPrincipal | undefined) {
    if (!principal) {
      if (l.restriction === 'none') return null;
      throw new DomainError('unauthenticated', 'sign in to open this link');
    }
    const who = await this.#d.identity(principal.userId);
    const deny = () => new DomainError('forbidden', 'this link is restricted to specific recipients');
    if (l.restriction === 'members' && !(await this.#d.isMember(l.orgId, principal.userId))) throw deny();
    if (l.restriction === 'recipients' && (!who || !who.emailVerified || !l.recipients.includes(who.email))) throw deny();
    return { userId: principal.userId, email: who?.email ?? null };
  }

  async #checkPassword(key: string, hash: string | null, supplied: string | undefined, onFail: () => Promise<void>) {
    if (!hash) return;
    const now = this.#now();
    const locked = () => new DomainError('rate_limited', 'too many incorrect passwords; try again later');
    if (!supplied) {
      const a = await this.#d.store.findAttempt(key);
      if (a?.lockedUntil && a.lockedUntil > now) throw locked();
      throw new DomainError('password_required', 'a password is required');
    }
    // Counted before checking, so parallel guesses cannot exceed the limit; a correct password clears the count.
    if (!(await this.#d.store.reserveAttempt(key, now, this.#c.passwordMaxFailures, this.#c.passwordLockMinutes * 60_000))) throw locked();
    if (supplied.length > 128 || !(await this.#d.passwords.verify(supplied, hash))) {
      await onFail();
      throw new DomainError('password_required', 'incorrect password');
    }
    await this.#d.store.clearAttempt(key);
  }

  async #recordEvent(
    tx: SharingRepo,
    subject: { orgId: string; subjectType: 'share' | 'request'; subjectId: string },
    kind: EventKind,
    ctx: PublicContext,
    extra: Partial<Pick<EventRow, 'userId' | 'email' | 'fileId' | 'declaredName'>> = {},
  ) {
    const now = this.#now();
    const bot = looksAutomated(ctx.userAgent);
    const ref = kind === 'visit' || kind === 'access' ? referrerHost(ctx.referer) : '';
    await tx.insert('event', {
      id: newId('evt'),
      orgId: subject.orgId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      kind,
      userId: extra.userId ?? null,
      email: extra.email ?? null,
      fileId: extra.fileId ?? null,
      bot,
      referrerHost: ref,
      declaredName: extra.declaredName ?? null,
      createdAt: now,
    });
    await tx.bumpStat({ ...subject, day: dayKey(now), kind, bot, referrerHost: ref }, 1);
  }

  async #notify(tx: SharingTx, orgId: string, userId: string, kind: string, subject: { type: string; id: string }, message: string, email: boolean) {
    const now = this.#now();
    await tx.insert('notification', {
      id: newId('ntf'),
      orgId,
      userId,
      kind,
      subjectType: subject.type,
      subjectId: subject.id,
      message,
      createdAt: now,
      readAt: null,
    });
    if (email && this.#d.mailer && kind === 'share.downloaded') {
      const pending = (await tx.list('job', orgId, { kind: 'notify_email', subjectId: userId }, { limit: 1000 })).find(
        (j) => j.payload['digest'] === 'downloads' && !j.claim,
      );
      if (pending) await tx.update('job', orgId, pending.id, { payload: { ...pending.payload, count: String(Number(pending.payload['count'] ?? '0') + 1) } });
      else await this.#enqueue(tx, orgId, 'notify_email', userId, new Date(now.getTime() + 86400000), { userId, digest: 'downloads', count: '1' });
      return;
    }
    if (email && this.#d.mailer)
      await this.#enqueue(tx, orgId, 'notify_email', subject.id, now, {
        userId,
        subject: 'Rokela PDF Pro sharing notification',
        text: `${message}\n\nOpen your Rokela workspace to see details. You receive this because notifications are on for this item.`,
      });
  }

  /** Opens a share link: state, restriction and password checks, then a short-lived grant and the manifest. */
  async openShare(token: string, input: { password?: string | undefined }, ctx: PublicContext) {
    const l = await this.#linkByToken(token);
    const now = this.#now();
    const target = await this.#resolveTarget(this.#d.store, l, now);
    const state = effectiveLinkState(l, now, target.usable);
    if (state !== 'active') throw unavailable(state === 'unavailable' && l.versionMode === 'latest' && target.document ? 'not_published' : state);
    const who = await this.#recipient(l, ctx.principal);
    await this.#checkPassword(`share:${l.id}`, l.passwordHash, input.password, () =>
      this.#d.store.transaction((tx) => this.#recordEvent(tx, { orgId: l.orgId, subjectType: 'share', subjectId: l.id }, 'password_failed', ctx)),
    );
    await this.#d.store.transaction(async (tx) => {
      await this.#recordEvent(tx, { orgId: l.orgId, subjectType: 'share', subjectId: l.id }, who ? 'access' : 'visit', ctx, {
        userId: who?.userId ?? null,
        email: who?.email ?? null,
      });
      if (who && l.notifyOnAccess && !looksAutomated(ctx.userAgent))
        await this.#notify(
          tx,
          l.orgId,
          l.createdBy,
          'share.accessed',
          { type: 'share_link', id: l.id },
          `${who.email ?? 'A signed-in recipient'} opened your shared link${l.label ? ` "${l.label}"` : ''}.`,
          true,
        );
    });
    const exp = Math.floor(now.getTime() / 1000) + this.#c.grantTtlSeconds;
    const grant = this.#d.keys.grant({ k: 'share', s: l.id, u: who?.userId ?? null, exp });
    return {
      ...(await this.#manifest(l, target, now)),
      grant,
      grantExpiresAt: new Date(exp * 1000),
    };
  }

  async #manifest(l: LinkRow, target: ResolvedTarget, _now: Date) {
    const brand = await this.#brand(l.orgId);
    const base = {
      permission: l.permission,
      restriction: l.restriction,
      expiresAt: l.expiresAt,
      downloadsRemaining: l.maxDownloads === null ? null : Math.max(0, l.maxDownloads - l.downloadCount),
      branding: brand,
      notices: NOTICES,
    };
    if (target.transfer) {
      const files = (await this.#transferFiles(l.orgId, target.transfer.id)).map((f) => {
        return {
          id: f.id,
          name: f.name,
          folderPath: f.folderPath,
          size: f.size,
          contentType: f.contentType,
          status: f.status,
          viewable: f.status === 'available' && f.inline,
          downloadable: f.status === 'available' && permits(l.permission, 'download'),
          revision: f.revision,
          replacedAt: f.replacedAt,
          replacementNote: f.replacementNote,
        };
      });
      return {
        ...base,
        kind: 'transfer' as const,
        title: target.transfer.title,
        message: target.transfer.message,
        transferExpiresAt: target.transfer.expiresAt,
        files,
      };
    }
    const doc = target.document!;
    const v = target.version!;
    const blob = await this.#d.store.get('blob', l.orgId, v.blobId);
    const history =
      l.versionMode === 'latest'
        ? (await this.#d.store.list('version', l.orgId, { documentId: doc.id }, { limit: 1000 }))
            .filter((x) => x.publishedAt)
            .sort((a, b) => b.number - a.number)
            .map((x) => ({
              number: x.number,
              publishedAt: x.publishedAt,
              replacementNote: x.replacementNote,
            }))
        : [];
    return {
      ...base,
      kind: 'document' as const,
      title: doc.title,
      version: {
        mode: l.versionMode,
        number: v.number,
        publishedAt: v.publishedAt,
        replacementNote: l.versionMode === 'latest' ? v.replacementNote : null,
        label:
          l.versionMode === 'fixed'
            ? `Fixed version ${v.number}. This link always serves this exact version.`
            : `Latest published version (version ${v.number}). This link follows the version the sender publishes.`,
      },
      history,
      files: [
        {
          id: v.id,
          name: v.fileName,
          folderPath: '',
          size: blob?.size ?? 0,
          contentType: 'application/pdf',
          status: fileStatus(blob?.status ?? 'deleted'),
          viewable: blob?.status === 'clean',
          downloadable: blob?.status === 'clean' && permits(l.permission, 'download'),
          revision: v.number,
          replacedAt: null,
          replacementNote: null,
        },
      ],
    };
  }

  /** Every grant use re-checks the link, target and restriction: revocation applies to the very next request. */
  async #useGrant(token: string, grant: string | undefined, ctx: PublicContext) {
    const l = await this.#linkByToken(token);
    const now = this.#now();
    const claims: GrantClaims | undefined = this.#d.keys.verifyGrant(grant, now.getTime());
    if (!claims || claims.k !== 'share' || claims.s !== l.id) throw new DomainError('unauthenticated', 'your access has expired; open the link again');
    if (claims.u && ctx.principal?.userId !== claims.u) throw new DomainError('unauthenticated', 'sign in again to continue');
    const target = await this.#resolveTarget(this.#d.store, l, now);
    const state = effectiveLinkState(l, now, target.usable);
    if (state !== 'active') throw unavailable(state);
    const who = await this.#recipient(l, claims.u ? ctx.principal : undefined);
    return { l, target, who, now };
  }

  async shareFileUrl(token: string, input: { grant: string; fileId: string; disposition: 'inline' | 'attachment' }, ctx: PublicContext) {
    const { l, target, who } = await this.#useGrant(token, input.grant, ctx);
    let blobId: string;
    let name: string;
    if (target.transfer) {
      const f = await this.#d.store.get('transferFile', l.orgId, input.fileId);
      if (!f || f.transferId !== target.transfer.id || f.status !== 'current') throw notFound();
      [blobId, name] = [f.blobId, f.name];
    } else {
      if (target.version!.id !== input.fileId) throw new DomainError('conflict', 'a newer version was published; reload the page');
      [blobId, name] = [target.version!.blobId, target.version!.fileName];
    }
    const blob = await this.#d.store.get('blob', l.orgId, blobId);
    if (!blob || blob.status !== 'clean')
      throw new DomainError('conflict', 'this file is not available yet', {
        status: fileStatus(blob?.status ?? 'deleted'),
      });
    const kind = FILE_KINDS[blob.ext];
    if (input.disposition === 'inline' && !kind?.inline) throw new DomainError('forbidden', 'this file type cannot be viewed in the browser');
    if (input.disposition === 'attachment' && !permits(l.permission, 'download')) throw new DomainError('forbidden', 'this link is view-only');
    const limits = await this.limits(l.orgId);
    await this.#d.store.transaction(async (tx) => {
      const now = this.#now();
      await tx.lockAccount(l.orgId, now);
      const cur = await tx.getForUpdate('link', l.orgId, l.id);
      if (!cur || cur.status !== 'active') throw unavailable(cur?.status ?? 'revoked');
      if (input.disposition === 'attachment') {
        if (cur.maxDownloads !== null && cur.downloadCount >= cur.maxDownloads) throw unavailable('download_limit_reached');
        await tx.update('link', l.orgId, l.id, { downloadCount: cur.downloadCount + 1 });
      }
      if ((await tx.addUsage(l.orgId, monthKey(now), 'bandwidth_bytes', blob.size ?? 0)) > limits.bandwidthBytesPerMonth)
        throw new DomainError('quota_exceeded', 'this share is temporarily unavailable');
      const kindName = input.disposition === 'attachment' ? 'download' : 'view';
      await this.#recordEvent(tx, { orgId: l.orgId, subjectType: 'share', subjectId: l.id }, kindName, ctx, {
        userId: who?.userId ?? null,
        email: who?.email ?? null,
        fileId: input.fileId,
      });
      if (kindName === 'download' && l.notifyOnAccess && !looksAutomated(ctx.userAgent))
        await this.#notify(
          tx,
          l.orgId,
          l.createdBy,
          'share.downloaded',
          { type: 'share_link', id: l.id },
          `${who?.email ?? 'A recipient'} downloaded a file from your shared link${l.label ? ` "${l.label}"` : ''}.`,
          true,
        );
    });
    return this.#signedDownload(blob, name, input.disposition);
  }

  /**
   * "Download all" for a transfer: counts as ONE download against the link's limit, meters the bandwidth of every
   * file, and returns signed URLs that the recipient's browser fetches and zips. The URLs live a little longer than
   * single-file ones so a large set can be fetched in turn.
   */
  async shareArchive(token: string, input: { grant: string }, ctx: PublicContext) {
    const { l, target, who } = await this.#useGrant(token, input.grant, ctx);
    if (!target.transfer) throw invalid('only transfers can be downloaded as a whole');
    if (!permits(l.permission, 'download')) throw new DomainError('forbidden', 'this link is view-only');
    const files = await this.#d.store.list('transferFile', l.orgId, { transferId: target.transfer.id, status: 'current' }, { limit: 5000, order: 'oldest' });
    const ready: Array<{ f: (typeof files)[number]; blob: BlobRow }> = [];
    for (const f of files) {
      const blob = await this.#d.store.get('blob', l.orgId, f.blobId);
      if (blob?.status === 'clean') ready.push({ f, blob });
    }
    if (!ready.length) throw new DomainError('conflict', 'no files are available yet');
    const limits = await this.limits(l.orgId);
    await this.#d.store.transaction(async (tx) => {
      const now = this.#now();
      await tx.lockAccount(l.orgId, now);
      const cur = await tx.getForUpdate('link', l.orgId, l.id);
      if (!cur || cur.status !== 'active') throw unavailable(cur?.status ?? 'revoked');
      if (cur.maxDownloads !== null && cur.downloadCount >= cur.maxDownloads) throw unavailable('download_limit_reached');
      await tx.update('link', l.orgId, l.id, { downloadCount: cur.downloadCount + 1 });
      const bytes = ready.reduce((n, x) => n + (x.blob.size ?? 0), 0);
      if ((await tx.addUsage(l.orgId, monthKey(now), 'bandwidth_bytes', bytes)) > limits.bandwidthBytesPerMonth)
        throw new DomainError('quota_exceeded', 'this share is temporarily unavailable');
      await this.#recordEvent(tx, { orgId: l.orgId, subjectType: 'share', subjectId: l.id }, 'download', ctx, {
        userId: who?.userId ?? null,
        email: who?.email ?? null,
      });
      if (l.notifyOnAccess && !looksAutomated(ctx.userAgent))
        await this.#notify(
          tx,
          l.orgId,
          l.createdBy,
          'share.downloaded',
          { type: 'share_link', id: l.id },
          `${who?.email ?? 'A recipient'} downloaded all files from your shared link${l.label ? ` "${l.label}"` : ''}.`,
          true,
        );
    });
    const ttl = Math.max(this.#c.downloadUrlTtlSeconds, 900);
    const out = [];
    for (const { f, blob } of ready)
      out.push({
        id: f.id,
        name: f.name,
        folderPath: f.folderPath,
        size: blob.size ?? f.size,
        ...(await this.#signedDownload(blob, f.name, 'attachment', ttl)),
      });
    return { title: target.transfer.title, files: out };
  }

  /** Explicit acknowledgement, recorded as its own event (never inferred from a visit or download). */
  async acknowledgeShare(token: string, input: { grant: string; declaredName?: string | undefined }, ctx: PublicContext) {
    const { l, who } = await this.#useGrant(token, input.grant, ctx);
    const declared = text(input.declaredName, 100, 'name');
    if (!who && !declared) throw invalid('enter your name to acknowledge');
    const at = this.#now();
    await this.#d.store.transaction(async (tx) => {
      await this.#recordEvent(tx, { orgId: l.orgId, subjectType: 'share', subjectId: l.id }, 'acknowledge', ctx, {
        userId: who?.userId ?? null,
        email: who?.email ?? null,
        declaredName: declared,
      });
      if (l.notifyOnAccess)
        await this.#notify(
          tx,
          l.orgId,
          l.createdBy,
          'share.acknowledged',
          { type: 'share_link', id: l.id },
          `${who?.email ?? `${declared} (unverified name)`} acknowledged receipt of your shared link${l.label ? ` "${l.label}"` : ''}.`,
          true,
        );
    });
    return { acknowledgedAt: at, verifiedIdentity: !!who };
  }

  async #reviewContext(token: string, grant: string | undefined, ctx: PublicContext) {
    const g = await this.#useGrant(token, grant, ctx);
    if (!permits(g.l.permission, 'comment') || !g.target.version || !g.who) throw new DomainError('forbidden', 'this link does not allow review');
    return { ...g, version: g.target.version, who: g.who };
  }

  async reviewComments(token: string, grant: string | undefined, ctx: PublicContext) {
    const { l, version } = await this.#reviewContext(token, grant, ctx);
    return this.#thread(l.orgId, version);
  }

  async addComment(token: string, input: { grant: string; body: string; page?: number | undefined }, ctx: PublicContext) {
    const { l, version, who } = await this.#reviewContext(token, input.grant, ctx);
    const body = text(input.body, 2000, 'comment');
    if (!body) throw invalid('comment is required');
    if (input.page !== undefined && (!Number.isInteger(input.page) || input.page < 1 || input.page > 100_000)) throw invalid('invalid page');
    return this.#d.store.transaction(async (tx) => {
      const now = this.#now();
      const c = {
        id: newId('cmt'),
        orgId: l.orgId,
        documentId: version.documentId,
        versionId: version.id,
        linkId: l.id,
        authorUserId: who.userId,
        body,
        page: input.page ?? null,
        createdAt: now,
      };
      await tx.insert('comment', c);
      await this.#recordEvent(tx, { orgId: l.orgId, subjectType: 'share', subjectId: l.id }, 'comment', ctx, { userId: who.userId, email: who.email });
      await this.#audit(
        tx,
        { type: 'user', id: who.userId },
        l.orgId,
        'share.review.commented',
        { type: 'share_document', id: version.documentId },
        { version_id: version.id, comment_id: c.id },
      );
      await this.#notify(
        tx,
        l.orgId,
        l.createdBy,
        'share.review.comment',
        { type: 'share_document', id: version.documentId },
        `${who.email ?? 'A reviewer'} commented on version ${version.number}.`,
        l.notifyOnAccess,
      );
      return { id: c.id, createdAt: now };
    });
  }

  async decideReview(token: string, input: { grant: string; decision: 'approved' | 'changes_requested'; note?: string | undefined }, ctx: PublicContext) {
    const { l, version, who } = await this.#reviewContext(token, input.grant, ctx);
    const note = text(input.note, 1000, 'note');
    return this.#d.store.transaction(async (tx) => {
      const now = this.#now();
      const existing = (await tx.list('review', l.orgId, { versionId: version.id, reviewerUserId: who.userId }, { limit: 1 }))[0];
      if (existing)
        await tx.update('review', l.orgId, existing.id, {
          decision: input.decision,
          note,
          linkId: l.id,
          updatedAt: now,
        });
      else
        await tx.insert('review', {
          id: newId('rvw'),
          orgId: l.orgId,
          documentId: version.documentId,
          versionId: version.id,
          linkId: l.id,
          reviewerUserId: who.userId,
          decision: input.decision,
          note,
          createdAt: now,
          updatedAt: now,
        });
      await this.#recordEvent(tx, { orgId: l.orgId, subjectType: 'share', subjectId: l.id }, 'review', ctx, { userId: who.userId, email: who.email });
      await this.#audit(
        tx,
        { type: 'user', id: who.userId },
        l.orgId,
        'share.review.decided',
        { type: 'share_document', id: version.documentId },
        { version_id: version.id, decision: input.decision },
      );
      await this.#notify(
        tx,
        l.orgId,
        l.createdBy,
        'share.review.decision',
        { type: 'share_document', id: version.documentId },
        `${who.email ?? 'A reviewer'} ${input.decision === 'approved' ? 'approved' : 'requested changes to'} version ${version.number}.`,
        l.notifyOnAccess,
      );
      return { decision: input.decision, updatedAt: now };
    });
  }

  // =============================================================================================
  // Short links
  // =============================================================================================

  #shortUrl(s: ShortLinkRow, domains: Map<string, string>): string {
    if (s.kind === 'confidential') return `${this.#c.publicOrigin}/d/${this.#d.keys.token('short', s.id, s.salt!, 16)}`;
    const host = s.domainId ? domains.get(s.domainId) : undefined;
    return `${host ? `https://${host}` : this.#c.shortOrigin}${publicShortPath(s.code!)}`;
  }

  async #domainHosts(orgId: string): Promise<Map<string, string>> {
    return new Map((await this.#d.store.list('domain', orgId, {}, { limit: 100 })).map((d) => [d.id, d.hostname]));
  }

  async #checkDestination(
    r: SharingRepo,
    orgId: string,
    kind: 'public' | 'confidential',
    type: DestinationType,
    url: string | undefined,
    targetId: string | undefined,
  ) {
    if (kind === 'public') {
      if (type !== 'external' || !url) throw invalid('public short links point to external web addresses');
      return {
        destinationUrl: validateExternalDestination(url, this.#d.destinations),
        targetId: null,
      };
    }
    if (type === 'external' || !targetId) throw invalid('confidential short links point to a share link or upload request');
    const row = type === 'share' ? await r.get('link', orgId, targetId) : await r.get('uploadRequest', orgId, targetId);
    if (!row) throw notFound();
    return { destinationUrl: null, targetId };
  }

  async createShortLink(
    p: UserPrincipal,
    orgId: string,
    input: {
      kind: 'public' | 'confidential';
      destinationType: DestinationType;
      destinationUrl?: string | undefined;
      targetId?: string | undefined;
      alias?: string | undefined;
      domainId?: string | undefined;
      expiresAt?: Date | undefined;
      password?: string | undefined;
      requireAuth?: boolean | undefined;
      label?: string | undefined;
      folder?: string | undefined;
      tags?: string[] | undefined;
    },
  ) {
    if (input.kind === 'confidential' && (input.alias || input.domainId || input.password || input.requireAuth))
      throw invalid('confidential short links use an unpredictable code; access control belongs to the share link');
    const alias = input.alias ? validateAlias(input.alias) : undefined;
    const passwordHash = await this.#passwordHash(input.password);
    const folder = folderName(input.folder);
    const tags = tagList(input.tags);
    const label = text(input.label, 200, 'label');
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#mutate(p, orgId, 'share:create', async (tx, { now, limits }) => {
          if (input.expiresAt && input.expiresAt <= now) throw invalid('expiry must be in the future');
          const dest = await this.#checkDestination(tx, orgId, input.kind, input.destinationType, input.destinationUrl, input.targetId);
          if (input.domainId) {
            if (!limits.customDomains) throw new DomainError('forbidden', 'custom domains are not included in this plan');
            const d = await tx.get('domain', orgId, input.domainId);
            if (!d || d.status !== 'verified') throw new DomainError('conflict', 'the domain is not verified');
          }
          const id = newId('sln');
          const salt = input.kind === 'confidential' ? newSalt() : null;
          const code = input.kind === 'public' ? (alias ?? newPublicCode()) : null;
          const lookupKey = input.kind === 'public' ? `p|${input.domainId ?? ''}|${code}` : `c|${tokenHash(this.#d.keys.token('short', id, salt!, 16))}`;
          const row: ShortLinkRow = {
            id,
            orgId,
            kind: input.kind,
            domainId: input.domainId ?? null,
            code,
            salt,
            lookupKey,
            destinationType: input.destinationType,
            destinationUrl: dest.destinationUrl,
            targetId: dest.targetId,
            status: 'active',
            statusReason: null,
            operatorHold: false,
            expiresAt: input.expiresAt ?? null,
            passwordHash,
            requireAuth: input.requireAuth ?? false,
            label,
            folder,
            tags,
            createdBy: p.userId,
            createdAt: now,
            updatedAt: now,
          };
          await tx.insert('shortLink', row);
          await tx.insert('destination', {
            id: newId('dst'),
            orgId,
            shortLinkId: id,
            destinationType: row.destinationType,
            destinationUrl: row.destinationUrl,
            targetId: row.targetId,
            changedBy: p.userId,
            reason: 'created',
            createdAt: now,
          });
          await this.#audit(
            tx,
            { type: 'user', id: p.userId },
            orgId,
            'short_link.created',
            { type: 'short_link', id },
            {
              kind: row.kind,
              destination_type: row.destinationType,
              destination_host: row.destinationUrl ? new URL(row.destinationUrl).hostname : null,
              target_id: row.targetId,
              custom_alias: !!alias,
            },
          );
          return this.#shortView(row, await this.#domainHosts(orgId), now);
        });
      } catch (e) {
        if (e instanceof Error && e.message === 'duplicate:shortLink') {
          if (alias) throw new DomainError('conflict', 'alias not available');
          if (attempt < 4) continue;
        }
        throw e;
      }
    }
  }

  #shortView(s: ShortLinkRow, domains: Map<string, string>, now: Date) {
    return {
      id: s.id,
      kind: s.kind,
      url: this.#shortUrl(s, domains),
      code: s.code,
      domainId: s.domainId,
      destinationType: s.destinationType,
      destinationUrl: s.destinationUrl,
      targetId: s.targetId,
      status: s.status,
      operatorHold: s.operatorHold,
      state: effectiveLinkState(s, now, true),
      expiresAt: s.expiresAt,
      hasPassword: !!s.passwordHash,
      requireAuth: s.requireAuth,
      label: s.label,
      folder: s.folder,
      tags: s.tags,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  async listShortLinks(p: UserPrincipal, orgId: string, q: { q?: string; folder?: string; tag?: string; status?: 'active' | 'suspended' | 'revoked' }) {
    await this.#d.authorize(p, orgId, 'share:read');
    const [rows, domains] = await Promise.all([this.#d.store.searchShortLinks(orgId, { ...q, q: q.q?.slice(0, 200), limit: 500 }), this.#domainHosts(orgId)]);
    const now = this.#now();
    return rows.map((r) => this.#shortView(r, domains, now));
  }

  async getShortLink(p: UserPrincipal, orgId: string, id: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    const s = await this.#d.store.get('shortLink', orgId, id);
    if (!s) throw notFound();
    return this.#shortView(s, await this.#domainHosts(orgId), this.#now());
  }

  /** Editable destination with history and audit. Codes and kinds never change. */
  async updateShortLink(
    p: UserPrincipal,
    orgId: string,
    id: string,
    input: {
      destinationUrl?: string | undefined;
      targetId?: string | undefined;
      reason?: string | undefined;
      expiresAt?: Date | null | undefined;
      password?: string | null | undefined;
      requireAuth?: boolean | undefined;
      label?: string | null | undefined;
      folder?: string | undefined;
      tags?: string[] | undefined;
    },
  ) {
    const newHash = input.password === undefined ? undefined : await this.#passwordHash(input.password);
    return this.#mutate(p, orgId, 'share:create', async (tx, { now }) => {
      const s = await tx.getForUpdate('shortLink', orgId, id);
      if (!s || s.status === 'revoked') throw notFound();
      await this.#requireManager(p, orgId, s.createdBy);
      const next: ShortLinkRow = { ...s, updatedAt: now };
      const changesDestination = input.destinationUrl !== undefined || input.targetId !== undefined;
      if (changesDestination) {
        const d = await this.#checkDestination(tx, orgId, s.kind, s.destinationType, input.destinationUrl, input.targetId);
        next.destinationUrl = d.destinationUrl;
        next.targetId = d.targetId;
      }
      if (input.expiresAt !== undefined) {
        if (input.expiresAt && input.expiresAt <= now) throw invalid('expiry must be in the future');
        next.expiresAt = input.expiresAt;
      }
      if (s.kind === 'confidential' && (newHash || input.requireAuth)) throw invalid('access control for confidential links belongs to the share link');
      if (newHash !== undefined) next.passwordHash = newHash;
      if (input.requireAuth !== undefined) next.requireAuth = input.requireAuth;
      if (input.label !== undefined) next.label = text(input.label, 200, 'label');
      if (input.folder !== undefined) next.folder = folderName(input.folder);
      if (input.tags !== undefined) next.tags = tagList(input.tags);
      await tx.update('shortLink', orgId, id, next);
      const reason = text(input.reason, 500, 'reason');
      if (changesDestination && (next.destinationUrl !== s.destinationUrl || next.targetId !== s.targetId)) {
        await tx.insert('destination', {
          id: newId('dst'),
          orgId,
          shortLinkId: id,
          destinationType: next.destinationType,
          destinationUrl: next.destinationUrl,
          targetId: next.targetId,
          changedBy: p.userId,
          reason,
          createdAt: now,
        });
        await this.#audit(
          tx,
          { type: 'user', id: p.userId },
          orgId,
          'short_link.destination_changed',
          { type: 'short_link', id },
          {
            from_host: s.destinationUrl ? new URL(s.destinationUrl).hostname : null,
            to_host: next.destinationUrl ? new URL(next.destinationUrl).hostname : null,
            from_target: s.targetId,
            to_target: next.targetId,
          },
          reason,
        );
      } else {
        await this.#audit(
          tx,
          { type: 'user', id: p.userId },
          orgId,
          'short_link.updated',
          { type: 'short_link', id },
          {
            changed: Object.keys(input)
              .filter((k) => (input as Record<string, unknown>)[k] !== undefined)
              .sort(),
          },
        );
      }
      return this.#shortView(next, await this.#domainHosts(orgId), now);
    });
  }

  async setShortLinkStatus(p: UserPrincipal, orgId: string, id: string, action: 'revoke' | 'suspend' | 'resume', reason?: string) {
    return this.#mutate(p, orgId, 'share:create', async (tx, { now }) => {
      const s = await tx.getForUpdate('shortLink', orgId, id);
      if (!s) throw notFound();
      await this.#requireManager(p, orgId, s.createdBy);
      const status = nextStatus(s, action);
      await tx.update('shortLink', orgId, id, {
        status,
        statusReason: text(reason, 500, 'reason'),
        updatedAt: now,
      });
      await this.#audit(
        tx,
        { type: 'user', id: p.userId },
        orgId,
        `short_link.${action === 'revoke' ? 'revoked' : action === 'suspend' ? 'suspended' : 'resumed'}`,
        { type: 'short_link', id },
        undefined,
        text(reason, 500, 'reason'),
      );
      return this.#shortView({ ...s, status }, await this.#domainHosts(orgId), now);
    });
  }

  /** Bulk management. All ids must belong to the organization; the whole batch applies or none of it does. */
  async bulkShortLinks(
    p: UserPrincipal,
    orgId: string,
    input: {
      ids: string[];
      action: 'revoke' | 'suspend' | 'resume' | 'move' | 'tag' | 'untag';
      folder?: string | undefined;
      tag?: string | undefined;
      reason?: string | undefined;
    },
  ) {
    const ids = [...new Set(input.ids)];
    if (!ids.length || ids.length > 100) throw invalid('choose 1–100 links');
    const folder = input.action === 'move' ? folderName(input.folder) : undefined;
    const tag = input.action === 'tag' || input.action === 'untag' ? tagList([input.tag ?? ''])[0] : undefined;
    if ((input.action === 'tag' || input.action === 'untag') && !tag) throw invalid('tag is required');
    return this.#mutate(p, orgId, 'share:create', async (tx, { now }) => {
      for (const id of ids) {
        const s = await tx.getForUpdate('shortLink', orgId, id);
        if (!s) throw notFound();
        await this.#requireManager(p, orgId, s.createdBy);
        const patch: Partial<ShortLinkRow> = { updatedAt: now };
        if (input.action === 'move') patch.folder = folder!;
        else if (input.action === 'tag') patch.tags = tagList([...s.tags, tag!]);
        else if (input.action === 'untag') patch.tags = s.tags.filter((t) => t !== tag);
        else patch.status = nextStatus(s, input.action);
        await tx.update('shortLink', orgId, id, patch);
      }
      await this.#audit(
        tx,
        { type: 'user', id: p.userId },
        orgId,
        'short_link.bulk_updated',
        { type: 'org', id: orgId },
        { action: input.action, count: ids.length, ids: ids.slice(0, 100) },
        text(input.reason, 500, 'reason'),
      );
      return { updated: ids.length };
    });
  }

  async shortLinkHistory(p: UserPrincipal, orgId: string, id: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    if (!(await this.#d.store.get('shortLink', orgId, id))) throw notFound();
    const rows = await this.#d.store.list('destination', orgId, { shortLinkId: id }, { limit: 1000, order: 'oldest' });
    const emails = new Map<string, string>();
    for (const u of new Set(rows.map((r) => r.changedBy))) emails.set(u, (await this.#d.identity(u))?.email ?? 'unknown');
    return rows.map((r) => ({
      destinationType: r.destinationType,
      destinationUrl: r.destinationUrl,
      targetId: r.targetId,
      changedBy: emails.get(r.changedBy),
      reason: r.reason,
      createdAt: r.createdAt,
    }));
  }

  async shortLinkQr(p: UserPrincipal, orgId: string, id: string): Promise<{ svg: string; fileName: string }> {
    const s = await this.getShortLink(p, orgId, id);
    return { svg: qrSvg(s.url), fileName: `qr-${s.code ?? s.id}.svg` };
  }

  /** Aggregate visits (bots separated). Referral hosts are an advanced-analytics feature and approximate. */
  async shortLinkStats(p: UserPrincipal, orgId: string, id: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    if (!(await this.#d.store.get('shortLink', orgId, id))) throw notFound();
    const limits = await this.limits(orgId);
    const since = dayKey(new Date(this.#now().getTime() - 90 * 86_400_000));
    const stats = await this.#d.store.listStats(orgId, 'short', id, since);
    const daily = new Map<string, { visits: number; bots: number }>();
    const refs = new Map<string, number>();
    for (const s of stats) {
      const d = daily.get(s.day) ?? { visits: 0, bots: 0 };
      if (s.bot) d.bots += s.count;
      else d.visits += s.count;
      daily.set(s.day, d);
      if (!s.bot && s.referrerHost) refs.set(s.referrerHost, (refs.get(s.referrerHost) ?? 0) + s.count);
    }
    return {
      totals: totals(stats),
      daily: [...daily.entries()].map(([day, v]) => ({ day, ...v })),
      referrers: limits.advancedAnalytics
        ? [...refs.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([host, count]) => ({ host, count }))
        : null,
      notes: [
        'Counts are aggregates; no IP addresses or individual visitor records are kept for short links.',
        'Email scanners and link previews can inflate counts. Obvious bots are reported separately.',
        'Referral hosts are approximate: many browsers and apps send no referrer.',
      ],
    };
  }

  #shortState(s: ShortLinkRow, now: Date) {
    const state = effectiveLinkState(s, now, true);
    if (state !== 'active') throw unavailable(state);
  }

  async #shortRow(host: string | undefined, code: string): Promise<ShortLinkRow> {
    const c = code.toLowerCase();
    if (!/^[a-z0-9-]{3,64}$/.test(c)) throw notFound();
    let domainKey = '';
    const h = (host ?? '').toLowerCase().replace(/:\d+$/, '');
    const defaultHost = new URL(this.#c.shortOrigin).hostname;
    const publicHost = new URL(this.#c.publicOrigin).hostname;
    if (h && h !== defaultHost && h !== publicHost) {
      // A verified custom domain has its own namespace; any other host serves the default namespace.
      const d = await this.#d.store.verifiedDomain(h);
      if (d) domainKey = d.id;
    }
    const s = await this.#d.store.findUnique('shortLink', 'lookupKey', `p|${domainKey}|${c}`);
    if (!s || s.kind !== 'public') throw notFound();
    return s;
  }

  async #countShort(s: ShortLinkRow, ctx: PublicContext) {
    const now = this.#now();
    const bot = looksAutomated(ctx.userAgent);
    await this.#d.store.bumpStat(
      {
        orgId: s.orgId,
        subjectType: 'short',
        subjectId: s.id,
        day: dayKey(now),
        kind: 'visit',
        bot,
        referrerHost: referrerHost(ctx.referer),
      },
      1,
    );
  }

  /** Public short link: redirect target, or an interstitial when a password or sign-in is required. */
  async resolveShortLink(
    host: string | undefined,
    code: string,
    ctx: PublicContext,
  ): Promise<{ location: string } | { interstitial: { password: boolean; signIn: boolean; domain?: string } }> {
    const s = await this.#shortRow(host, code);
    this.#shortState(s, this.#now());
    await this.#countShort(s, ctx);
    if (s.passwordHash || s.requireAuth) {
      const domain = s.domainId ? await this.#d.store.get('domain', s.orgId, s.domainId) : undefined;
      return { interstitial: { password: !!s.passwordHash, signIn: s.requireAuth, ...(domain ? { domain: domain.hostname } : {}) } };
    }
    return { location: s.destinationUrl! };
  }

  async unlockShortLink(host: string | undefined, code: string, input: { password?: string | undefined; domain?: string | undefined }, ctx: PublicContext) {
    if (input.domain) {
      const domain = await this.#d.store.verifiedDomain(input.domain.toLowerCase());
      if (!domain) throw notFound();
      host = domain.hostname;
    }
    const s = await this.#shortRow(host, code);
    this.#shortState(s, this.#now());
    if (s.requireAuth && !ctx.principal) throw new DomainError('unauthenticated', 'sign in to open this link');
    await this.#checkPassword(`short:${s.id}`, s.passwordHash, input.password, async () => undefined);
    return { location: s.destinationUrl! };
  }

  async resolveConfidential(code: string, ctx: PublicContext): Promise<{ location: string }> {
    if (!/^[A-Za-z0-9_-]{16}$/.test(code)) throw notFound();
    const s = await this.#d.store.findUnique('shortLink', 'lookupKey', `c|${tokenHash(code)}`);
    if (!s || s.kind !== 'confidential') throw notFound();
    this.#shortState(s, this.#now());
    await this.#countShort(s, ctx);
    if (s.destinationType === 'share') {
      const l = await this.#d.store.get('link', s.orgId, s.targetId!);
      if (!l) throw notFound();
      return { location: this.#shareUrl(l) };
    }
    const r = await this.#d.store.get('uploadRequest', s.orgId, s.targetId!);
    if (!r) throw notFound();
    return { location: this.#requestUrl(r) };
  }

  // =============================================================================================
  // Upload requests (collect files without exposing other uploads)
  // =============================================================================================

  #requestUrl(r: Pick<UploadRequestRow, 'id' | 'salt'>) {
    return `${this.#c.publicOrigin}/r/${this.#d.keys.token('request', r.id, r.salt)}`;
  }

  createUploadRequest(p: UserPrincipal, orgId: string, input: UploadRequestInput) {
    return this.#createUploadRequest(p, orgId, input);
  }

  /** `within` runs in the same transaction after the request is inserted (fee desks; docs/receipt-processing.md). */
  async #createUploadRequest(
    p: UserPrincipal,
    orgId: string,
    input: UploadRequestInput,
    within?: (tx: SharingTx, request: UploadRequestRow, ctx: { now: Date; limits: SharingLimits }) => Promise<void>,
  ) {
    const t = title(input.title);
    const instructions = text(input.instructions, 4000, 'instructions');
    if (!input.requirements.length || input.requirements.length > 20) throw invalid('add 1–20 file requirements');
    const reqs: Requirement[] = input.requirements.map((r) => {
      if (!/^[a-z0-9_-]{1,40}$/.test(r.key)) throw invalid('invalid requirement key');
      const accept = [...new Set((r.accept?.length ? r.accept : Object.keys(FILE_KINDS)).map((a) => a.toLowerCase()))];
      if (accept.some((a) => !FILE_KINDS[a])) throw invalid('requirement accepts a type that is not permitted');
      const maxFiles = r.maxFiles ?? 1;
      if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 50) throw invalid('invalid file count');
      return {
        key: r.key,
        label: title(r.label, 'requirement label'),
        accept,
        required: r.required ?? true,
        maxFiles,
      };
    });
    if (new Set(reqs.map((r) => r.key)).size !== reqs.length) throw invalid('requirement keys must be unique');
    const passwordHash = await this.#passwordHash(input.password);
    return this.#mutate(p, orgId, 'share:create', async (tx, { now, limits }) => {
      if (!limits.uploadRequests) throw new DomainError('forbidden', 'upload requests are not included in this plan');
      if (input.deadline <= now || input.deadline.getTime() > now.getTime() + 366 * 86_400_000) throw invalid('the deadline must be within the next year');
      if (!Number.isSafeInteger(input.maxFileBytes) || input.maxFileBytes < 1 || input.maxFileBytes > limits.maxFileBytes) throw quota('file size');
      if (!Number.isSafeInteger(input.maxTotalBytes) || input.maxTotalBytes < input.maxFileBytes || input.maxTotalBytes > limits.storageBytes)
        throw quota('storage');
      let deleteAfter: Date | null;
      if (input.retentionDays === null) {
        if (!limits.persistent) throw new DomainError('forbidden', 'persistent retention is not included in this plan');
        deleteAfter = null;
      } else {
        const days = input.retentionDays ?? limits.maxRetentionDays;
        if (!Number.isInteger(days) || days < 1 || (days > limits.maxRetentionDays && !limits.persistent)) throw quota('retention');
        deleteAfter = new Date(input.deadline.getTime() + days * 86_400_000);
      }
      const id = newId('urq');
      const salt = newSalt();
      const row: UploadRequestRow = {
        id,
        orgId,
        salt,
        tokenHash: tokenHash(this.#d.keys.token('request', id, salt)),
        createdBy: p.userId,
        title: t,
        instructions,
        requirements: reqs,
        deadline: input.deadline,
        maxFileBytes: input.maxFileBytes,
        maxTotalBytes: input.maxTotalBytes,
        passwordHash,
        status: 'open',
        operatorHold: false,
        notify: input.notify ?? false,
        deleteAfter,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert('uploadRequest', row);
      await this.#audit(
        tx,
        { type: 'user', id: p.userId },
        orgId,
        'share.request.created',
        { type: 'upload_request', id },
        {
          requirements: reqs.length,
          deadline: row.deadline.toISOString(),
          delete_after: deleteAfter?.toISOString() ?? null,
          password: !!passwordHash,
        },
      );
      await within?.(tx, row, { now, limits });
      return this.#requestView(row, now);
    });
  }

  #requestView(r: UploadRequestRow, now: Date) {
    return {
      id: r.id,
      url: this.#requestUrl(r),
      title: r.title,
      instructions: r.instructions,
      requirements: r.requirements,
      deadline: r.deadline,
      maxFileBytes: r.maxFileBytes,
      maxTotalBytes: r.maxTotalBytes,
      hasPassword: !!r.passwordHash,
      notify: r.notify,
      status: r.status,
      operatorHold: r.operatorHold,
      accepting: r.status === 'open' && r.deadline > now,
      deleteAfter: r.deleteAfter,
      createdAt: r.createdAt,
    };
  }

  /** Native sign-and-return workflow. Submission identity is declared, not a signing certificate. */
  async createSignatureRequest(p: UserPrincipal, orgId: string, input: { documentId: string; deadline: Date; password?: string }) {
    await this.#d.authorize(p, orgId, 'share:create');
    const limits = await this.limits(orgId);
    if (!limits.uploadRequests) throw new DomainError('forbidden', 'signature collection requires upload requests in your plan');
    if (input.deadline <= this.#now()) throw invalid('deadline must be in the future');
    const document = await this.getDocument(p, orgId, input.documentId);
    if (!document.publishedVersionId) throw new DomainError('conflict', 'publish a document version before requesting a signature');
    const source = await this.createLink(p, orgId, {
      targetType: 'document',
      targetId: input.documentId,
      versionMode: 'fixed',
      versionId: document.publishedVersionId,
      permission: 'download',
      expiresAt: input.deadline,
      password: input.password,
      label: 'Signature source',
    });
    try {
      const request = await this.createUploadRequest(p, orgId, {
        title: `Signature requested: ${document.title}`.slice(0, 200),
        instructions: `Download the document: ${source.url}\nSign the PDF using Rokela's Sign PDF tool, then return the signed PDF here. Enter your name and email with your submission. Returned signatures are submitted by the signer; this is not certificate-based digital signing.`,
        requirements: [{ key: 'signed_pdf', label: 'Signed PDF', accept: ['pdf'], required: true, maxFiles: 1 }],
        deadline: input.deadline,
        maxFileBytes: Math.min(limits.maxFileBytes, 50 * 1024 * 1024),
        maxTotalBytes: Math.min(limits.maxFileBytes, 50 * 1024 * 1024),
        password: input.password,
        notify: true,
      });
      return { ...request, sourceUrl: source.url, sourceLinkId: source.id, documentId: input.documentId, versionId: document.publishedVersionId };
    } catch (e) {
      await this.setLinkStatus(p, orgId, source.id, 'revoke', 'Signature request could not be created');
      throw e;
    }
  }

  async listUploadRequests(p: UserPrincipal, orgId: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    const now = this.#now();
    return (await this.#d.store.list('uploadRequest', orgId, {}, { limit: 500 })).filter((r) => r.status !== 'purged').map((r) => this.#requestView(r, now));
  }

  async emailUploadRequest(p: UserPrincipal, orgId: string, id: string, input: { to: string[]; message?: string | undefined }) {
    if (!this.#d.mailer) throw new DomainError('conflict', 'email delivery is not configured; copy the link instead');
    if (!p.emailVerified) throw new DomainError('forbidden', 'confirm your email address before sending emails');
    const to = [...new Set(input.to.map(normalizeEmail))];
    if (!to.length || to.length > 20) throw invalid('send to between 1 and 20 addresses');
    const message = text(input.message, 2000, 'message');
    return this.#mutate(p, orgId, 'share:create', async (tx, { now, limits }) => {
      const request = await tx.getForUpdate('uploadRequest', orgId, id);
      if (!request) throw notFound();
      await this.#requireManager(p, orgId, request.createdBy);
      this.#requestAccepting(request, now);
      if ((await tx.addUsage(orgId, monthKey(now), 'emails_sent', to.length)) > limits.emailsPerMonth) throw quota('email');
      for (const addr of to)
        await this.#enqueue(tx, orgId, 'share_email', request.id, now, {
          mode: 'request_invitation',
          to: addr,
          from: p.email,
          message: message ?? '',
        });
      await this.#audit(tx, { type: 'user', id: p.userId }, orgId, 'share.request.emailed', { type: 'upload_request', id }, { recipients: to.length });
      return { queued: to.length };
    });
  }

  async getUploadRequest(p: UserPrincipal, orgId: string, id: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    const s = this.#d.store;
    const r = await s.get('uploadRequest', orgId, id);
    if (!r || r.status === 'purged') throw notFound();
    // What people submitted (often identity documents) is for the request's creator and the workspace's owners and
    // admins only; other members see that the request exists, not who sent what.
    if (!(await this.#isManager(p, orgId, r.createdBy))) return { ...this.#requestView(r, this.#now()), submissionsVisible: false, submissions: [] };
    const subs = await s.list('submission', orgId, { requestId: id }, { limit: 1000 });
    const files = await s.list('submissionFile', orgId, { requestId: id, status: 'current' }, { limit: 10_000, order: 'oldest' });
    const blobs = new Map<string, BlobRow>();
    for (const f of files) {
      const b = await s.get('blob', orgId, f.blobId);
      if (b) blobs.set(b.id, b);
    }
    return {
      ...this.#requestView(r, this.#now()),
      submissionsVisible: true,
      submissions: subs.map((x) => ({
        id: x.id,
        submitterName: x.submitterName,
        submitterEmail: x.submitterEmail,
        identityVerified: false,
        status: x.status,
        createdAt: x.createdAt,
        submittedAt: x.submittedAt,
        files: files
          .filter((f) => f.submissionId === x.id)
          .map((f) => ({
            id: f.id,
            requirementKey: f.requirementKey,
            name: f.name,
            size: f.size,
            status: fileStatus(blobs.get(f.blobId)?.status ?? 'deleted'),
            rejectReason: blobs.get(f.blobId)?.rejectReason ?? null,
          })),
      })),
    };
  }

  async closeUploadRequest(p: UserPrincipal, orgId: string, id: string, action: 'close' | 'delete') {
    return this.#mutate(p, orgId, 'share:create', async (tx, { now }) => {
      const r = await tx.getForUpdate('uploadRequest', orgId, id);
      if (!r || r.status === 'purged') throw notFound();
      await this.#requireManager(p, orgId, r.createdBy);
      const patch: Partial<UploadRequestRow> = { status: 'closed', updatedAt: now };
      if (action === 'delete') patch.deleteAfter = now;
      await tx.update('uploadRequest', orgId, id, patch);
      await this.#audit(tx, { type: 'user', id: p.userId }, orgId, action === 'close' ? 'share.request.closed' : 'share.request.deleted', {
        type: 'upload_request',
        id,
      });
      return this.#requestView({ ...r, ...patch }, now);
    });
  }

  async #requestByToken(token: string): Promise<UploadRequestRow> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw notFound();
    const r = await this.#d.store.findUnique('uploadRequest', 'tokenHash', tokenHash(token));
    if (!r || r.status === 'purged') throw notFound();
    return r;
  }

  #requestAccepting(r: UploadRequestRow, now: Date) {
    if (r.operatorHold) throw unavailable('suspended');
    if (r.status !== 'open') throw unavailable('closed');
    if (r.deadline <= now) throw unavailable('deadline_passed');
  }

  async openUploadRequest(token: string, input: { password?: string | undefined }, ctx: PublicContext) {
    const r = await this.#requestByToken(token);
    const now = this.#now();
    this.#requestAccepting(r, now);
    await this.#checkPassword(`request:${r.id}`, r.passwordHash, input.password, () =>
      this.#d.store.transaction((tx) => this.#recordEvent(tx, { orgId: r.orgId, subjectType: 'request', subjectId: r.id }, 'password_failed', ctx)),
    );
    await this.#d.store.transaction((tx) => this.#recordEvent(tx, { orgId: r.orgId, subjectType: 'request', subjectId: r.id }, 'visit', ctx));
    const exp = Math.floor(now.getTime() / 1000) + this.#c.grantTtlSeconds;
    return {
      title: r.title,
      instructions: r.instructions,
      requirements: r.requirements,
      deadline: r.deadline,
      maxFileBytes: r.maxFileBytes,
      maxTotalBytes: r.maxTotalBytes,
      branding: await this.#brand(r.orgId),
      feeDesk: await this.#publicFeeDesk(r.id),
      grant: this.#d.keys.grant({ k: 'request', s: r.id, u: null, exp }),
      notices: [
        'Your files are visible only to the requester. Other people using this page cannot see them, and you cannot see theirs.',
        'Files are checked before the requester can open them.',
      ],
    };
  }

  async startSubmission(
    token: string,
    input: { grant: string; name: string; email?: string | undefined; payment?: FeePaymentInput | undefined },
    ctx: PublicContext,
  ) {
    const r = await this.#requestByToken(token);
    const now = this.#now();
    const claims = this.#d.keys.verifyGrant(input.grant, now.getTime());
    if (!claims || claims.k !== 'request' || claims.s !== r.id) throw new DomainError('unauthenticated', 'open the request page again');
    this.#requestAccepting(r, now);
    const name = title(input.name, 'name');
    const email = input.email ? normalizeEmail(input.email) : null;
    const desk = await this.#d.store.findUnique('feeDesk', 'requestId', r.id);
    if (!desk && input.payment) throw invalid('this request does not take payment details');
    if (desk && !input.payment) throw invalid('enter the details of your bank payment');
    const payment = desk ? this.#feePayment(desk, input.payment!, now) : undefined;
    const secret = newSubmissionSecret();
    const sub: SubmissionRow = {
      id: newId('sbm'),
      orgId: r.orgId,
      requestId: r.id,
      secretHash: tokenHash(secret),
      submitterName: name,
      submitterEmail: email,
      status: 'open',
      createdAt: now,
      submittedAt: null,
    };
    await this.#d.store.transaction(async (tx) => {
      await tx.insert('submission', sub);
      if (desk && payment) {
        // Refused early so the payer need not upload first; the unique live key decides at submission.
        if ((await tx.list('feeClaim', r.orgId, { activeKey: payment.activeKey }, { limit: 1 })).length) throw duplicatePayment();
        await tx.insert('feeClaim', {
          id: newId('fcl'),
          orgId: r.orgId,
          deskId: desk.id,
          submissionId: sub.id,
          payerId: payment.payerId,
          payerName: name,
          bank: payment.bank,
          reference: payment.reference,
          referenceKey: payment.referenceKey,
          activeKey: null,
          amount: payment.amount,
          paidOn: payment.paidOn,
          status: 'draft',
          statusSecretHash: null,
          matchMethod: null,
          matchNote: null,
          statementLine: null,
          statementLineKey: null,
          matchIssue: null,
          matchedAt: null,
          matchedBy: null,
          rejectionReason: null,
          rejectionMessage: null,
          rejectedAt: null,
          rejectedBy: null,
          verifiedDocumentId: null,
          certificate: null,
          clearedAt: null,
          clearedBy: null,
          createdAt: now,
          submittedAt: null,
          updatedAt: now,
        });
      }
      await this.#recordEvent(tx, { orgId: r.orgId, subjectType: 'request', subjectId: r.id }, 'upload', ctx, { declaredName: name });
    });
    return { submissionId: sub.id, submissionSecret: secret };
  }

  async #submission(token: string, secret: string | undefined) {
    const r = await this.#requestByToken(token);
    if (!secret || !/^sub_[A-Za-z0-9_-]{43}$/.test(secret)) throw new DomainError('unauthenticated', 'submission not found');
    const sub = await this.#d.store.findUnique('submission', 'secretHash', tokenHash(secret));
    if (!sub || sub.requestId !== r.id) throw new DomainError('unauthenticated', 'submission not found');
    return { r, sub };
  }

  async beginSubmissionUpload(token: string, secret: string, input: { requirementKey: string; name: string; size: number }) {
    const { r, sub } = await this.#submission(token, secret);
    this.#requestAccepting(r, this.#now());
    if (sub.status !== 'open') throw new DomainError('conflict', 'this submission was already sent');
    const reqm = r.requirements.find((x) => x.key === input.requirementKey);
    if (!reqm) throw invalid('unknown requirement');
    const name = sanitizeFileName(input.name);
    const kind = requireFileKind(name, reqm.accept);
    if (!Number.isSafeInteger(input.size) || input.size < 1) throw invalid('invalid size');
    if (input.size > r.maxFileBytes) throw quota('file size');
    return this.#startMultipart(
      r.orgId,
      kind.ext,
      kind.contentType,
      input.size,
      async (tx, blob) => {
        const cur = await tx.getForUpdate('submission', r.orgId, sub.id);
        if (!cur || cur.status !== 'open') throw new DomainError('conflict', 'this submission was already sent');
        const existing = await tx.list('submissionFile', r.orgId, { submissionId: sub.id, status: 'current' }, { limit: 10_000 });
        if (existing.filter((f) => f.requirementKey === reqm.key).length >= reqm.maxFiles)
          throw new DomainError('conflict', 'enough files were uploaded for this requirement');
        if (existing.reduce((n, f) => n + f.size, 0) + input.size > r.maxTotalBytes) throw quota('submission size');
        // An unfinished upload reserves its declared size against the workspace's storage until it completes or
        // expires. Anyone holding the request link can start one, so bound what a request can reserve at once;
        // otherwise empty uploads could fill the owner's storage. Serialized by the account lock.
        const pending = await tx.pendingSubmissionUploads(r.orgId, r.id);
        if (pending.count >= MAX_PENDING_REQUEST_UPLOADS || pending.bytes + input.size > r.maxTotalBytes * PENDING_REQUEST_SUBMISSIONS)
          throw new DomainError('rate_limited', 'Too many uploads are in progress for this request. Try again in a few minutes.');
        const fileId = newId('sfl');
        blob.targetType = 'submission_file';
        blob.targetId = fileId;
        await tx.insert('blob', blob);
        await tx.insert('submissionFile', {
          id: fileId,
          orgId: r.orgId,
          requestId: r.id,
          submissionId: sub.id,
          blobId: blob.id,
          requirementKey: reqm.key,
          name,
          ext: kind.ext,
          size: input.size,
          status: 'current',
          createdAt: blob.createdAt,
        });
        return { fileId };
      },
      name,
    );
  }

  async #submissionUpload(token: string, secret: string, uploadId: string) {
    const { r, sub } = await this.#submission(token, secret);
    const b = await this.#d.store.get('blob', r.orgId, uploadId);
    const f = b?.targetType === 'submission_file' ? await this.#d.store.get('submissionFile', r.orgId, b.targetId) : undefined;
    if (!b || !f || f.submissionId !== sub.id || f.status !== 'current') throw notFound();
    return { r, sub, b };
  }

  async signSubmissionParts(token: string, secret: string, uploadId: string, parts: number[]) {
    const { r, b } = await this.#submissionUpload(token, secret, uploadId);
    this.#requestAccepting(r, this.#now());
    return this.#signParts(b, parts);
  }
  async submissionUploadStatus(token: string, secret: string, uploadId: string) {
    return this.#uploadStatus((await this.#submissionUpload(token, secret, uploadId)).b);
  }
  async completeSubmissionUpload(token: string, secret: string, uploadId: string) {
    return this.#complete((await this.#submissionUpload(token, secret, uploadId)).b);
  }
  async abortSubmissionUpload(token: string, secret: string, uploadId: string) {
    return this.#abort((await this.#submissionUpload(token, secret, uploadId)).b);
  }

  /** The submitter's own files only. */
  async removeSubmissionFile(token: string, secret: string, fileId: string) {
    const { r, sub } = await this.#submission(token, secret);
    this.#requestAccepting(r, this.#now());
    return this.#d.store.transaction(async (tx) => {
      const cur = await tx.getForUpdate('submission', r.orgId, sub.id);
      if (!cur || cur.status !== 'open') throw new DomainError('conflict', 'this submission was already sent');
      const file = await tx.getForUpdate('submissionFile', r.orgId, fileId);
      if (!file || file.submissionId !== sub.id || file.status !== 'current') throw notFound();
      const blob = await tx.getForUpdate('blob', r.orgId, file.blobId);
      if (blob?.status === 'uploading') await tx.update('blob', r.orgId, blob.id, { status: 'deleting' });
      await tx.update('submissionFile', r.orgId, file.id, { status: 'removed' });
      await this.#enqueue(tx, r.orgId, 'delete_blob', file.blobId, this.#now());
      await this.#audit(
        tx,
        { type: 'anonymous' },
        r.orgId,
        'share.request.file_removed',
        { type: 'upload_request', id: r.id },
        {
          submission_id: sub.id,
          file_id: file.id,
        },
      );
      return { removed: true };
    });
  }

  async submissionStatus(token: string, secret: string) {
    const { r, sub } = await this.#submission(token, secret);
    const files = await this.#d.store.list('submissionFile', r.orgId, { submissionId: sub.id, status: 'current' }, { limit: 10_000, order: 'oldest' });
    const out = [];
    for (const f of files) {
      const b = await this.#d.store.get('blob', r.orgId, f.blobId);
      out.push({
        id: f.id,
        requirementKey: f.requirementKey,
        name: f.name,
        size: f.size,
        status: fileStatus(b?.status ?? 'deleted'),
        uploadId: b?.status === 'uploading' ? b.id : null,
      });
    }
    // A payer whose submission went through but whose answer was lost gets their status link here.
    const claim = sub.status === 'submitted' ? await this.#d.store.findUnique('feeClaim', 'submissionId', sub.id) : undefined;
    return { submissionId: sub.id, status: sub.status, files: out, ...(claim?.statusSecretHash ? { feeStatusUrl: this.#feeStatusUrl(secret).url } : {}) };
  }

  async submit(token: string, secret: string, ctx: PublicContext) {
    const { r, sub } = await this.#submission(token, secret);
    const now = this.#now();
    this.#requestAccepting(r, now);
    return this.#d.store.transaction(async (tx) => {
      const cur = await tx.getForUpdate('submission', r.orgId, sub.id);
      if (!cur || cur.status !== 'open') throw new DomainError('conflict', 'this submission was already sent');
      const files = await tx.list('submissionFile', r.orgId, { submissionId: sub.id, status: 'current' }, { limit: 10_000 });
      const states = new Map<string, BlobRow['status']>();
      for (const f of files) states.set(f.id, (await tx.get('blob', r.orgId, f.blobId))?.status ?? 'deleted');
      if ([...states.values()].some((s) => s === 'uploading')) throw new DomainError('conflict', 'finish or cancel the uploads in progress first');
      const missing = r.requirements
        .filter((q) => q.required && !files.some((f) => f.requirementKey === q.key && ['quarantined', 'clean'].includes(states.get(f.id)!)))
        .map((q) => q.key);
      if (missing.length) throw new DomainError('conflict', 'required files are missing', { missing });
      await tx.update('submission', r.orgId, sub.id, { status: 'submitted', submittedAt: now });
      const fee = await this.#submitFeeClaim(tx, r.orgId, sub.id, secret, now);
      await this.#recordEvent(tx, { orgId: r.orgId, subjectType: 'request', subjectId: r.id }, 'submitted', ctx, { declaredName: sub.submitterName });
      await this.#audit(
        tx,
        { type: 'anonymous' },
        r.orgId,
        'share.request.submission_received',
        { type: 'upload_request', id: r.id },
        { submission_id: sub.id, files: files.length },
      );
      await this.#notify(
        tx,
        r.orgId,
        r.createdBy,
        'request.submitted',
        { type: 'upload_request', id: r.id },
        `${sub.submitterName} (unverified name) sent ${files.length} file(s) to your upload request "${r.title}".`,
        r.notify,
      );
      return { submissionId: sub.id, status: 'submitted' as const, submittedAt: now, ...(fee ? { feeStatusUrl: fee } : {}) };
    });
  }

  // =============================================================================================
  // Notifications, branding, custom domains
  // =============================================================================================

  async listNotifications(p: UserPrincipal, orgId: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    return (await this.#d.store.list('notification', orgId, { userId: p.userId }, { limit: 100 })).map((n) => ({
      id: n.id,
      kind: n.kind,
      subjectType: n.subjectType,
      subjectId: n.subjectId,
      message: n.message,
      createdAt: n.createdAt,
      read: !!n.readAt,
    }));
  }

  async markNotificationsRead(p: UserPrincipal, orgId: string, ids: string[]) {
    await this.#d.authorize(p, orgId, 'share:read');
    if (ids.length > 100) throw invalid('at most 100 ids');
    await this.#d.store.transaction(async (tx) => {
      const now = this.#now();
      for (const id of new Set(ids)) {
        const n = await tx.get('notification', orgId, id);
        if (n && n.userId === p.userId && !n.readAt) await tx.update('notification', orgId, id, { readAt: now });
      }
    });
    return { read: ids.length };
  }

  async #brand(orgId: string) {
    const limits = await this.limits(orgId);
    if (!limits.branding) return null;
    const b = await this.#d.store.get('brand', orgId, orgId);
    return b ? { displayName: b.displayName, accentColor: b.accentColor } : null;
  }

  async getBranding(p: UserPrincipal, orgId: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    const b = await this.#d.store.get('brand', orgId, orgId);
    return {
      available: (await this.limits(orgId)).branding,
      displayName: b?.displayName ?? null,
      accentColor: b?.accentColor ?? null,
    };
  }

  async setBranding(p: UserPrincipal, orgId: string, input: { displayName: string; accentColor: string }) {
    const displayName = title(input.displayName, 'display name');
    const accentColor = validateAccentColor(input.accentColor);
    return this.#mutate(p, orgId, 'share:manage', async (tx, { now, limits }) => {
      if (!limits.branding) throw new DomainError('forbidden', 'branded pages are not included in this plan');
      const row = { id: orgId, orgId, displayName, accentColor, updatedAt: now };
      if (await tx.get('brand', orgId, orgId)) await tx.update('brand', orgId, orgId, row);
      else await tx.insert('brand', row);
      await this.#audit(tx, { type: 'user', id: p.userId }, orgId, 'share.branding.updated', { type: 'org', id: orgId }, { accent_color: accentColor });
      return { available: true, displayName, accentColor };
    });
  }

  #domainView(d: {
    id: string;
    hostname: string;
    status: string;
    verificationToken: string;
    verifiedAt: Date | null;
    checkedAt: Date | null;
    missingSince?: Date | null;
    createdAt: Date;
  }) {
    const missingSince = d.missingSince ?? null;
    return {
      id: d.id,
      hostname: d.hostname,
      status: d.status,
      verification: {
        recordType: 'TXT',
        name: `_rokela-challenge.${d.hostname}`,
        value: `rokela-verify=${d.verificationToken}`,
      },
      verifiedAt: d.verifiedAt,
      checkedAt: d.checkedAt,
      missingSince,
      /** When a still-missing record makes the domain stop working. */
      lapsesAt: missingSince ? new Date(missingSince.getTime() + this.#c.domainGraceDays * 86_400_000) : null,
      createdAt: d.createdAt,
      routing:
        'After verification, point a CNAME for the hostname at the platform short-link host; the operator provisions TLS for it at the edge. Keep the TXT record in place: ownership is re-checked daily.',
    };
  }

  async addDomain(p: UserPrincipal, orgId: string, input: { hostname: string }) {
    const hostname = validateHostname(input.hostname);
    const reserved = [new URL(this.#c.publicOrigin).hostname, new URL(this.#c.shortOrigin).hostname, ...this.#d.destinations.reservedHosts];
    if (reserved.some((h) => hostname === h || hostname.endsWith(`.${h}`))) throw invalid('this hostname belongs to the platform');
    try {
      return await this.#mutate(p, orgId, 'share:manage', async (tx, { now, limits }) => {
        if (!limits.customDomains) throw new DomainError('forbidden', 'custom domains are not included in this plan');
        const holder = await tx.verifiedDomain(hostname);
        if (holder && holder.orgId !== orgId) throw new DomainError('conflict', 'this hostname is already verified by another workspace');
        const row = {
          id: newId('dom'),
          orgId,
          hostname,
          verificationToken: randomBytes(16).toString('hex'),
          status: 'pending' as const,
          createdAt: now,
          verifiedAt: null,
          checkedAt: null,
          missingSince: null,
        };
        await tx.insert('domain', row);
        await this.#audit(tx, { type: 'user', id: p.userId }, orgId, 'share.domain.added', { type: 'custom_domain', id: row.id }, { hostname });
        return this.#domainView(row);
      });
    } catch (e) {
      if (e instanceof Error && e.message === 'duplicate:domain') throw new DomainError('conflict', 'this workspace already added this hostname');
      throw e;
    }
  }

  async listDomains(p: UserPrincipal, orgId: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    return (await this.#d.store.list('domain', orgId, {}, { limit: 100 })).map((d) => this.#domainView(d));
  }

  /** Ownership check by DNS TXT record. The platform resolves DNS only; it never requests the tenant's site. */
  async verifyDomain(p: UserPrincipal, orgId: string, id: string) {
    await this.#d.authorize(p, orgId, 'share:manage');
    const d = await this.#d.store.get('domain', orgId, id);
    if (!d) throw notFound();
    const found = (await this.#challenge(d)) === 'found';
    try {
      return await this.#verifyDomainRecord(p, orgId, id, found);
    } catch (e) {
      if (e instanceof Error && e.message === 'duplicate:domain') throw new DomainError('conflict', 'this hostname is already verified by another workspace');
      throw e;
    }
  }

  /**
   * Looks up the domain's TXT challenge. 'missing' only on a definite answer (no such name or record, or no matching
   * value); timeouts and resolver failures are 'unknown', so a DNS outage never counts against a domain.
   */
  async #challenge(d: DomainRow): Promise<'found' | 'missing' | 'unknown'> {
    if (!this.#d.resolveTxt) return 'unknown';
    try {
      const records = await this.#d.resolveTxt(`_rokela-challenge.${d.hostname}`);
      return records.some((parts) => parts.join('') === `rokela-verify=${d.verificationToken}`) ? 'found' : 'missing';
    } catch (e) {
      const code = (e as { code?: string })?.code;
      return code === 'ENOTFOUND' || code === 'ENODATA' ? 'missing' : 'unknown';
    }
  }

  /**
   * Daily re-check of verified domains. A missing record starts a grace period with a warning to the workspace's
   * managers; if it is still missing when the period ends the domain returns to pending (its short links stop
   * resolving on it, and the hostname can be verified again by whoever controls its DNS).
   */
  async #recheckDomains(now: Date, limit: number): Promise<{ checked: number; lapsed: number }> {
    const out = { checked: 0, lapsed: 0 };
    const due = await this.#d.store.domainsDueForCheck(new Date(now.getTime() - this.#c.domainRecheckHours * 3_600_000), limit);
    const graceMs = this.#c.domainGraceDays * 86_400_000;
    for (const d of due) {
      const result = await this.#challenge(d);
      out.checked++;
      await this.#d.store.transaction(async (tx) => {
        const cur = await tx.getForUpdate('domain', d.orgId, d.id);
        if (!cur || cur.status !== 'verified') return;
        if (result !== 'missing') {
          await tx.update('domain', d.orgId, d.id, { checkedAt: now, ...(result === 'found' ? { missingSince: null } : {}) });
          return;
        }
        if (!cur.missingSince) {
          await tx.update('domain', d.orgId, d.id, { checkedAt: now, missingSince: now });
          const until = new Date(now.getTime() + graceMs).toUTCString();
          await this.#warnManagers(
            tx,
            cur,
            'domain.record_missing',
            `The DNS verification record for ${cur.hostname} is missing. Restore the TXT record before ${until}, or short links on this domain will stop working.`,
          );
          return;
        }
        if (now.getTime() - cur.missingSince.getTime() < graceMs) {
          await tx.update('domain', d.orgId, d.id, { checkedAt: now });
          return;
        }
        await tx.update('domain', d.orgId, d.id, { status: 'pending', verifiedAt: null, missingSince: null, checkedAt: now });
        await tx.audit.append({
          actor: { type: 'system' },
          action: 'share.domain.lapsed',
          target: { type: 'custom_domain', id: cur.id },
          orgId: cur.orgId,
          metadata: { hostname: cur.hostname, missing_since: cur.missingSince.toISOString() },
        });
        await this.#warnManagers(
          tx,
          cur,
          'domain.lapsed',
          `${cur.hostname} is no longer verified because its DNS verification record stayed missing. Short links on it stop working until you restore the record and check the domain again.`,
        );
        out.lapsed++;
      });
    }
    return out;
  }

  async #warnManagers(tx: SharingTx, d: DomainRow, kind: string, message: string) {
    for (const userId of (await this.#d.managers?.(d.orgId)) ?? [])
      await this.#notify(tx, d.orgId, userId, kind, { type: 'custom_domain', id: d.id }, message, true);
  }

  #verifyDomainRecord(p: UserPrincipal, orgId: string, id: string, found: boolean) {
    return this.#mutate(p, orgId, 'share:manage', async (tx, { now }) => {
      const cur = await tx.getForUpdate('domain', orgId, id);
      if (!cur) throw notFound();
      if (!found) {
        await tx.update('domain', orgId, id, { checkedAt: now });
        return { ...this.#domainView({ ...cur, checkedAt: now }), verified: false };
      }
      await tx.update('domain', orgId, id, {
        status: 'verified',
        verifiedAt: cur.verifiedAt ?? now,
        checkedAt: now,
        missingSince: null,
      });
      if (cur.status !== 'verified')
        await this.#audit(tx, { type: 'user', id: p.userId }, orgId, 'share.domain.verified', { type: 'custom_domain', id }, { hostname: cur.hostname });
      return {
        ...this.#domainView({
          ...cur,
          status: 'verified',
          verifiedAt: cur.verifiedAt ?? now,
          checkedAt: now,
          missingSince: null,
        }),
        verified: true,
      };
    });
  }

  async removeDomain(p: UserPrincipal, orgId: string, id: string) {
    return this.#mutate(p, orgId, 'share:manage', async (tx) => {
      const d = await tx.getForUpdate('domain', orgId, id);
      if (!d) throw notFound();
      const inUse = (await tx.list('shortLink', orgId, { domainId: id }, { limit: 1000 })).some((s) => s.status !== 'revoked');
      if (inUse) throw new DomainError('conflict', 'revoke the short links on this domain first');
      await tx.remove('domain', orgId, id);
      await this.#audit(tx, { type: 'user', id: p.userId }, orgId, 'share.domain.removed', { type: 'custom_domain', id }, { hostname: d.hostname });
      return { removed: true };
    });
  }

  // =============================================================================================
  // Verified documents (docs/verified-documents.md)
  // =============================================================================================

  #verificationView(v: VerifiedDocumentRow) {
    return {
      id: v.id,
      code: v.code,
      url: `${this.#c.publicOrigin}/v/${v.code}`,
      title: v.title,
      details: v.details,
      issuerName: v.issuerName,
      status: v.status,
      sha256: v.sha256,
      createdBy: v.createdBy,
      createdAt: v.createdAt,
      issuedAt: v.issuedAt,
      revokedAt: v.revokedAt,
      revocationReason: v.revocationReason,
    };
  }

  /** Reserves a verification code; the browser stamps it into the PDF and then issues the stamped file's digest. */
  async reserveVerification(p: UserPrincipal, orgId: string, input: { title: string; details: Array<{ label: string; value: string }> }) {
    const docTitle = title(input.title);
    if (!Array.isArray(input.details) || input.details.length > VERIFICATION_MAX_DETAILS) throw invalid(`at most ${VERIFICATION_MAX_DETAILS} details`);
    const details = input.details.map((d, i) => {
      const label = text(d.label, 40, `detail ${i + 1} label`);
      const value = text(d.value, 200, `detail ${i + 1} value`);
      if (!label || !value) throw invalid(`detail ${i + 1} needs a label and a value`);
      // Labels must not imitate the facts the verification page vouches for itself.
      if (VERIFICATION_RESERVED_LABELS.has(label.toLowerCase().replace(/[^a-z]/g, ''))) throw invalid(`detail ${i + 1} label is reserved`);
      return { label, value };
    });
    if (new Set(details.map((d) => d.label.toLowerCase())).size !== details.length) throw invalid('detail labels must be different');
    return this.#mutate(p, orgId, 'share:create', async (tx, { now, limits }) => {
      if (!limits.verifiedDocuments) throw new DomainError('forbidden', 'verified documents are not included in this plan');
      const org = await this.#d.organization?.(orgId);
      if (!org) throw notFound();
      if (org.kind !== 'team') throw new DomainError('forbidden', 'verified documents are issued from a team workspace');
      const row: VerifiedDocumentRow = {
        id: newId('vdoc'),
        orgId,
        code: verificationCode(),
        title: docTitle,
        details,
        issuerName: org.name,
        sha256: null,
        status: 'pending',
        createdBy: p.userId,
        createdAt: now,
        issuedAt: null,
        revokedAt: null,
        revokedBy: null,
        revocationReason: null,
      };
      await tx.insert('verifiedDocument', row);
      await this.#audit(tx, { type: 'user', id: p.userId }, orgId, 'share.verification.reserved', { type: 'verified_document', id: row.id });
      return this.#verificationView(row);
    });
  }

  /** Binds a reservation to the SHA-256 of the stamped PDF. Only its creator, once, within the reservation window. */
  async issueVerification(p: UserPrincipal, orgId: string, id: string, input: { sha256: string }) {
    const sha256 = String(input.sha256 ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw invalid('sha256 must be 64 hexadecimal characters');
    return this.#mutate(p, orgId, 'share:create', async (tx, { now, limits }) => {
      if (!limits.verifiedDocuments) throw new DomainError('forbidden', 'verified documents are not included in this plan');
      const v = await tx.getForUpdate('verifiedDocument', orgId, id);
      if (!v) throw notFound();
      if (v.createdBy !== p.userId) throw new DomainError('forbidden', 'only the person who reserved this code can issue it');
      if (v.status !== 'pending') throw new DomainError('conflict', 'this document has already been issued');
      if (now.getTime() - v.createdAt.getTime() > VERIFICATION_RESERVATION_MS) throw new DomainError('conflict', 'this reservation expired; start again');
      const issued: VerifiedDocumentRow = { ...v, sha256, status: 'active', issuedAt: now };
      await tx.update('verifiedDocument', orgId, id, { sha256, status: 'active', issuedAt: now });
      await this.#audit(tx, { type: 'user', id: p.userId }, orgId, 'share.verification.issued', { type: 'verified_document', id }, { sha256 });
      return this.#verificationView(issued);
    });
  }

  /** Issued and revoked documents (pending reservations are internal). */
  async listVerifications(p: UserPrincipal, orgId: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    return (await this.#d.store.list('verifiedDocument', orgId, {}, { limit: 500 }))
      .filter((v) => v.status !== 'pending')
      .map((v) => this.#verificationView(v));
  }

  /** Permanent. The creator or a workspace manager. */
  async revokeVerification(p: UserPrincipal, orgId: string, id: string, input: { reason: NonNullable<VerifiedDocumentRow['revocationReason']> }) {
    if (!VERIFICATION_REVOCATION_REASONS.includes(input.reason)) throw invalid('unknown revocation reason');
    return this.#mutate(p, orgId, 'share:read', async (tx, { now }) => {
      const v = await tx.getForUpdate('verifiedDocument', orgId, id);
      if (!v || v.status === 'pending') throw notFound();
      await this.#requireManager(p, orgId, v.createdBy);
      if (v.status === 'revoked') throw new DomainError('conflict', 'this document is already revoked');
      const revoked: VerifiedDocumentRow = { ...v, status: 'revoked', revokedAt: now, revokedBy: p.userId, revocationReason: input.reason };
      await tx.update('verifiedDocument', orgId, id, { status: 'revoked', revokedAt: now, revokedBy: p.userId, revocationReason: input.reason });
      await this.#audit(tx, { type: 'user', id: p.userId }, orgId, 'share.verification.revoked', { type: 'verified_document', id }, { reason: input.reason });
      return this.#verificationView(revoked);
    });
  }

  /**
   * Public verification page data. Unknown, malformed and pending codes are indistinguishable (404). Shows only what
   * the issuer published, the issuer name snapshot and the workspace's DNS-verified domains.
   */
  async publicVerification(rawCode: string) {
    const code = String(rawCode ?? '')
      .toUpperCase()
      .replace(/[\s-]/g, '');
    if (!/^[A-Z2-7]{20}$/.test(code)) throw notFound();
    const v = await this.#d.store.findUnique('verifiedDocument', 'code', code);
    if (!v || v.status === 'pending') throw notFound();
    const domains = await this.#d.store.list('domain', v.orgId, { status: 'verified' }, { limit: 20 });
    return {
      code: v.code,
      title: v.title,
      details: v.details,
      issuer: { name: v.issuerName, verifiedDomains: domains.map((d) => d.hostname).sort() },
      status: v.status,
      sha256: v.sha256,
      issuedAt: v.issuedAt,
      revokedAt: v.revokedAt,
      revocationReason: v.revocationReason,
    };
  }

  // =============================================================================================
  // Receipt processing (docs/receipt-processing.md)
  // =============================================================================================

  /** Validates a payer's declared payment against the desk. */
  #feePayment(desk: FeeDeskRow, input: FeePaymentInput, now: Date) {
    // The desk decides whether payers give an ID ("Student ID", "Member ID") or only a name.
    const label = desk.payerIdLabel ?? 'ID';
    const payerId = desk.payerIdLabel ? text(input.payerId, 60, label) : null;
    if (desk.payerIdLabel && !payerId) throw invalid(`${label} is required`);
    const bank = desk.banks.find((b) => b === input.bank);
    if (!bank) throw invalid('choose one of the listed banks');
    const reference = text(input.reference, 60, 'bank reference');
    const key = referenceKey(reference ?? '');
    if (!reference || key.length < 4) throw invalid('enter the transaction reference printed on your bank receipt');
    const amount = parseAmount(String(input.amount ?? ''));
    if (amount === undefined || amount <= 0) throw invalid('enter the amount you paid, for example 1500.00');
    const paidOn = String(input.paidOn ?? '');
    if (!isIsoDate(paidOn)) throw invalid('enter the payment date');
    if (paidOn > now.toISOString().slice(0, 10)) throw invalid('the payment date cannot be in the future');
    return { payerId, bank, reference, referenceKey: key, amount, paidOn, activeKey: `${bank}|${key}` };
  }

  /** On submission, a claim becomes live and its payer gets a private status link. */
  /**
   * The payer's status-link secret, derived from their submission secret: if the answer to the submission is lost, the
   * page asks for the submission's state with the same secret and gets the same link back. One-way, so the status link
   * never reveals the submission secret.
   */
  #feeStatusUrl(submissionSecret: string) {
    const secret = `fcs_${createHash('sha256').update(`fee-status:${submissionSecret}`).digest('base64url')}`;
    // The secret is in the fragment, so it never reaches server logs or other sites.
    return { secret, url: `${this.#c.publicOrigin}/fees/status#${secret}` };
  }

  async #submitFeeClaim(tx: SharingTx, orgId: string, submissionId: string, submissionSecret: string, now: Date): Promise<string | undefined> {
    const claim = await tx.findUnique('feeClaim', 'submissionId', submissionId);
    if (!claim) return undefined;
    const activeKey = `${claim.bank}|${claim.referenceKey}`;
    if ((await tx.list('feeClaim', orgId, { activeKey }, { limit: 1 })).length) throw duplicatePayment();
    const { secret, url } = this.#feeStatusUrl(submissionSecret);
    try {
      await tx.update('feeClaim', orgId, claim.id, { status: 'submitted', activeKey, statusSecretHash: tokenHash(secret), submittedAt: now, updatedAt: now });
    } catch (e) {
      if (e instanceof Error && e.message === 'duplicate:feeClaim') throw duplicatePayment();
      throw e;
    }
    await this.#audit(tx, { type: 'anonymous' }, orgId, 'fee.claim.submitted', { type: 'fee_claim', id: claim.id }, { desk_id: claim.deskId });
    return url;
  }

  async #publicFeeDesk(requestId: string) {
    const d = await this.#d.store.findUnique('feeDesk', 'requestId', requestId);
    return d
      ? {
          institution: d.institution,
          payerIdLabel: d.payerIdLabel,
          certificateTitle: d.certificateTitle,
          banks: d.banks,
          currency: d.currency,
          amountDue: d.amountDue,
        }
      : null;
  }

  #feeDeskView(d: FeeDeskRow, r: UploadRequestRow, now: Date, claims?: FeeClaimRow[]) {
    const counts = { submitted: 0, matched: 0, cleared: 0, rejected: 0 };
    for (const c of claims ?? []) if (c.status !== 'draft') counts[c.status]++;
    return {
      id: d.id,
      title: d.title,
      institution: d.institution,
      payerIdLabel: d.payerIdLabel,
      certificateTitle: d.certificateTitle,
      banks: d.banks,
      currency: d.currency,
      amountDue: d.amountDue,
      dateToleranceDays: d.dateToleranceDays,
      createdBy: d.createdBy,
      createdAt: d.createdAt,
      request: this.#requestView(r, now),
      ...(claims ? { counts } : {}),
    };
  }

  /** A desk stays reachable after its upload request is deleted: claims and certificates outlive the receipt photos. */
  async #feeDesk(orgId: string, id: string, tx: SharingRepo = this.#d.store) {
    const d = await tx.get('feeDesk', orgId, id);
    const r = d && (await tx.get('uploadRequest', orgId, d.requestId));
    if (!d || !r) throw notFound();
    return { d, r };
  }

  /**
   * A receipt desk: an upload request for bank payment claims, set up for students paying fees by default or for any
   * payers (customers, members, tenants) through the ID label and certificate title, from a team workspace that can issue verified documents. */
  async createFeeDesk(
    p: UserPrincipal,
    orgId: string,
    input: {
      title: string;
      instructions?: string | undefined;
      deadline: Date;
      banks: string[];
      currency: string;
      payerIdLabel?: string | null | undefined;
      certificateTitle?: string | undefined;
      amountDue?: string | undefined;
      dateToleranceDays?: number | undefined;
      password?: string | undefined;
      notify?: boolean | undefined;
      retentionDays?: number | null | undefined;
    },
  ) {
    const banks = [...new Set(input.banks.map((b) => text(b, 100, 'bank name')).filter((b): b is string => !!b))];
    if (!banks.length || banks.length > 20) throw invalid('list 1–20 banks payers can pay into');
    // Students paying fees unless the desk says otherwise (null: payers give only a name).
    const payerIdLabel = input.payerIdLabel === null ? null : (text(input.payerIdLabel ?? 'Student ID', 40, 'ID label') ?? null);
    const certificateTitle = text(input.certificateTitle ?? 'Fee clearance certificate', 80, 'certificate title');
    if (!certificateTitle) throw invalid('certificate title is required');
    if (banks.some((b) => b.includes('|'))) throw invalid('bank names cannot contain "|"');
    if (!(FEE_CURRENCIES as readonly string[]).includes(input.currency)) throw invalid('unknown currency');
    const amountDue = input.amountDue ? parseAmount(input.amountDue) : null;
    if (amountDue !== null && (amountDue === undefined || amountDue <= 0)) throw invalid('the amount due must be a positive amount');
    const tolerance = input.dateToleranceDays ?? 3;
    if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 31) throw invalid('the date tolerance must be 0–31 days');
    await this.#d.authorize(p, orgId, 'share:create');
    const limits = await this.limits(orgId);
    if (!limits.verifiedDocuments) throw new DomainError('forbidden', 'receipt processing needs verified documents in this plan');
    const org = await this.#d.organization?.(orgId);
    if (!org) throw notFound();
    if (org.kind !== 'team') throw new DomainError('forbidden', 'receipt processing runs from a team workspace');
    const fileBytes = Math.min(limits.maxFileBytes, 15 * 1024 * 1024);
    let desk: FeeDeskRow | undefined;
    const request = await this.#createUploadRequest(
      p,
      orgId,
      {
        title: input.title,
        instructions:
          input.instructions ??
          `Enter ${payerIdLabel ? `your ${payerIdLabel} and ` : ''}the details printed on your bank receipt, then upload a clear photo or scan of the receipt. Every payment is checked against the bank statement before your ${certificateTitle.toLowerCase()} is issued.`,
        requirements: [{ key: 'receipt', label: 'Photo or scan of your bank receipt', accept: FEE_RECEIPT_TYPES, required: true, maxFiles: 2 }],
        deadline: input.deadline,
        maxFileBytes: fileBytes,
        maxTotalBytes: fileBytes * 2,
        password: input.password,
        notify: input.notify,
        retentionDays: input.retentionDays,
      },
      async (tx, r, { now }) => {
        desk = {
          id: newId('fdsk'),
          orgId,
          requestId: r.id,
          title: r.title,
          institution: org.name,
          payerIdLabel,
          certificateTitle,
          banks,
          currency: input.currency as FeeDeskRow['currency'],
          amountDue,
          dateToleranceDays: tolerance,
          createdBy: p.userId,
          createdAt: now,
        };
        await tx.insert('feeDesk', desk);
        await this.#audit(
          tx,
          { type: 'user', id: p.userId },
          orgId,
          'fee.desk.created',
          { type: 'fee_desk', id: desk.id },
          { request_id: r.id, banks: banks.length },
        );
      },
    );
    const r = (await this.#d.store.get('uploadRequest', orgId, request.id))!;
    return this.#feeDeskView(desk!, r, this.#now(), []);
  }

  async listFeeDesks(p: UserPrincipal, orgId: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    const now = this.#now();
    const out = [];
    for (const d of await this.#d.store.list('feeDesk', orgId, {}, { limit: 200 })) {
      const r = await this.#d.store.get('uploadRequest', orgId, d.requestId);
      if (r) out.push(this.#feeDeskView(d, r, now));
    }
    return out;
  }

  #feeClaimView(c: FeeClaimRow, cert?: VerifiedDocumentRow) {
    return {
      id: c.id,
      submissionId: c.submissionId,
      payerId: c.payerId,
      payerName: c.payerName,
      bank: c.bank,
      reference: c.reference,
      amount: c.amount,
      paidOn: c.paidOn,
      status: c.status,
      matchMethod: c.matchMethod,
      matchNote: c.matchNote,
      statementLine: c.statementLine,
      matchIssue: c.matchIssue,
      matchedAt: c.matchedAt,
      rejectionReason: c.rejectionReason,
      rejectionMessage: c.rejectionMessage,
      rejectedAt: c.rejectedAt,
      certificate: c.certificate
        ? { code: c.certificate.code, url: c.certificate.url, status: cert?.status ?? 'active', revocationReason: cert?.revocationReason ?? null }
        : null,
      clearedAt: c.clearedAt,
      submittedAt: c.submittedAt,
    };
  }

  /** The desk with its claims and receipt files: for the desk's creator and the workspace's owners and admins only. */
  async getFeeDesk(p: UserPrincipal, orgId: string, id: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    const { d, r } = await this.#feeDesk(orgId, id);
    const s = this.#d.store;
    const all = (await s.list('feeClaim', orgId, { deskId: id }, { limit: 10_000 })).filter((c) => c.status !== 'draft');
    const view = this.#feeDeskView(d, r, this.#now(), all);
    if (!(await this.#isManager(p, orgId, d.createdBy))) return { ...view, claimsVisible: false, claims: [] };
    const files = await s.list('submissionFile', orgId, { requestId: r.id, status: 'current' }, { limit: 10_000, order: 'oldest' });
    const certs = new Map<string, VerifiedDocumentRow>();
    for (const c of all)
      if (c.verifiedDocumentId) {
        const v = await s.get('verifiedDocument', orgId, c.verifiedDocumentId);
        if (v) certs.set(v.id, v);
      }
    const claims = [];
    for (const c of all) {
      const receipts = [];
      for (const f of files.filter((x) => x.submissionId === c.submissionId)) {
        const b = await s.get('blob', orgId, f.blobId);
        receipts.push({ id: f.id, name: f.name, size: f.size, status: fileStatus(b?.status ?? 'deleted') });
      }
      claims.push({ ...this.#feeClaimView(c, c.verifiedDocumentId ? certs.get(c.verifiedDocumentId) : undefined), receipts });
    }
    return { ...view, claimsVisible: true, claims };
  }

  async #requireDeskManager(p: UserPrincipal, orgId: string, d: FeeDeskRow) {
    await this.#requireManager(p, orgId, d.createdBy);
  }

  /**
   * Matches the desk's submitted claims for `bank` against credit lines of that bank's statement, read on the finance
   * officer's device. Only matching lines are kept (on their claims); the rest of the statement is not stored.
   */
  async importFeeStatement(
    p: UserPrincipal,
    orgId: string,
    deskId: string,
    input: { bank: string; fileName: string; fileSha256: string; lines: StatementLine[] },
  ) {
    if (!Array.isArray(input.lines) || input.lines.length > STATEMENT_BATCH) throw invalid(`send at most ${STATEMENT_BATCH} statement lines at a time`);
    const fileName = title(input.fileName, 'file name');
    const fileSha256 = String(input.fileSha256 ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(fileSha256)) throw invalid('fileSha256 must be 64 hexadecimal characters');
    const lines = input.lines.map((l, i) => {
      if (!isIsoDate(String(l.date)) || !Number.isSafeInteger(l.amount) || l.amount <= 0 || l.amount > 1e13)
        throw invalid(`statement line ${i + 1} is invalid`);
      return {
        date: l.date,
        amount: l.amount,
        reference: text(l.reference, 120, 'reference') ?? '',
        description: text(l.description, 140, 'description') ?? '',
      };
    });
    return this.#mutate(p, orgId, 'share:create', async (tx, { now }) => {
      const { d } = await this.#feeDesk(orgId, deskId, tx);
      await this.#requireDeskManager(p, orgId, d);
      if (!d.banks.includes(input.bank)) throw invalid('choose one of the desk’s banks');
      const claims = await tx.list('feeClaim', orgId, { deskId }, { limit: 10_000 });
      const open = claims.filter((c) => c.status === 'submitted' && c.bank === input.bank);
      const keys = lines.map((l) =>
        createHash('sha256')
          .update(`${input.bank}\n${l.date}\n${l.amount}\n${referenceKey(l.reference)}\n${referenceKey(l.description)}`)
          .digest('hex'),
      );
      // A statement line confirms one payment in the whole workspace, not just this desk: the same statement may be
      // imported into several desks. Only lines that could match (an open claim's amount) are looked up.
      const amounts = new Set(open.map((c) => c.amount));
      const used = new Set<number>();
      for (const [i, k] of keys.entries())
        if (amounts.has(lines[i]!.amount) && (await tx.list('feeClaim', orgId, { statementLineKey: k }, { limit: 1 })).length) used.add(i);
      const result = matchStatement(open, lines, d.dateToleranceDays, d.currency, used);
      const byId = new Map(open.map((c) => [c.id, c]));
      for (const m of result.matches) {
        const l = lines[m.line]!;
        await tx.update('feeClaim', orgId, m.claimId, {
          status: 'matched',
          matchMethod: 'statement',
          statementLine: { ...l, fileName, fileSha256, payerIdFound: m.payerIdFound },
          statementLineKey: keys[m.line]!,
          matchIssue: null,
          matchedAt: now,
          matchedBy: p.userId,
          updatedAt: now,
        });
      }
      for (const x of result.issues)
        if (byId.get(x.claimId)?.matchIssue !== x.issue) await tx.update('feeClaim', orgId, x.claimId, { matchIssue: x.issue, updatedAt: now });
      await this.#audit(
        tx,
        { type: 'user', id: p.userId },
        orgId,
        'fee.statement.imported',
        { type: 'fee_desk', id: deskId },
        { bank: input.bank, file_sha256: fileSha256, lines: lines.length, matched: result.matches.length, issues: result.issues.length },
      );
      return {
        lines: lines.length,
        matched: result.matches.map((m) => ({ claimId: m.claimId, payerIdFound: m.payerIdFound })),
        issues: result.issues,
        stillOpen: open.length - result.matches.length,
      };
    });
  }

  async #claimForDecision(p: UserPrincipal, orgId: string, tx: SharingTx, id: string) {
    const c = await tx.getForUpdate('feeClaim', orgId, id);
    if (!c || c.status === 'draft') throw notFound();
    const { d } = await this.#feeDesk(orgId, c.deskId, tx);
    await this.#requireDeskManager(p, orgId, d);
    return { c, d };
  }

  /** Confirms a payment checked another way (for example in the bank's portal). The note is kept for audit. */
  async approveFeeClaim(p: UserPrincipal, orgId: string, id: string, input: { note: string }) {
    const note = text(input.note, 500, 'note');
    if (!note || note.length < 3) throw invalid('say how you confirmed this payment');
    return this.#mutate(p, orgId, 'share:create', async (tx, { now }) => {
      const { c } = await this.#claimForDecision(p, orgId, tx, id);
      if (c.status !== 'submitted') throw new DomainError('conflict', `this claim is already ${c.status}`);
      const patch: Partial<FeeClaimRow> = { status: 'matched', matchMethod: 'manual', matchNote: note, matchedAt: now, matchedBy: p.userId, updatedAt: now };
      await tx.update('feeClaim', orgId, id, patch);
      await this.#audit(tx, { type: 'user', id: p.userId }, orgId, 'fee.claim.approved', { type: 'fee_claim', id }, undefined, note);
      return this.#feeClaimView({ ...c, ...patch });
    });
  }

  /** Final. Frees the bank reference (and any statement line) for the real payer's claim. */
  async rejectFeeClaim(p: UserPrincipal, orgId: string, id: string, input: { reason: (typeof FEE_REJECTION_REASONS)[number]; message?: string | undefined }) {
    if (!FEE_REJECTION_REASONS.includes(input.reason)) throw invalid('unknown rejection reason');
    const message = text(input.message, 500, 'message');
    return this.#mutate(p, orgId, 'share:create', async (tx, { now }) => {
      const { c } = await this.#claimForDecision(p, orgId, tx, id);
      if (c.status !== 'submitted' && c.status !== 'matched') throw new DomainError('conflict', `this claim is already ${c.status}`);
      const patch: Partial<FeeClaimRow> = {
        status: 'rejected',
        activeKey: null,
        statementLineKey: null,
        rejectionReason: input.reason,
        rejectionMessage: message,
        rejectedAt: now,
        rejectedBy: p.userId,
        updatedAt: now,
      };
      await tx.update('feeClaim', orgId, id, patch);
      await this.#audit(tx, { type: 'user', id: p.userId }, orgId, 'fee.claim.rejected', { type: 'fee_claim', id }, { reason: input.reason });
      return this.#feeClaimView({ ...c, ...patch });
    });
  }

  /**
   * Issues a verified clearance certificate for each matched claim: the PDF is built here from the recorded facts and
   * its SHA-256 registered as an active verified document (docs/verified-documents.md).
   */
  async issueFeeCertificates(p: UserPrincipal, orgId: string, deskId: string, input: { claimIds: string[] }) {
    const ids = [...new Set(input.claimIds)];
    if (!ids.length || ids.length > FEE_CERTIFICATE_BATCH) throw invalid(`issue 1–${FEE_CERTIFICATE_BATCH} certificates at a time`);
    return this.#mutate(p, orgId, 'share:create', async (tx, { now, limits }) => {
      if (!limits.verifiedDocuments) throw new DomainError('forbidden', 'verified documents are not included in this plan');
      const { d } = await this.#feeDesk(orgId, deskId, tx);
      await this.#requireDeskManager(p, orgId, d);
      const issued = [];
      const skipped = [];
      for (const id of ids) {
        const c = await tx.getForUpdate('feeClaim', orgId, id);
        if (!c || c.deskId !== deskId) throw notFound();
        if (c.status !== 'matched') {
          skipped.push({ claimId: id, reason: `the claim is ${c.status}, not matched` });
          continue;
        }
        if (d.amountDue !== null && c.amount < d.amountDue) {
          skipped.push({ claimId: id, reason: `${formatAmount(c.amount, d.currency)} is less than the ${formatAmount(d.amountDue, d.currency)} due` });
          continue;
        }
        const code = verificationCode();
        const facts: FeeCertificateFacts = {
          institution: d.institution,
          certificateTitle: d.certificateTitle,
          title: d.title,
          payerName: c.payerName,
          payerIdLabel: c.payerId ? d.payerIdLabel : null,
          payerId: c.payerId,
          amount: formatAmount(c.amount, d.currency),
          paidOn: c.paidOn,
          bank: c.bank,
          reference: c.reference,
          confirmedBy: c.matchMethod === 'statement' ? 'statement' : 'manual',
          clearedOn: now.toISOString().slice(0, 10),
          code,
          url: `${this.#c.publicOrigin}/v/${code}`,
        };
        const sha256 = createHash('sha256')
          .update(await buildFeeCertificate(facts))
          .digest('hex');
        const doc: VerifiedDocumentRow = {
          id: newId('vdoc'),
          orgId,
          code,
          title: `${d.certificateTitle} — ${d.title}`.slice(0, 200),
          details: [
            { label: 'Name', value: c.payerName },
            ...(facts.payerIdLabel && c.payerId ? [{ label: facts.payerIdLabel, value: c.payerId }] : []),
            { label: 'Amount paid', value: facts.amount },
            { label: 'Payment date', value: c.paidOn },
            { label: 'Payment confirmed', value: facts.confirmedBy === 'statement' ? 'Against the bank statement' : 'By the finance office' },
          ],
          issuerName: d.institution,
          sha256,
          status: 'active',
          createdBy: p.userId,
          createdAt: now,
          issuedAt: now,
          revokedAt: null,
          revokedBy: null,
          revocationReason: null,
        };
        await tx.insert('verifiedDocument', doc);
        await tx.update('feeClaim', orgId, id, {
          status: 'cleared',
          verifiedDocumentId: doc.id,
          certificate: facts,
          clearedAt: now,
          clearedBy: p.userId,
          updatedAt: now,
        });
        await this.#audit(tx, { type: 'user', id: p.userId }, orgId, 'share.verification.issued', { type: 'verified_document', id: doc.id }, { sha256 });
        await this.#audit(tx, { type: 'user', id: p.userId }, orgId, 'fee.claim.cleared', { type: 'fee_claim', id }, { verified_document_id: doc.id });
        issued.push({ claimId: id, code, url: facts.url });
      }
      return { issued, skipped };
    });
  }

  /** Rebuilds a certificate and checks it is byte for byte the one registered. */
  async #certificatePdf(c: FeeClaimRow) {
    if (c.status !== 'cleared' || !c.certificate || !c.verifiedDocumentId) throw notFound();
    const v = await this.#d.store.get('verifiedDocument', c.orgId, c.verifiedDocumentId);
    const bytes = await buildFeeCertificate(c.certificate);
    if (!v || createHash('sha256').update(bytes).digest('hex') !== v.sha256)
      throw new DomainError('conflict', 'this certificate can no longer be reproduced exactly; contact Rokela PDF support');
    return { bytes, name: certificateFileName(c.certificate.certificateTitle, c.payerId ?? c.payerName), revoked: v.status === 'revoked' };
  }

  async feeCertificate(p: UserPrincipal, orgId: string, id: string) {
    await this.#d.authorize(p, orgId, 'share:read');
    const c = await this.#d.store.get('feeClaim', orgId, id);
    if (!c) throw notFound();
    const { d } = await this.#feeDesk(orgId, c.deskId);
    await this.#requireDeskManager(p, orgId, d);
    return this.#certificatePdf(c);
  }

  async #claimBySecret(secret: string) {
    if (!/^fcs_[A-Za-z0-9_-]{43}$/.test(secret)) throw notFound();
    const c = await this.#d.store.findUnique('feeClaim', 'statusSecretHash', tokenHash(secret));
    if (!c) throw notFound();
    return c;
  }

  /** The payer's own claim, through the private link they received on submission. */
  async feeClaimStatus(secret: string) {
    const c = await this.#claimBySecret(secret);
    const d = (await this.#d.store.get('feeDesk', c.orgId, c.deskId))!;
    const v = c.verifiedDocumentId ? await this.#d.store.get('verifiedDocument', c.orgId, c.verifiedDocumentId) : undefined;
    return {
      institution: d.institution,
      title: d.title,
      certificateTitle: d.certificateTitle,
      payerName: c.payerName,
      payerIdLabel: d.payerIdLabel,
      payerId: c.payerId,
      bank: c.bank,
      reference: c.reference,
      amount: formatAmount(c.amount, d.currency),
      paidOn: c.paidOn,
      status: c.status,
      submittedAt: c.submittedAt,
      rejection: c.rejectionReason ? { reason: c.rejectionReason, text: FEE_REASON_TEXT[c.rejectionReason], message: c.rejectionMessage } : null,
      certificate: c.certificate ? { code: c.certificate.code, url: c.certificate.url, status: v?.status ?? 'active', clearedAt: c.clearedAt } : null,
    };
  }

  async feeClaimCertificate(secret: string) {
    return this.#certificatePdf(await this.#claimBySecret(secret));
  }

  // =============================================================================================
  // Abuse reporting and operator review
  // =============================================================================================

  async reportAbuse(input: { reference: string; category: AbuseRow['category']; details?: string | undefined; email?: string | undefined }) {
    const reference = text(input.reference, 2048, 'reference');
    if (!reference) throw invalid('reference is required');
    const details = text(input.details, 4000, 'details');
    const email = input.email ? normalizeEmail(input.email) : null;
    const subject = await this.#resolveReference(reference);
    const row: AbuseRow = {
      id: newId('abr'),
      orgId: subject?.orgId ?? '',
      subjectType: subject?.type ?? 'unknown',
      subjectId: subject?.id ?? null,
      reference,
      category: input.category,
      details,
      reporterEmail: email,
      status: 'open',
      createdAt: this.#now(),
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
    };
    await this.#d.store.transaction((tx) => tx.insert('abuse', row));
    // Same response whether or not the reference resolved: reports are not an existence oracle.
    return { id: row.id, received: true };
  }

  async #resolveReference(ref: string): Promise<{ orgId: string; type: 'short' | 'share' | 'request'; id: string } | undefined> {
    let host: string | undefined;
    let path = ref;
    try {
      const u = new URL(ref);
      host = u.host;
      path = u.pathname;
    } catch {
      /* a bare code or path */
    }
    const m = /^\/?([lsrd])\/([A-Za-z0-9_-]{3,64})\/?$/.exec(path) ?? /^\/?()([A-Za-z0-9-]{3,64})\/?$/.exec(path);
    if (!m) return undefined;
    const [, kind, code] = m as unknown as [string, string, string];
    try {
      if (kind === 'l' || kind === '') {
        const s = await this.#shortRow(host, code);
        return { orgId: s.orgId, type: 'short', id: s.id };
      }
      if (kind === 'd') {
        const s = await this.#d.store.findUnique('shortLink', 'lookupKey', `c|${tokenHash(code)}`);
        return s ? { orgId: s.orgId, type: 'short', id: s.id } : undefined;
      }
      if (kind === 's') {
        const l = await this.#linkByToken(code);
        return { orgId: l.orgId, type: 'share', id: l.id };
      }
      const r = await this.#requestByToken(code);
      return { orgId: r.orgId, type: 'request', id: r.id };
    } catch {
      return undefined;
    }
  }

  async listAbuseReports(status?: AbuseRow['status']) {
    return (await this.#d.store.listAbuse(status, 200)).map((r) => ({ ...r }));
  }

  /** Operator decision on a report. Suspension places an operator hold the owner cannot lift. */
  async resolveAbuseReport(operatorId: string, id: string, input: { action: 'suspend' | 'dismiss'; reason: string }) {
    const reason = text(input.reason, 500, 'reason');
    if (!reason || reason.length < 3) throw invalid('a reason is required');
    return this.#d.store.transaction(async (tx) => {
      const now = this.#now();
      const r = await tx.getAbuseForUpdate(id);
      if (!r) throw notFound();
      if (r.status !== 'open') throw new DomainError('conflict', 'report already resolved');
      if (input.action === 'suspend') {
        if (!r.subjectId || r.subjectType === 'unknown') throw new DomainError('conflict', 'the report does not name a resolvable link');
        await this.#hold(tx, r.orgId, r.subjectType, r.subjectId, true, reason, operatorId);
      }
      await tx.update('abuse', r.orgId, id, {
        status: input.action === 'suspend' ? 'actioned' : 'dismissed',
        resolvedAt: now,
        resolvedBy: operatorId,
        resolution: reason,
      });
      await tx.audit.append({
        actor: { type: 'operator', id: operatorId },
        action: `abuse.report_${input.action === 'suspend' ? 'actioned' : 'dismissed'}`,
        target: { type: 'abuse_report', id },
        ...(r.orgId ? { orgId: r.orgId } : {}),
        reason,
        metadata: { subject_type: r.subjectType, subject_id: r.subjectId, category: r.category },
      });
      return { id, status: input.action === 'suspend' ? 'actioned' : 'dismissed' };
    });
  }

  async setOperatorHold(operatorId: string, orgId: string, type: 'short' | 'share' | 'request', id: string, hold: boolean, reason: string) {
    const r = text(reason, 500, 'reason');
    if (!r || r.length < 3) throw invalid('a reason is required');
    return this.#d.store.transaction((tx) => this.#hold(tx, orgId, type, id, hold, r, operatorId));
  }

  async #hold(tx: SharingTx, orgId: string, type: 'short' | 'share' | 'request', id: string, hold: boolean, reason: string, operatorId: string) {
    const now = this.#now();
    const kind = type === 'short' ? 'shortLink' : type === 'share' ? 'link' : 'uploadRequest';
    const row = await tx.getForUpdate(kind, orgId, id);
    if (!row) throw notFound();
    if (kind === 'uploadRequest') await tx.update('uploadRequest', orgId, id, { operatorHold: hold, updatedAt: now });
    else
      await tx.update(kind as 'link', orgId, id, {
        operatorHold: hold,
        status: hold ? ((row as LinkRow).status === 'revoked' ? 'revoked' : 'suspended') : (row as LinkRow).status === 'revoked' ? 'revoked' : 'active',
        statusReason: hold ? `operator: ${reason}` : null,
        updatedAt: now,
      });
    await tx.audit.append({
      actor: { type: 'operator', id: operatorId },
      action: hold ? 'share.operator_hold.placed' : 'share.operator_hold.lifted',
      target: { type, id },
      orgId,
      reason,
    });
    return { id, type, operatorHold: hold };
  }

  // =============================================================================================
  // Background jobs: quarantine checks, deletion, notification mail; retention
  // =============================================================================================

  async #enqueue(tx: SharingTx, orgId: string, kind: JobRow['kind'], subjectId: string, now: Date, payload: Record<string, string> = {}) {
    await tx.insert('job', {
      id: newId('job'),
      orgId,
      kind,
      subjectId,
      payload,
      runAfter: now,
      attempts: 0,
      claim: null,
      lockedUntil: null,
      lastError: null,
      createdAt: now,
    });
  }

  /** Claims and runs due jobs. Safe with several workers (fenced claims) and after crashes (leases expire). */
  async processJobs(opts: { limit?: number } = {}): Promise<{ done: number; failed: number }> {
    const claim = newId('clm');
    const now = this.#now();
    const jobs = await this.#d.store.transaction((tx) =>
      tx.claimJobs(now, opts.limit ?? 20, claim, new Date(now.getTime() + this.#c.jobLeaseSeconds * 1000), this.#d.mailer ? [] : EMAIL_JOBS),
    );
    let done = 0;
    let failed = 0;
    for (const job of jobs) {
      // The batch runs one job at a time, so a lease taken at claim time can run out before the last jobs start, and
      // another worker on this database (the Cloudflare backup) would then run them again: duplicate emails and scans.
      // Renew it as each job starts, and skip a job whose lease another worker has already taken.
      if (!(await this.#renewLease(job, claim))) continue;
      try {
        await this.#runJob(job, claim);
        done++;
      } catch (e) {
        failed++;
        await this.#failJob(job, claim, e).catch(() => undefined);
      }
    }
    return { done, failed };
  }

  #renewLease(job: JobRow, claim: string): Promise<boolean> {
    return this.#d.store.transaction(async (tx) => {
      const j = await tx.getForUpdate('job', job.orgId, job.id);
      if (!j || j.claim !== claim) return false;
      await tx.update('job', job.orgId, job.id, { lockedUntil: this.#at(this.#c.jobLeaseSeconds * 1000) });
      return true;
    });
  }

  async #finish(tx: SharingTx, job: JobRow, claim: string): Promise<boolean> {
    const j = await tx.getForUpdate('job', job.orgId, job.id);
    if (!j || j.claim !== claim) return false; // lease lost to another worker
    await tx.remove('job', job.orgId, job.id);
    return true;
  }

  async #runJob(job: JobRow, claim: string) {
    const s = this.#d.store;
    if (job.kind === 'scan') {
      const blob = await s.get('blob', job.orgId, job.subjectId);
      if (!blob || blob.status !== 'quarantined') {
        await s.transaction((tx) => this.#finish(tx, job, claim));
        return;
      }
      const verdict = await this.#d.scanner.scan({
        ext: blob.ext,
        open: () => this.#d.objects.read(blob.objectKey),
      });
      await s.transaction(async (tx) => {
        if (!(await this.#finish(tx, job, claim))) return;
        const now = this.#now();
        const b = await tx.getForUpdate('blob', job.orgId, blob.id);
        if (!b || b.status !== 'quarantined') return;
        const clean = verdict.verdict === 'clean' && verdict.size === b.size;
        await tx.update('blob', b.orgId, b.id, {
          status: clean ? 'clean' : 'rejected',
          rejectReason: clean ? null : (verdict.reason ?? 'size_mismatch'),
          sha256: verdict.sha256,
          scannedAt: now,
        });
        await tx.addUsage(b.orgId, monthKey(now), 'processing_bytes', b.size ?? 0);
        if (clean) await this.#attach(tx, { ...b, status: 'clean' }, now);
        else {
          await this.#enqueue(tx, b.orgId, 'delete_blob', b.id, now);
          await tx.audit.append({
            actor: { type: 'system' },
            action: 'share.file.rejected',
            target: { type: 'share_blob', id: b.id },
            orgId: b.orgId,
            metadata: { reason: verdict.reason, scanner: this.#d.scanner.name },
          });
          const owner = await this.#ownerOf(tx, b);
          if (owner)
            await this.#notify(
              tx,
              b.orgId,
              owner,
              'file.rejected',
              { type: b.targetType, id: b.targetId },
              `An uploaded file did not pass checks (${verdict.reason ?? 'size_mismatch'}) and was removed.`,
              false,
            );
        }
      });
      return;
    }
    if (job.kind === 'delete_blob') {
      const plan = await s.transaction(async (tx) => {
        const j = await tx.getForUpdate('job', job.orgId, job.id);
        if (!j || j.claim !== claim) return undefined;
        const b = await tx.getForUpdate('blob', job.orgId, job.subjectId);
        if (!b || b.status === 'deleted') {
          await tx.remove('job', job.orgId, job.id);
          return undefined;
        }
        // Never delete an object still referenced by another active document, version or transfer
        // (rejected content is always removed).
        if (b.status !== 'rejected' && b.status !== 'deleting' && (await tx.blobReferenced(b.orgId, b.id))) {
          await tx.remove('job', job.orgId, job.id);
          return undefined;
        }
        if (b.status !== 'rejected') await tx.update('blob', b.orgId, b.id, { status: 'deleting' });
        return b;
      });
      if (!plan) return;
      if (plan.multipartId && !plan.completedAt) await this.#d.objects.abortMultipart(plan.objectKey, plan.multipartId);
      await this.#d.objects.delete(plan.objectKey);
      await s.transaction(async (tx) => {
        if (!(await this.#finish(tx, job, claim))) return;
        await tx.update('blob', plan.orgId, plan.id, { status: 'deleted', deletedAt: this.#now() });
      });
      return;
    }
    if (job.kind === 'member_invite') {
      const inv = await this.#d.invitation?.(job.subjectId);
      if (this.#d.mailer && inv) {
        const oneLine = (v: string, max: number) =>
          v
            .replace(/[\r\n\t]+/g, ' ')
            .slice(0, max)
            .trim();
        const from = oneLine(inv.invitedBy, 254);
        const workspace = oneLine(inv.workspaceName, 120);
        const url = `${this.#c.publicOrigin}/signin?next=${encodeURIComponent('/app')}`;
        await this.#d.mailer.send({
          id: job.id,
          to: inv.email,
          replyTo: from,
          subject: oneLine(`${from} invited you to ${workspace} on Rokela PDF`, 150),
          text: `${from} invited you to join the team workspace "${workspace}" on Rokela PDF as ${inv.role}.\n\nSign in with this email address (or create a free account with it) to accept or decline: ${url}\nThe invitation expires ${inv.expiresAt.toUTCString()}.\n\nYou are not added to anything unless you accept. If unexpected, ignore this email or report it: ${this.#c.publicOrigin}/report`,
          html: inviteEmailHtml({ from, workspace, role: inv.role, url, origin: this.#c.publicOrigin, expiresAt: inv.expiresAt }),
        });
      }
      await s.transaction((tx) => this.#finish(tx, job, claim));
      return;
    }
    if (job.kind === 'share_email') {
      if (job.payload['mode'] === 'request_invitation') await this.#sendRequestInvitation(job);
      else await this.#sendShareEmail(job);
      await s.transaction((tx) => this.#finish(tx, job, claim));
      return;
    }
    // notify_email
    const who = job.payload['userId'] ? await this.#d.identity(job.payload['userId']) : undefined;
    if (this.#d.mailer && who)
      await this.#d.mailer.send({
        id: job.id,
        to: who.email,
        subject: job.payload['digest'] === 'downloads' ? 'Your shared files were downloaded' : (job.payload['subject'] ?? 'Notification'),
        text:
          job.payload['digest'] === 'downloads'
            ? `${job.payload['count'] ?? '1'} download events occurred for your shared files in the last day. Open your workspace to see recipient activity. You receive this because download notifications are enabled.`
            : (job.payload['text'] ?? ''),
      });
    await s.transaction((tx) => this.#finish(tx, job, claim));
  }

  /** Sends one emailed link. Skipped (not retried) when the link is no longer usable by the time the job runs. */
  async #sendRequestInvitation(job: JobRow) {
    const request = await this.#d.store.get('uploadRequest', job.orgId, job.subjectId);
    if (!this.#d.mailer || !request || request.status !== 'open' || request.operatorHold || request.deadline <= this.#now()) return;
    const from = (job.payload['from'] ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 254);
    const title = request.title.replace(/[\r\n\t]+/g, ' ').slice(0, 120);
    const url = this.#requestUrl(request);
    const message = job.payload['message'] ?? '';
    await this.#d.mailer.send({
      id: job.id,
      to: job.payload['to'] ?? '',
      replyTo: from,
      subject: `${from} requested files: ${title}`.slice(0, 150),
      text: `${from} requested files for “${title}”.\n\n${message ? `${message}\n\n` : ''}Upload your files: ${url}\nDeadline: ${request.deadline.toUTCString()}.\n${request.passwordHash ? 'Ask the requester for the password.\n' : ''}\nNo Rokela account is required. Other submitters cannot see your files.\nIf unexpected, ignore this email or report it: ${this.#c.publicOrigin}/report`,
      html: shareEmailHtml({
        from,
        title,
        message,
        url,
        origin: this.#c.publicOrigin,
        expiresAt: request.deadline,
        password: !!request.passwordHash,
        reminder: false,
        purpose: 'request',
      }),
    });
  }

  async #sendShareEmail(job: JobRow) {
    const s = this.#d.store;
    const now = this.#now();
    const l = await s.get('link', job.orgId, job.subjectId);
    if (!this.#d.mailer || !l || effectiveLinkState(l, now, true) !== 'active') return;
    const subjectRow = l.targetType === 'transfer' ? await s.get('transfer', l.orgId, l.targetId) : await s.get('document', l.orgId, l.targetId);
    if (!subjectRow || subjectRow.status !== 'active') return;
    const reminder = job.payload['mode'] === 'expiry_reminder';
    if (reminder && (l.downloadCount > 0 || (subjectRow && 'expiresAt' in subjectRow && subjectRow.expiresAt && subjectRow.expiresAt <= now))) return;
    const oneLine = (v: string, max: number) =>
      v
        .replace(/[\r\n\t]+/g, ' ')
        .slice(0, max)
        .trim();
    const from = oneLine(job.payload['from'] ?? '', 254);
    const what = oneLine(subjectRow.title, 120) || 'files';
    const message = job.payload['message'] ?? '';
    const lines = [
      reminder ? `Reminder: "${what}" is approaching its expiry. Download it before access ends.` : `${from} sent you "${what}" with Rokela PDF.`,
      ...(message ? ['', message] : []),
      '',
      `Open and download: ${this.#shareUrl(l)}`,
      ...(l.expiresAt ? [`Available until ${l.expiresAt.toUTCString()}.`] : []),
      ...(l.passwordHash ? ['The sender protected this link with a password. Ask them for it.'] : []),
      '',
      `You received this because ${from} entered your address. If you did not expect it, ignore this email or report it: ${this.#c.publicOrigin}/report`,
    ];
    await this.#d.mailer.send({
      id: job.id,
      to: job.payload['to'] ?? '',
      subject: oneLine(reminder ? `Reminder: ${what} expires soon` : `${from} sent you ${what}`, 150),
      text: lines.join('\n'),
      html: shareEmailHtml({
        from,
        title: what,
        message,
        url: this.#shareUrl(l),
        origin: this.#c.publicOrigin,
        expiresAt: l.expiresAt,
        password: !!l.passwordHash,
        reminder,
      }),
      replyTo: from || undefined,
    });
  }

  async #ownerOf(r: SharingRepo, b: BlobRow): Promise<string | null> {
    if (b.createdBy) return b.createdBy;
    if (b.targetType === 'submission_file') {
      const f = await r.get('submissionFile', b.orgId, b.targetId);
      const req = f && (await r.get('uploadRequest', b.orgId, f.requestId));
      return req?.createdBy ?? null;
    }
    return null;
  }

  /** After a clean verdict: swap replacements and drafts in; earlier objects become deletion candidates. */
  async #attach(tx: SharingTx, b: BlobRow, now: Date) {
    if (b.targetType === 'draft') {
      const doc = await tx.getForUpdate('document', b.orgId, b.targetId);
      if (!doc || doc.status !== 'active') return void (await this.#enqueue(tx, b.orgId, 'delete_blob', b.id, now));
      if (doc.draftUpdatedAt && b.completedAt && doc.draftUpdatedAt > b.completedAt) {
        // A newer draft already landed; this older save is obsolete.
        return void (await this.#enqueue(tx, b.orgId, 'delete_blob', b.id, now));
      }
      await tx.update('document', b.orgId, doc.id, {
        draftBlobId: b.id,
        draftUpdatedAt: b.completedAt ?? now,
        updatedAt: now,
      });
      if (doc.draftBlobId) await this.#enqueue(tx, b.orgId, 'delete_blob', doc.draftBlobId, now);
      return;
    }
    if (b.targetType === 'transfer_replace') {
      const f = await tx.getForUpdate('transferFile', b.orgId, b.targetId);
      if (!f || f.status !== 'current') return void (await this.#enqueue(tx, b.orgId, 'delete_blob', b.id, now));
      await tx.update('transferFile', b.orgId, f.id, {
        blobId: b.id,
        ext: b.ext,
        size: b.size ?? f.size,
        revision: f.revision + 1,
        replacedAt: now,
        replacementNote: b.note,
        updatedAt: now,
      });
      await this.#enqueue(tx, b.orgId, 'delete_blob', f.blobId, now);
      await tx.audit.append({
        actor: {
          type: b.createdBy ? 'user' : 'system',
          ...(b.createdBy ? { id: b.createdBy } : {}),
        },
        action: 'share.transfer.file_replaced',
        target: { type: 'share_transfer', id: f.transferId },
        orgId: b.orgId,
        metadata: { file_id: f.id, revision: f.revision + 1 },
      });
      return;
    }
    if (b.targetType === 'transfer_file' && b.createdBy) {
      const f = await tx.get('transferFile', b.orgId, b.targetId);
      if (f)
        await this.#notify(
          tx,
          b.orgId,
          b.createdBy,
          'file.available',
          { type: 'share_transfer', id: f.transferId },
          `"${f.name}" finished processing and is available.`,
          false,
        );
    }
  }

  async #scanStillWaiting(tx: SharingTx, job: JobRow, now: Date): Promise<boolean> {
    const b = await tx.get('blob', job.orgId, job.subjectId);
    const since = b?.completedAt ?? b?.createdAt;
    return b?.status === 'quarantined' && !!since && now.getTime() - since.getTime() < this.#c.scanGiveUpHours * 3_600_000;
  }

  async #failJob(job: JobRow, claim: string, e: unknown) {
    const code = (e as { code?: unknown })?.code;
    const err = `${(e as Error)?.name ?? 'Error'}${typeof code === 'string' ? `:${code.slice(0, 40)}` : ''}`.slice(0, 100);
    await this.#d.store.transaction(async (tx) => {
      const j = await tx.getForUpdate('job', job.orgId, job.id);
      if (!j || j.claim !== claim) return;
      const now = this.#now();
      const attempts = j.attempts + 1;
      // An unreachable scanner must not cost people their uploads: checks are retried (at most hourly) until the file
      // has waited `scanGiveUpHours`, and only then does it fail closed.
      const waiting = job.kind === 'scan' && (await this.#scanStillWaiting(tx, job, now));
      if (attempts >= this.#c.scanMaxAttempts && !waiting) {
        await tx.remove('job', job.orgId, job.id);
        if (job.kind === 'scan') {
          // Fail closed: a file whose checks never completed never becomes available.
          const b = await tx.getForUpdate('blob', job.orgId, job.subjectId);
          if (b?.status === 'quarantined') {
            await tx.update('blob', b.orgId, b.id, {
              status: 'rejected',
              rejectReason: 'scan_failed',
              scannedAt: now,
            });
            await this.#enqueue(tx, b.orgId, 'delete_blob', b.id, now);
          }
        } else if (job.kind === 'delete_blob') {
          // Keep retrying deletion later rather than forgetting an object.
          await this.#enqueue(tx, job.orgId, 'delete_blob', job.subjectId, new Date(now.getTime() + 6 * 3_600_000));
        }
        return;
      }
      await tx.update('job', job.orgId, job.id, {
        attempts,
        claim: null,
        lockedUntil: null,
        lastError: err,
        runAfter: new Date(now.getTime() + Math.min(3_600_000, 30_000 * 2 ** attempts)),
      });
    });
  }

  /**
   * Retention pass (scheduled, retryable, batch-bounded). Disclosed policy: docs/security/sharing-retention.md.
   *  - temporary transfers: files deleted at expiry (also after revocation, at the original expiry)
   *  - deleted transfers and upload requests past `deleteAfter`: files deleted
   *  - unfinished uploads past their session: aborted and released
   *  - link events, aggregates, attempt counters and notifications: removed after their retention periods
   */
  async runRetention(opts: { batch?: number } = {}) {
    const batch = opts.batch ?? 200;
    const s = this.#d.store;
    const now = this.#now();
    const out = {
      transfersExpired: 0,
      transfersPurged: 0,
      requestsPurged: 0,
      uploadsAbandoned: 0,
      events: 0,
      stats: 0,
      attempts: 0,
      notifications: 0,
      staleEmails: 0,
      domainsChecked: 0,
      domainsLapsed: 0,
    };
    for (const t of await s.dueTransfers(now, batch)) {
      await s.transaction(async (tx) => {
        const cur = await tx.getForUpdate('transfer', t.orgId, t.id);
        if (!cur) return;
        if (cur.status === 'active' && cur.expiresAt && cur.expiresAt <= now) {
          cur.status = 'expired';
          await tx.update('transfer', t.orgId, t.id, { status: 'expired', updatedAt: now });
          out.transfersExpired++;
        }
        const purge =
          cur.status === 'deleted' ||
          (cur.kind === 'temporary' && (cur.status === 'expired' || cur.status === 'revoked') && !!cur.expiresAt && cur.expiresAt <= now);
        if (!purge) return;
        const files = await tx.list('transferFile', t.orgId, { transferId: t.id, status: 'current' }, { limit: 100_000 });
        for (const f of files) {
          await tx.update('transferFile', t.orgId, f.id, { status: 'removed', updatedAt: now });
          await this.#enqueue(tx, t.orgId, 'delete_blob', f.blobId, now);
        }
        for (const b of await tx.list('blob', t.orgId, { targetType: 'transfer_replace' }, { limit: 100_000 }))
          if (files.some((f) => f.id === b.targetId) && !['deleted', 'deleting'].includes(b.status)) await this.#enqueue(tx, t.orgId, 'delete_blob', b.id, now);
        await tx.update('transfer', t.orgId, t.id, { status: 'purged', updatedAt: now });
        await tx.audit.append({
          actor: { type: 'system' },
          action: 'share.transfer.purged',
          target: { type: 'share_transfer', id: t.id },
          orgId: t.orgId,
          metadata: { files: files.length, kind: cur.kind },
        });
        out.transfersPurged++;
      });
    }
    for (const r of await s.dueUploadRequests(now, batch)) {
      await s.transaction(async (tx) => {
        const cur = await tx.getForUpdate('uploadRequest', r.orgId, r.id);
        if (!cur || cur.status === 'purged' || !cur.deleteAfter || cur.deleteAfter > now) return;
        const files = await tx.list('submissionFile', r.orgId, { requestId: r.id, status: 'current' }, { limit: 100_000 });
        for (const f of files) {
          await tx.update('submissionFile', r.orgId, f.id, { status: 'removed' });
          await this.#enqueue(tx, r.orgId, 'delete_blob', f.blobId, now);
        }
        await tx.update('uploadRequest', r.orgId, r.id, { status: 'purged', updatedAt: now });
        await tx.audit.append({
          actor: { type: 'system' },
          action: 'share.request.purged',
          target: { type: 'upload_request', id: r.id },
          orgId: r.orgId,
          metadata: { files: files.length },
        });
        out.requestsPurged++;
      });
    }
    for (const b of await s.staleUploads(now, batch)) {
      await s.transaction(async (tx) => {
        const cur = await tx.getForUpdate('blob', b.orgId, b.id);
        if (!cur || cur.status !== 'uploading') return;
        await this.#detachUpload(tx, cur, now);
        out.uploadsAbandoned++;
      });
    }
    const day = 86_400_000;
    out.events = await s.purgeEvents(new Date(now.getTime() - this.#c.eventRetentionDays * day), 5000);
    out.stats = await s.purgeStats(dayKey(new Date(now.getTime() - this.#c.statRetentionDays * day)), 5000);
    out.attempts = await s.purgeAttempts(new Date(now.getTime() - day), 5000);
    out.notifications = await s.purgeNotifications(new Date(now.getTime() - this.#c.notificationRetentionDays * day), 5000);
    out.staleEmails = await s.purgeStaleJobs(EMAIL_JOBS, new Date(now.getTime() - STALE_EMAIL_MS), 5000);
    // DNS lookups, so a small batch per run; each domain is due once per recheck interval.
    const domains = await this.#recheckDomains(now, Math.min(batch, 20));
    out.domainsChecked = domains.checked;
    out.domainsLapsed = domains.lapsed;
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------
// Views (never expose salts, token hashes or password hashes)
// ---------------------------------------------------------------------------------------------------

export function fileStatus(s: BlobRow['status']): 'uploading' | 'processing' | 'available' | 'rejected' | 'deleted' {
  return s === 'uploading' ? 'uploading' : s === 'quarantined' ? 'processing' : s === 'clean' ? 'available' : s === 'rejected' ? 'rejected' : 'deleted';
}

function nextStatus(row: { status: 'active' | 'suspended' | 'revoked'; operatorHold: boolean }, action: 'revoke' | 'suspend' | 'resume') {
  if (row.status === 'revoked') throw new DomainError('conflict', 'a revoked link cannot be changed');
  if (action === 'revoke') return 'revoked' as const;
  if (action === 'suspend') return 'suspended' as const;
  if (row.operatorHold) throw new DomainError('forbidden', 'this link was suspended by the platform after an abuse review');
  return 'active' as const;
}

function folderName(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  // eslint-disable-next-line no-control-regex
  if (v.length > 100 || /[\u0000-\u001f]/.test(v)) throw new DomainError('invalid_request', 'invalid folder');
  return v;
}
function tagList(raw: string[] | undefined): string[] {
  const tags = [...new Set((raw ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (tags.length > 20 || tags.some((t) => !/^[a-z0-9][a-z0-9 _-]{0,39}$/.test(t))) throw new DomainError('invalid_request', 'invalid tags');
  return tags;
}

function totals(stats: ReadonlyArray<{ kind: string; bot: boolean; count: number }>) {
  const out: Record<string, { count: number; bots: number }> = {};
  for (const s of stats) {
    const t = (out[s.kind] ??= { count: 0, bots: 0 });
    if (s.bot) t.bots += s.count;
    else t.count += s.count;
  }
  return out;
}

const documentView = (d: DocumentRow) => ({
  id: d.id,
  title: d.title,
  createdBy: d.createdBy,
  requireApproval: d.requireApproval,
  hasDraft: !!d.draftBlobId,
  draftUpdatedAt: d.draftUpdatedAt,
  publishedVersionId: d.publishedVersionId,
  publishedAt: d.publishedAt,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});
const versionView = (v: VersionRow) => ({
  id: v.id,
  documentId: v.documentId,
  number: v.number,
  fileName: v.fileName,
  note: v.note,
  createdAt: v.createdAt,
  publishedAt: v.publishedAt,
  replacementNote: v.replacementNote,
});
function transferView(t: TransferRow, now?: Date) {
  return {
    id: t.id,
    title: t.title,
    message: t.message,
    kind: t.kind,
    status: t.status === 'active' && t.expiresAt && now && t.expiresAt <= now ? 'expired' : t.status,
    expiresAt: t.expiresAt,
    filesDeletedAt: t.kind === 'temporary' ? t.expiresAt : null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}
const uploadView = (b: BlobRow, fileId: string | null, name: string) => ({
  uploadId: b.id,
  fileId,
  name,
  size: b.declaredSize,
  partSize: b.partSize,
  partCount: b.partCount,
  expiresAt: b.uploadExpiresAt,
});
const eventView = (e: EventRow) => ({
  kind: e.kind,
  at: e.createdAt,
  identity: e.email ? { email: e.email, authenticated: true } : e.declaredName ? { name: e.declaredName, authenticated: false } : null,
  fileId: e.fileId,
  likelyAutomated: e.bot,
});

interface ResolvedTarget {
  usable: boolean;
  transfer: TransferRow | undefined;
  document: DocumentRow | undefined;
  version: VersionRow | undefined;
}

export type { EffectiveLinkState };
