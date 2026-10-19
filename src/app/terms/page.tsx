import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage } from '@/components/legal-page';
import { COMPANY } from '@/lib/company';
export const metadata: Metadata = { title: 'Terms of Service' };

export default function Terms() {
  return (
    <LegalPage title="Terms of Service">
      <h2>Who operates the service</h2>
      <p>
        Rokela PDF is provided by {COMPANY.name}, registered in {COMPANY.location}. These terms cover our PDF tools, file transfers, upload requests and link
        shortener.
      </p>
      <h2>Your account and workspace</h2>
      <p>
        Keep your sign-in credentials secure and provide accurate account information. Workspace administrators manage membership and access. You are
        responsible for the files, recipients, destinations and settings you select.
      </p>
      <h2>Content ownership and processing</h2>
      <p>
        You retain ownership of your files. You authorize us to store, process, security-check, convert and deliver content as needed to provide the features
        you use. You must have permission to upload, modify, request and distribute that content. Our <Link href="/ownership">ownership notice</Link> explains
        rights in the service itself.
      </p>
      <h2>Permitted use</h2>
      <p>
        Do not use the service for unlawful material, malware, phishing, unsolicited bulk messages, rights infringements or attempts to bypass access controls
        and quotas. We may restrict access or suspend links and accounts to address abuse or protect the service. You can{' '}
        <Link href="/report">report abuse</Link>.
      </p>
      <h2>Sharing and uploads</h2>
      <p>
        Anyone who receives a link may be able to use it, subject to its access controls. Set passwords, recipient restrictions and deadlines where appropriate.
        Names and email addresses entered by upload-request submitters are self-reported and are not proof of identity. A sent or queued email is not a
        guarantee of inbox delivery.
      </p>
      <h2>Plans, limits and retention</h2>
      <p>
        Your workspace plan determines the features and limits available across the services. Plans are currently operator-managed. Review the limits, deadlines
        and deletion dates displayed in the app. Link expiry and file deletion are different events; retain your own copies of important files.
      </p>
      <h2>Availability and changes</h2>
      <p>
        Features and availability may change, and processing may fail or produce a result that needs checking. Review converted or edited files before relying
        on them. These terms do not exclude rights that applicable law does not allow us to exclude. Changes to these terms will be reflected on this page with
        an updated effective date.
      </p>
      <h2>Contact</h2>
      <p>
        For service, ownership or terms enquiries, contact <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>. See our{' '}
        <Link href="/privacy">Privacy Policy</Link> for information about data processing.
      </p>
    </LegalPage>
  );
}
