import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '../src/styles/globals.css';
import { Providers } from './providers';

// White-label: generic title/description — no brand identity (Principle VI).
export const metadata: Metadata = {
  title: 'Support CRM',
  description: 'White-label support CRM.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // next-themes manages the `.dark` class on <html>; suppress the expected
  // server/client class mismatch it introduces.
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
