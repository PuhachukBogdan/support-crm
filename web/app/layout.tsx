import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '../src/styles/globals.css';
import { Providers } from './providers';
import { readSessionSeed } from '@/session/session-seed';

// White-label: generic title/description — no brand identity (Principle VI).
export const metadata: Metadata = {
  title: 'Support CRM',
  description: 'White-label support CRM.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The session cookie is read HERE, on the server, because the server can see it and the browser
  // cannot (research §3). It is a hint, never an answer: `readSessionSeed` returns `anonymous` only
  // when no cookie exists at all, and `resolving` otherwise — an expired cookie must never be
  // rendered as signed in (Principle II).
  const sessionSeed = await readSessionSeed();

  // next-themes manages the `.dark` class on <html>; suppress the expected
  // server/client class mismatch it introduces.
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers sessionSeed={sessionSeed}>{children}</Providers>
      </body>
    </html>
  );
}
