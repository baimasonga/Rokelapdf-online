'use client';
import { Badge, Button, CopyField, Empty, Form, Muted, Panel, Table } from '@/components/ui';
import { api } from '@/lib/client/api';
import { inDays, when } from '@/lib/client/format';
import { useLoad, useWs } from './context';
import { RequestDetail } from './requests';
import { useState } from 'react';
/* eslint-disable @typescript-eslint/no-explicit-any */
export function SignatureRequests() {
  const { P, go, nav } = useWs();
  const [created, setCreated] = useState<any>();
  const { data, error, reload } = useLoad<any>(async () => {
    const [documents, requests] = await Promise.all([api(`${P}/documents`), api(`${P}/upload-requests`)]);
    return {
      documents: documents.items.filter((d: any) => d.published_version_id),
      requests: requests.items.filter((r: any) => r.title.startsWith('Signature requested: ')),
    };
  }, [P]);
  if (nav.id) return <RequestDetail id={nav.id} />;
  return (
    <>
      <Panel title="Request a signed PDF">
        <p>
          Share a fixed published document, let recipients sign it with the PDF editor, and collect the signed copy through a private upload request. Returned
          PDFs are scanned before they become available.
        </p>
        <p className="muted">
          Submission names and email addresses are declared by the recipient. This workflow does not issue certificate-based digital signatures.
        </p>
        {error ? (
          <p role="alert">{error.message}</p>
        ) : !data ? (
          <Muted>Loading…</Muted>
        ) : !data.documents.length ? (
          <Empty>Publish a document version first.</Empty>
        ) : (
          <Form
            fields={[
              { name: 'document_id', label: 'Published document', type: 'select', options: data.documents.map((d: any) => [d.id, d.title]) },
              { name: 'days', label: 'Deadline in days', type: 'number', min: 1, max: 90, value: '7' },
              { name: 'password', label: 'Password for the document and return link', type: 'password', optional: true },
            ]}
            submit="Create signature request"
            onSubmit={async (f) => {
              const result = await api(`${P}/signature-requests`, {
                body: { document_id: f.document_id, deadline: inDays(f.days), ...(f.password ? { password: f.password } : {}) },
              });
              setCreated(result);
              reload();
            }}
          />
        )}
        {created && (
          <>
            <h3>Send these links to the signer</h3>
            <CopyField label="Document to sign" value={created.source_url} />
            <CopyField label="Return signed PDF" value={created.url} />
          </>
        )}
      </Panel>
      <Panel title="Signature collections">
        {!data ? (
          <Muted>Loading…</Muted>
        ) : !data.requests.length ? (
          <Empty>No signature requests.</Empty>
        ) : (
          <Table
            head={['Document', 'Deadline', 'Status', '']}
            rows={data.requests.map((r: any) => [
              r.title.replace('Signature requested: ', ''),
              when(r.deadline),
              <Badge key="s" state={r.status} />,
              <Button key="m" onClick={() => go('signatures', r.id)}>
                Submissions and activity
              </Button>,
            ])}
          />
        )}
      </Panel>
    </>
  );
}
