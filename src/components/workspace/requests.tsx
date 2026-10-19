'use client';
import { useState } from 'react';
import { Badge, Button, CopyField, Details, Empty, Form, Muted, Panel, Table, confirmAction } from '@/components/ui';
import { api, enc } from '@/lib/client/api';
import { fmtBytes, inDays, splitList, when } from '@/lib/client/format';
import { ownerDownload, useLoad, usePollWhile, useWs } from './context';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Requests() {
  const { nav } = useWs();
  return nav.id ? <RequestDetail id={nav.id} /> : <RequestList />;
}

function RequestForm() {
  const { P, go } = useWs();
  return (
    <Panel title="Request files">
      <p className="muted">People you send the link to can upload files for you. They see only their own uploads.</p>
      <Form
        fields={[
          { name: 'title', label: 'Title' },
          { name: 'instructions', label: 'Instructions', type: 'textarea', optional: true },
          { name: 'items', label: 'Files you need, comma separated', placeholder: 'Passport scan, Signed contract' },
          {
            name: 'accept',
            label: 'Accepted types',
            type: 'select',
            options: [
              ['pdf', 'PDF only'],
              ['pdf,png,jpg,jpeg', 'PDF and images'],
              ['', 'Any permitted format'],
            ],
          },
          { name: 'days', label: 'Deadline in days', type: 'number', value: '14', min: 1 },
          { name: 'max_mb', label: 'Largest file (MB)', type: 'number', value: '25', min: 1 },
          { name: 'password', label: 'Password', type: 'password', optional: true, autoComplete: 'new-password' },
          { name: 'notify', label: 'Email me when a submission arrives', type: 'checkbox', value: 'yes' },
        ]}
        submit="Create upload request"
        onSubmit={async (f) => {
          const labels = splitList(f.items);
          if (!labels.length) throw new Error('List at least one file you need.');
          const mb = Number(f.max_mb) * 1024 * 1024;
          const r = await api(`${P}/upload-requests`, {
            body: {
              title: f.title,
              ...(f.instructions ? { instructions: f.instructions } : {}),
              requirements: labels.map((label, i) => ({
                key: `item-${i + 1}`,
                label: label.slice(0, 200),
                required: true,
                max_files: 5,
                ...(f.accept ? { accept: f.accept.split(',') } : {}),
              })),
              deadline: inDays(f.days || 14),
              max_file_bytes: mb,
              max_total_bytes: mb * 10,
              ...(f.password ? { password: f.password } : {}),
              notify: f.notify === 'yes',
            },
          });
          go('requests', r.id);
        }}
      />
    </Panel>
  );
}

function RequestList() {
  const { P, go } = useWs();
  const { data, error } = useLoad<any>(() => api(`${P}/upload-requests`), [P]);
  // The server enforces the plan; this only explains it before the user fills in the form.
  const { data: overview } = useLoad<any>(() => api(`${P}/overview`), [P]);
  return (
    <>
      {overview &&
        (overview.limits.upload_requests ? (
          <RequestForm />
        ) : (
          <Panel title="Request files">
            <p>Upload requests are not included in this workspace&apos;s plan. Existing requests stay available below.</p>
          </Panel>
        ))}
      <Panel title="Upload requests">
        {error ? (
          <p>{error.message}</p>
        ) : !data ? (
          <Muted>Loading…</Muted>
        ) : data.items.length ? (
          <Table
            head={['Request', 'Deadline', 'State', '']}
            rows={data.items.map((r: any) => [
              r.title,
              when(r.deadline),
              <Badge key="s" state={r.accepting ? 'open' : r.status} />,
              <Button key="o" onClick={() => go('requests', r.id)}>
                Open
              </Button>,
            ])}
          />
        ) : (
          <Empty>No upload requests yet.</Empty>
        )}
      </Panel>
    </>
  );
}

export function RequestDetail({ id }: { id: string }) {
  const { P, go, workspace } = useWs();
  const { data: r, error, reload } = useLoad<any>(() => api(`${P}/upload-requests/${enc(id)}`), [P, id]);
  usePollWhile(!!r?.submissions.some((x: any) => x.files.some((f: any) => f.status === 'processing')), reload);
  if (error) return <Panel title="Upload request">{error.message}</Panel>;
  if (!r) return <Muted>Loading…</Muted>;
  return (
    <>
      <Panel
        title={r.title}
        actions={
          <Button kind="ghost" onClick={() => go('requests')}>
            ← All upload requests
          </Button>
        }
      >
        <RequestSharing id={id} url={r.url} accepting={r.accepting} />
        <Details
          items={[
            ['Accepting files', r.accepting ? 'Yes' : 'No'],
            ['Deadline', when(r.deadline)],
            ['Largest file', fmtBytes(r.max_file_bytes)],
            ['Files deleted after', r.delete_after ? when(r.delete_after) : 'kept until you delete the request'],
          ]}
        />
        <div className="actions">
          <Button
            onClick={async () => {
              const s = await api(`${P}/short-links`, {
                body: { kind: 'confidential', destination_type: 'request', target_id: id, label: r.title.slice(0, 200) },
              });
              go('short-links', s.id);
            }}
          >
            Create confidential short link
          </Button>
          {r.status === 'open' && (
            <Button
              onClick={async () => {
                await api(`${P}/upload-requests/${enc(id)}/status`, { body: { action: 'close' } });
                reload();
              }}
            >
              Close request
            </Button>
          )}
          <Button
            kind="danger"
            onClick={async () => {
              if (!confirmAction('Delete this request and every uploaded file?')) return;
              await api(`${P}/upload-requests/${enc(id)}/status`, { body: { action: 'delete' } });
              go('requests');
            }}
          >
            Delete request and files
          </Button>
        </div>
      </Panel>
      <Panel title="Submissions">
        <p className="muted">Names and emails are typed by the submitter and are not verified.</p>
        {r.submissions.length ? (
          <Table
            head={['From', 'State', 'Files']}
            rows={r.submissions.map((s: any) => [
              `${s.submitter_name}${s.submitter_email ? ` <${s.submitter_email}>` : ''}`,
              <Badge key="s" state={s.status} />,
              <div key="f">
                {s.files.map((f: any) => (
                  <div key={f.id} className="file-line">
                    {f.name} · {fmtBytes(f.size)} · {f.status}
                    {f.reject_reason ? ` (${f.reject_reason})` : ''}{' '}
                    {f.status === 'available' && <Button onClick={() => ownerDownload(workspace.id, 'submission_file', f.id)}>Download</Button>}
                  </div>
                ))}
              </div>,
            ])}
          />
        ) : (
          <Empty>No submissions yet.</Empty>
        )}
      </Panel>
    </>
  );
}

function RequestSharing({ id, url, accepting }: { id: string; url: string; accepting: boolean }) {
  const { P, me } = useWs();
  const [open, setOpen] = useState(false);
  const [queued, setQueued] = useState(0);
  const { data: config } = useLoad<any>(() => api('/api/v1/config'), []);
  return (
    <>
      <div className="request-share-actions">
        <CopyField value={url} label="Upload request URL" />
        <Button
          kind="primary"
          disabled={!accepting}
          onClick={() => {
            setOpen(!open);
            setQueued(0);
          }}
        >
          {open ? 'Cancel sending' : 'Send link'}
        </Button>
      </div>
      {open && (
        <Panel title="Send request link by email">
          {!config ? (
            <Muted>Loading email settings…</Muted>
          ) : !config.email ? (
            <p>Email delivery is unavailable. Use Copy to share the link.</p>
          ) : !me.email_verified ? (
            <p>Confirm your email address before sending invitations. You can still copy the link.</p>
          ) : (
            <>
              <p className="muted">
                Sent by {config.email_sender}. Replies go to {me.email}.
              </p>
              <Form
                fields={[
                  {
                    name: 'to',
                    label: 'Recipient emails',
                    placeholder: 'person@example.com, another@example.com',
                    hint: 'Separate addresses with commas. Up to 20 recipients.',
                  },
                  { name: 'message', label: 'Message', type: 'textarea', optional: true },
                ]}
                submit="Send link"
                onSubmit={async (f) => {
                  const result = await api(`${P}/upload-requests/${enc(id)}/email`, {
                    body: { to: splitList(f.to), ...(f.message ? { message: f.message } : {}) },
                  });
                  setQueued(result.queued);
                }}
              />
              {queued > 0 && (
                <p role="status">
                  Email queued for {queued} recipient{queued === 1 ? '' : 's'}. Delivery will continue in the background.
                </p>
              )}
            </>
          )}
        </Panel>
      )}
    </>
  );
}
