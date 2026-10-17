'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Details, Empty, Form, Modal, Muted, Panel, Progress, Table, ask, confirmAction, useNotice } from '@/components/ui';
import { api, enc } from '@/lib/client/api';
import { when } from '@/lib/client/format';
import type { UploadProgress } from '@/lib/client/uploader';
import { ownerDownload, ownerUpload, useLoad, usePollWhile, useWs } from './context';

/* eslint-disable @typescript-eslint/no-explicit-any */
const DRAFT_SAVED = 'Draft saved privately. It is never visible through share links until you export and publish it.';

export function Documents() {
  const { nav } = useWs();
  return nav.id ? <DocumentDetail id={nav.id} /> : <DocumentList />;
}

function DocumentList() {
  const { P, go } = useWs();
  const { data, error } = useLoad<any>(() => api(`${P}/documents`), [P]);
  return (
    <>
      <Panel title="New document">
        <Form
          fields={[
            { name: 'title', label: 'Title' },
            {
              name: 'require_approval',
              label: 'Publication',
              type: 'select',
              options: [
                ['no', 'Publish without approval'],
                ['yes', 'Require an approval before publishing'],
              ],
            },
          ]}
          submit="Create document"
          onSubmit={async (v) => {
            const d = await api(`${P}/documents`, { body: { title: v.title, require_approval: v.require_approval === 'yes' } });
            go('documents', d.id);
          }}
        />
      </Panel>
      <Panel title="Documents">
        {error ? (
          <p>{error.message}</p>
        ) : !data ? (
          <Muted>Loading…</Muted>
        ) : data.items.length ? (
          <Table
            head={['Document', 'Draft', 'Published', '']}
            rows={data.items.map((d: any) => [
              d.title,
              d.has_draft ? when(d.draft_updated_at) : 'No draft',
              d.published_at ? when(d.published_at) : 'Not published',
              <Button key="o" onClick={() => go('documents', d.id)}>
                Open
              </Button>,
            ])}
          />
        ) : (
          <Empty>No documents yet. Create one, or open the editor and save to your workspace.</Empty>
        )}
      </Panel>
    </>
  );
}

function DocumentDetail({ id }: { id: string }) {
  const { P, go, workspace } = useWs();
  const notice = useNotice();
  const [progress, setProgress] = useState<UploadProgress>();
  const [thread, setThread] = useState<{ title: string; data: any }>();
  const { data, error, reload } = useLoad(async () => {
    const [d, links] = await Promise.all([api(`${P}/documents/${enc(id)}`), api(`${P}/links?target_id=${enc(id)}`)]);
    return { d, links: links.items as any[] };
  }, [P, id]);
  const checking = !!data?.d.draft_uploads?.some((u: any) => u.status === 'processing');
  usePollWhile(checking, reload);
  if (error) return <Panel title="Document">{error.message}</Panel>;
  if (!data) return <Muted>Loading…</Muted>;
  const { d, links } = data;
  const editHref = `/edit?ws=${enc(workspace.id)}&doc=${enc(id)}`;

  const published = d.versions.some((v: any) => v.published);
  const steps: Array<[string, string, boolean]> = [
    ['Draft', d.has_draft ? 'Saved privately' : 'Edit or upload a PDF', !!d.has_draft],
    ['Version', d.versions.length ? `${d.versions.length} frozen cop${d.versions.length === 1 ? 'y' : 'ies'}` : 'Export the draft', d.versions.length > 0],
    ['Published', published ? 'Links show it' : 'Publish a version', published],
    ['Shared', links.length ? `${links.length} link${links.length === 1 ? '' : 's'}` : 'Create a share link', links.length > 0],
  ];
  return (
    <>
      <ol className="doc-steps" aria-label="Progress">
        {steps.map(([title, text, done], i) => (
          <li key={title} className={done ? 'done' : ''}>
            <span className="req-mark" aria-hidden="true">
              {done ? '✓' : i + 1}
            </span>
            <span>
              <strong>{title}</strong>
              <span className="muted small">{text}</span>
            </span>
          </li>
        ))}
      </ol>
      <Panel
        title={d.title}
        actions={
          <Button kind="ghost" onClick={() => go('documents')}>
            ← All documents
          </Button>
        }
      >
        <p>
          {d.require_approval
            ? 'Publication requires an approval from a reviewer other than the author.'
            : 'Publication is explicit; nothing becomes public automatically.'}
        </p>
        <div className="actions">
          <Link className="button primary" href={editHref}>
            {d.has_draft ? 'Edit draft in the editor' : 'Open the editor'}
          </Link>
          <label className="button file-button">
            Upload a PDF as the draft
            <input
              type="file"
              accept="application/pdf,.pdf"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                try {
                  await ownerUpload(workspace.id, f, { target: 'draft', document_id: id }, setProgress);
                  setProgress(undefined);
                  notice(DRAFT_SAVED);
                  reload();
                } catch (err) {
                  notice((err as Error).message, true);
                }
              }}
            />
          </label>
          {d.has_draft && <Button onClick={() => ownerDownload(workspace.id, 'draft', id)}>Download draft</Button>}
        </div>
        <Progress p={progress} />
        {checking && <Muted>Checking the new draft… this usually takes a few seconds.</Muted>}
        {d.draft_uploads
          ?.filter((u: any) => u.status === 'rejected')
          .map((u: any) => (
            <p key={u.upload_id} className="replacement">
              A draft upload was rejected{u.reject_reason ? `: ${u.reject_reason}` : ''}.
            </p>
          ))}
      </Panel>

      <Panel title="Versions (frozen copies)">
        <p className="muted">Exporting freezes the current draft as an immutable version. Only publishing changes what “latest” links serve.</p>
        {d.has_draft ? (
          <Form
            fields={[{ name: 'note', label: 'Version note', optional: true }]}
            submit="Export new version"
            onSubmit={async (v) => {
              const ver = await api(`${P}/documents/${enc(id)}/export`, { body: v.note ? { note: v.note } : {} });
              notice(`Version ${ver.number} exported. It is private until you publish or share it as a fixed version.`);
              reload();
            }}
          />
        ) : (
          <Empty>{checking ? 'The export option appears once the draft has been checked.' : 'Save a draft first.'}</Empty>
        )}
        {d.versions.length > 0 && (
          <Table
            head={['Version', 'Note', 'Exported', 'State', 'Review', '']}
            rows={d.versions.map((v: any) => [
              `v${v.number}`,
              v.note || '—',
              when(v.created_at),
              <Badge key="s" state={v.published ? 'published' : 'private'} />,
              `${v.approvals} approved · ${v.changes_requested} changes`,
              <div key="a" className="actions">
                <Button onClick={() => ownerDownload(workspace.id, 'version', v.id)}>Download</Button>
                {!v.published && (
                  <Button
                    onClick={async () => {
                      const note = d.published_version_id ? ask('Explain the change to recipients (optional):') : undefined;
                      await api(`${P}/documents/${enc(id)}/publish`, { body: { version_id: v.id, ...(note ? { replacement_note: note } : {}) } });
                      notice(`Version ${v.number} is now the published version.`);
                      reload();
                    }}
                  >
                    Publish
                  </Button>
                )}
                <Button
                  onClick={() =>
                    go('links', undefined, {
                      target_type: 'document',
                      target_id: id,
                      version_mode: 'fixed',
                      version_id: v.id,
                      label: `${d.title} v${v.number}`,
                    })
                  }
                >
                  Share this version
                </Button>
                <Button
                  onClick={async () =>
                    setThread({ title: `Review · version ${v.number}`, data: await api(`${P}/documents/${enc(id)}/versions/${enc(v.id)}/review`) })
                  }
                >
                  Review thread
                </Button>
              </div>,
            ])}
          />
        )}
      </Panel>

      <Panel
        title="Links to this document"
        actions={
          <Button kind="primary" onClick={() => go('links', undefined, { target_type: 'document', target_id: id, version_mode: 'latest', label: d.title })}>
            Share latest published version
          </Button>
        }
      >
        {links.length ? (
          <Table
            head={['Link', 'Serves', 'Permission', 'State', '']}
            rows={links.map((l) => [
              l.label || l.id,
              l.version_mode === 'fixed'
                ? `Fixed version ${l.serves_version}`
                : `Latest published${l.serves_version ? ` (v${l.serves_version})` : ' (none yet)'}`,
              l.permission,
              <Badge key="s" state={l.state} />,
              <Button key="m" onClick={() => go('links', l.id)}>
                Manage
              </Button>,
            ])}
          />
        ) : (
          <Empty>Not shared yet.</Empty>
        )}
      </Panel>

      <Panel>
        <Button
          kind="danger"
          onClick={async () => {
            if (!confirmAction('Delete this document, its versions and their links?')) return;
            await api(`${P}/documents/${enc(id)}/delete`, { body: {} });
            go('documents');
          }}
        >
          Delete document
        </Button>
      </Panel>

      <Modal open={!!thread} onClose={() => setThread(undefined)} title={thread?.title ?? ''}>
        {thread &&
          (thread.data.comments.length ? (
            thread.data.comments.map((c: any, i: number) => (
              <p key={i}>
                <strong>{c.author}</strong>
                {c.page ? ` (page ${c.page})` : ''}: {c.body}
              </p>
            ))
          ) : (
            <Empty>No comments.</Empty>
          ))}
        {thread?.data.reviews.map((r: any, i: number) => (
          <Details key={i} items={[[r.reviewer, `${r.decision.replace('_', ' ')}${r.note ? ` — ${r.note}` : ''}`]]} />
        ))}
      </Modal>
    </>
  );
}
