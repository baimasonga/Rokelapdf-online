'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Editor } from '@/components/editor/editor';
import { Header } from '@/components/header';

function EditorRoute() {
  const q = useSearchParams();
  return <Editor ws={q.get('ws') ?? undefined} docId={q.get('doc') ?? undefined} handoff={q.get('handoff') === '1'} initialTool={q.get('tool') ?? undefined} />;
}

export default function Page() {
  return (
    <>
      <Header />
      <Suspense fallback={<p className="muted center">Loading…</p>}>
        <EditorRoute />
      </Suspense>
    </>
  );
}
