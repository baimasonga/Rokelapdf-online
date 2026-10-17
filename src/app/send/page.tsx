import { redirect } from 'next/navigation';

/** Short, memorable entry point for sending files; the send form lives in the workspace (sign-in required). */
export default function SendPage() {
  redirect('/app?tab=transfers');
}
