'use client';
import { Badge, Button, CopyField, Empty, Form, Muted, Panel, Table, useNotice } from '@/components/ui';
import { api, enc } from '@/lib/client/api';
import { useLoad, useWs } from './context';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function WorkspaceSettings() {
  const { P, workspace } = useWs();
  const notice = useNotice();
  const { data, error, reload } = useLoad<any>(async () => {
    const [brand, domains, overview, subscription] = await Promise.all([
      api(`${P}/branding`),
      api(`${P}/domains`),
      api(`${P}/overview`),
      api(`/api/v1/workspaces/${workspace.id}/subscription`),
    ]);
    return { brand, domains: domains.items, overview, subscription };
  }, [P, workspace.id]);
  const manage = workspace.role !== 'member';
  if (error)
    return (
      <Panel title="Settings">
        <p role="alert">{error.message}</p>
      </Panel>
    );
  if (!data) return <Muted>Loading settings…</Muted>;
  return (
    <>
      <Panel title="One plan for all your tools">
        <p>
          <strong>{data.subscription.plan}</strong> · This workspace
        </p>
        <p>
          PDF tools, file transfers and link shortening are included under this single workspace plan, with the limits shown below. There are no separate
          product subscriptions.
        </p>
        <p className="muted">
          Plan changes are currently managed by the platform operator. Browser PDF tools remain free; server conversions require sign-in and have service
          limits.
        </p>
      </Panel>
      <Panel title="Workspace branding">
        {!data.brand.available ? (
          <p>Your current plan does not include branded recipient pages.</p>
        ) : (
          <>
            <p>Recipients see this name and accent color on shared pages.</p>
            {manage ? (
              <Form
                key={JSON.stringify(data.brand)}
                fields={[
                  { name: 'display_name', label: 'Display name', value: data.brand.display_name ?? workspace.name },
                  {
                    name: 'accent_color',
                    label: 'Accent color',
                    value: data.brand.accent_color ?? '#1d4ed8',
                    hint: 'Hex color, for example #1d4ed8. Choose a color with readable contrast.',
                  },
                ]}
                submit="Save branding"
                onSubmit={async (f) => {
                  await api(`${P}/branding`, { method: 'PUT', body: f });
                  reload();
                  notice('Branding saved.');
                }}
              />
            ) : (
              <p>Only workspace owners and admins can change branding.</p>
            )}
          </>
        )}
      </Panel>
      <Panel title="Custom short-link domains">
        <p>Verify ownership using a DNS TXT record, then configure routing and HTTPS with the platform operator before using the domain.</p>
        {!data.overview.limits.custom_domains ? (
          <p>Your current plan does not include custom domains.</p>
        ) : (
          manage && (
            <Form
              fields={[{ name: 'hostname', label: 'Hostname', placeholder: 'go.example.com' }]}
              submit="Add domain"
              onSubmit={async (f) => {
                await api(`${P}/domains`, { body: f });
                reload();
              }}
            />
          )
        )}
        {!data.domains.length ? (
          <Empty>No custom domains.</Empty>
        ) : (
          data.domains.map((d: any) => (
            <section key={d.id} className="panel">
              <h3>{d.hostname}</h3>
              <Badge state={d.status} />
              <CopyField label="TXT record name" value={d.verification.name} />
              <CopyField label="TXT record value" value={d.verification.value} />
              <p className="muted">{d.routing}</p>
              <div className="actions">
                {manage && (
                  <>
                    <Button
                      onClick={async () => {
                        const result = await api(`${P}/domains/${enc(d.id)}/verify`, { body: {} });
                        reload();
                        notice(
                          result.verified
                            ? 'Domain ownership verified. Confirm routing and HTTPS before sharing links.'
                            : 'TXT record not found yet. Check the record and allow time for DNS changes.',
                          !result.verified,
                        );
                      }}
                    >
                      Check DNS ownership
                    </Button>
                    <Button
                      kind="danger"
                      onClick={async () => {
                        if (!window.confirm(`Remove ${d.hostname}? Active short links must be revoked first.`)) return;
                        await api(`${P}/domains/${enc(d.id)}/remove`, { body: {} });
                        reload();
                      }}
                    >
                      Remove domain
                    </Button>
                  </>
                )}
              </div>
            </section>
          ))
        )}
      </Panel>
      <Panel title="Workspace limits">
        <Table
          head={['Limit', 'Value']}
          rows={Object.entries(data.overview.limits).map(([k, v]) => [
            k.replace(/_/g, ' '),
            typeof v === 'boolean' ? (v ? 'Included' : 'Not included') : String(v),
          ])}
        />
      </Panel>
    </>
  );
}
