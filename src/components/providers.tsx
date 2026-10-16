'use client';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/client/auth';
import { NoticeProvider } from './ui';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <NoticeProvider>{children}</NoticeProvider>
    </AuthProvider>
  );
}
