import { Suspense } from 'react';
import type { Metadata } from 'next';
import { WorkspacePage } from '@/components/workspace/shell';

export const metadata: Metadata = { title: 'Files & links' };

export default function Page() {
  return (
    <Suspense fallback={<p className="muted center">Loading…</p>}>
      <WorkspacePage />
    </Suspense>
  );
}
