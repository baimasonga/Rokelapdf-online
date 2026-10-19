import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal-page';
import { COMPANY } from '@/lib/company';
export const metadata: Metadata = { title: 'Privacy Policy' };

export default function Privacy() {
  return (
    <LegalPage title="Privacy Policy">
      <h2>Who is responsible</h2>
      <p>
        {COMPANY.name}, registered in {COMPANY.location}, operates Rokela PDF. Contact <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a> about privacy,
        access, correction or deletion requests.
      </p>
      <h2>Information we process</h2>
      <p>
        Depending on the features you use, we process account email addresses, workspace membership, files and filenames, messages, recipients, link
        destinations, settings and activity records. Upload-request submitters may provide a name and email address without an account. Security and hosting
        systems may process technical request information to operate the service and prevent abuse.
      </p>
      <h2>Browser tools and server processing</h2>
      <p>
        Browser-based PDF tools process files on your device. Features such as saving to a workspace, file transfers, upload requests and server-side Office
        conversion send content to our infrastructure. Uploaded files undergo security checks. Files remain yours; using the service does not transfer their
        ownership.
      </p>
      <h2>Who can access shared content</h2>
      <p>
        Workspace access and the sharing settings you choose control access to stored content. People with a link may be able to open it unless you add
        restrictions. Upload-request submitters see their own submission rather than other people’s submissions; authorized requester-workspace members can
        access collected files. Authorized service operations and security processes also handle content as needed to provide the service.
      </p>
      <h2>Infrastructure and email providers</h2>
      <p>
        We use providers including Railway for hosting, Supabase for authentication and database services, and Cloudflare for file storage and email delivery.
        Providers process relevant information to supply these services and may process it outside Sierra Leone. Email invitations include recipient addresses,
        your message and the access link you choose to send.
      </p>
      <h2>Storage and retention</h2>
      <p>
        Retention depends on workspace settings, the type of file, and the deadlines and deletion dates shown in the app. Closing or expiring a link does not
        always delete its underlying files. Deletion and cleanup run in the background; access, audit, notification and security records may have different
        retention periods. Contact us about information that is not covered by the app’s deletion controls.
      </p>
      <h2>Local browser storage and analytics</h2>
      <p>
        The app uses browser storage for authentication sessions and upload-resume metadata. Short-link statistics are aggregated, separate likely automated
        visits, and may include approximate referring-site information. These figures are not verified counts of individual people. Account and sharing activity
        may be recorded for security, audit and requester notifications.
      </p>
      <h2>Your choices</h2>
      <p>
        You can manage sharing settings, close requests, revoke links and use the deletion controls available to your workspace role. Keep private links and
        passwords confidential. For privacy enquiries or rights requests, email <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>; we may need to verify
        your identity and authority over the information concerned.
      </p>
    </LegalPage>
  );
}
