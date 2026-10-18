import { redirect } from 'next/navigation';
export default function ShortenPage() {
  redirect('/app?tab=short-links');
}
