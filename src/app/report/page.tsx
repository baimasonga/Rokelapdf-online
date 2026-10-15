'use client';
import { useState } from 'react';
import { Header } from '@/components/header';
import { Form, Panel } from '@/components/ui';
import { api } from '@/lib/client/api';

export default function ReportAbuse() {
  const [done, setDone] = useState(false);
  return (
    <>
      <Header />
      <main className="narrow">
        {done ? (
          <Panel title="Thank you">Your report was received and will be reviewed.</Panel>
        ) : (
          <Panel title="Report abuse">
            <p>Tell us about a link hosted on Rokela PDF Pro that is used for phishing, malware or spam.</p>
            <Form
              fields={[
                { name: 'reference', label: 'The link you are reporting', placeholder: 'https://…' },
                {
                  name: 'category',
                  label: 'Category',
                  type: 'select',
                  options: [
                    ['phishing', 'Phishing'],
                    ['malware', 'Malware'],
                    ['spam', 'Spam'],
                    ['other', 'Something else'],
                  ],
                },
                { name: 'details', label: 'Details', type: 'textarea', optional: true },
                { name: 'email', label: 'Your email, if we may contact you', type: 'email', optional: true, autoComplete: 'email' },
              ]}
              submit="Send report"
              onSubmit={async (v) => {
                await api('/api/v1/public/abuse-reports', {
                  auth: false,
                  body: { reference: v.reference, category: v.category, ...(v.details ? { details: v.details } : {}), ...(v.email ? { email: v.email } : {}) },
                });
                setDone(true);
              }}
            />
          </Panel>
        )}
      </main>
    </>
  );
}
