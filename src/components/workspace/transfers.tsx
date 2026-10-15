'use client';
import { useState } from 'react';
import { Badge, Button, Details, Empty, Form, Muted, Panel, Progress, Table, ask, confirmAction, useNotice } from '@/components/ui';
import { api, enc } from '@/lib/client/api';
import { fmtBytes, inDays, when } from '@/lib/client/format';
import type { UploadProgress } from '@/lib/client/uploader';
import { ownerDownload, ownerUpload, useLoad, usePollWhile, useWs } from './context';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Transfers() {
  const { nav } = useWs();
  return nav.id ? <TransferDetail id={nav.id} /> : <TransferList />;
}

function TransferList() {
  const { P, go } = useWs();
  const { data, error } = useLoad<any>(() => api(`${P}/transfers`), [P]);
  return (
    <>
      <Panel title="New transfer">
        <Form
          fields={[
            { name: 'title', label: 'Title' },
            { name: 'message', label: 'Message to recipients', type: 'textarea', optional: true },
            {
              name: 'kind',
              label: 'Kind',
              type: 'select',
              options: [
                ['temporary', 'Temporary (files deleted at expiry)'],
                ['persistent', 'Persistent (plan feature)'],
              ],
            },
            { name: 'days', label: 'Days until expiry', type: 'number', value: '7', min: 1, show: (v) => v.kind === 'temporary' },
          ]}
          submit="Create transfer"
          onSubmit={async (v) => {
            const t = await api(`${P}/transfers`, {
              body: {
                title: v.title,
                ...(v.message ? { message: v.message } : {}),
                kind: v.kind,
                ...(v.kind === 'temporary' ? { expires_at: inDays(v.days || 7) } : {}),
              },
            });
            go('transfers', t.id);
          }}
        />
      </Panel>
      <Panel title="Transfers">
        {error ? (
          <p>{error.message}</p>
        ) : !data ? (
          <Muted>Loading…</Muted>
        ) : data.items.length ? (
          <Table
            head={['Transfer', 'Kind', 'State', 'Expires', '']}
            rows={data.items.map((t: any) => [
              t.title,
              t.kind,
              <Badge key="s" state={t.status} />,
              when(t.expires_at),
              <Button key="o" onClick={() => go('transfers', t.id)}>
                Open
              </Button>,
            ])}
          />
        ) : (
          <Empty>No transfers yet.</Empty>
        )}
      </Panel>
    </>
  );
}

interface Pending {
  name: string;
  p?: UploadProgress;
  done?: string;
}

function TransferDetail({ id }: { id: string }) {
  const { P, go, workspace } = useWs();
  const notice = useNotice();
  const [pending, setPending] = useState<Pending[]>([]);
  const { data: t, error, reload } = useLoad<any>(() => api(`${P}/transfers/${enc(id)}`), [P, id]);
  usePollWhile(!!t?.files.some((f: any) => f.status === 'processing'), reload);
  if (error) return <Panel title="Transfer">{error.message}</Panel>;
  if (!t) return <Muted>Loading…</Muted>;

  const run = async (files: FileList | null) => {
    const list = [...(files ?? [])];
    setPending(list.map((f) => ({ name: f.webkitRelativePath || f.name })));
    for (const [i, file] of list.entries()) {
      const set = (x: Partial<Pending>) => setPending((ps) => ps.map((p, j) => (j === i ? { ...p, ...x } : p)));
      const path = file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(0, -1).join('/') : undefined;
      try {
        await ownerUpload(workspace.id, file, { target: 'transfer', transfer_id: id, ...(path ? { folder_path: path } : {}) }, (p) => set({ p }));
        set({ done: 'Uploaded · checking' });
      } catch (e) {
        set({ done: (e as Error).message });
      }
    }
    reload();
  };

  const replace = async (f: any, file: File | undefined) => {
    if (!file) return;
    const note = ask('Explain the replacement to recipients (optional):');
    setPending([{ name: `${f.name} (replacement)` }]);
    try {
      await ownerUpload(
        workspace.id,
        file,
        { target: 'replace', transfer_id: id, file_id: f.id, ...(note ? { note } : {}) },
        (p) => setPending([{ name: f.name, p }]),
        f.name,
      );
      setPending([]);
      notice('Replacement uploaded. The link keeps serving the current file until the new one passes checks.');
      reload();
    } catch (e) {
      notice((e as Error).message, true);
    }
  };

  return (
    <>
      <Panel
        title={t.title}
        actions={
          <Button kind="ghost" onClick={() => go('transfers')}>
            ← All transfers
          </Button>
        }
      >
        <Details
          items={[
            ['Kind', t.kind],
            ['State', <Badge key="s" state={t.status} />],
            ['Expires', when(t.expires_at)],
            ['Files deleted', t.files_deleted_at ? when(t.files_deleted_at) : t.kind === 'temporary' ? 'at expiry' : 'kept until you delete the transfer'],
          ]}
        />
        {t.message && <p className="quote">{t.message}</p>}
      </Panel>
      {t.status === 'active' && (
        <Panel title="Add files">
          <Muted>Uploads go directly to private storage and resume if interrupted: choose the same file again to continue.</Muted>
          <div className="actions">
            <label className="button file-button primary">
              Choose files
              <input type="file" multiple onChange={(e) => void run(e.target.files).finally(() => (e.target.value = ''))} />
            </label>
            <label className="button file-button">
              Choose a folder
              <input type="file" {...({ webkitdirectory: '' } as object)} onChange={(e) => void run(e.target.files).finally(() => (e.target.value = ''))} />
            </label>
          </div>
          {pending.map((p, i) => (
            <div key={i}>
              <strong>{p.name}</strong>
              <Progress p={p.p} label={p.done} />
            </div>
          ))}
        </Panel>
      )}
      <Panel title="Files">
        {t.files.length ? (
          <Table
            head={['File', 'Size', 'Status', 'Revision', '']}
            rows={t.files.map((f: any) => [
              f.folder_path ? `${f.folder_path}/${f.name}` : f.name,
              fmtBytes(f.size),
              <Badge key="s" state={f.status} />,
              f.revision > 1 ? `rev ${f.revision}${f.replacement_note ? ` · ${f.replacement_note}` : ''}` : '—',
              <div key="a" className="actions">
                {f.status === 'available' && <Button onClick={() => ownerDownload(workspace.id, 'transfer_file', f.id)}>Download</Button>}
                {t.status === 'active' && (
                  <label className="button file-button">
                    Replace
                    <input
                      type="file"
                      aria-label={`Replace ${f.name}`}
                      onChange={(e) => void replace(f, e.target.files?.[0]).finally(() => (e.target.value = ''))}
                    />
                  </label>
                )}
                <Button
                  onClick={async () => {
                    await api(`${P}/transfers/${enc(id)}/files/${enc(f.id)}/remove`, { body: {} });
                    reload();
                  }}
                >
                  Remove
                </Button>
              </div>,
            ])}
          />
        ) : (
          <Empty>No files yet.</Empty>
        )}
      </Panel>
      <Panel title="Share">
        <div className="actions">
          {t.status === 'active' && (
            <Button kind="primary" onClick={() => go('links', undefined, { target_type: 'transfer', target_id: id, label: t.title })}>
              Create a share link
            </Button>
          )}
          {t.status === 'active' && (
            <Button
              kind="danger"
              onClick={async () => {
                if (!confirmAction('Revoke every link to this transfer? Copies already downloaded cannot be recalled.')) return;
                await api(`${P}/transfers/${enc(id)}/revoke`, { body: {} });
                reload();
              }}
            >
              Revoke transfer
            </Button>
          )}
          <Button
            kind="danger"
            onClick={async () => {
              if (!confirmAction('Delete this transfer and its files?')) return;
              await api(`${P}/transfers/${enc(id)}/delete`, { body: {} });
              go('transfers');
            }}
          >
            Delete transfer
          </Button>
        </div>
      </Panel>
    </>
  );
}
