import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal-page';
import { COMPANY } from '@/lib/company';
export const metadata: Metadata = { title: 'Ownership' };

export default function Ownership() {
  return (
    <LegalPage title="Ownership and intellectual property">
      <h2>Service owner</h2>
      <p>
        Rokela PDF is owned and operated by {COMPANY.name}, registered in {COMPANY.location}. Contact us at{' '}
        <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>.
      </p>
      <h2>Our software and branding</h2>
      <p>
        {COMPANY.copyright} The service’s original software, interface, content and branding belong to {COMPANY.name}. Third-party software, fonts and other
        materials remain subject to their respective licenses and owners’ rights.
      </p>
      <h2>Your files remain yours</h2>
      <p>
        You retain ownership of your uploaded files and content. Uploading, converting, transferring or sharing a file does not transfer ownership to{' '}
        {COMPANY.name}. You are responsible for having the rights and permission to use and share that content.
      </p>
      <h2>Ownership enquiries</h2>
      <p>
        For licensing questions or an intellectual-property concern, email <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a> with the relevant link and a
        description of your concern. Do not email passwords or unnecessary confidential files.
      </p>
    </LegalPage>
  );
}
