import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '../src/styles/globals.css';
import { Providers } from './providers';

// White-label: generic title/description — no brand identity (Principle VI).
export const metadata: Metadata = {
  title: 'CRM — Phase 0 scaffold',
  description: 'White-label support CRM — Phase 0 tooling skeleton.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // Default to the light token set; the sample page toggles the `.dark` class.
  return (
    <html lang="en" className="light">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
