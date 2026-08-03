'use client';

/**
 * The last line of defence: an error thrown in the ROOT layout or providers.
 *
 * ⚠️⚠️ **Until this file existed, the application had NO error boundary of any kind.** A single
 * uncaught render error therefore unmounted the whole React tree, and what the person saw was an
 * **empty `<body>`** — no message, no clue, clicks and scrolling dead because there was nothing left
 * on the page. The operator reported it as "the site hangs"; DevTools showed an empty DOM and an
 * empty console, which is exactly what a silently discarded tree looks like from the outside.
 *
 * ⇒ A blank page is the worst possible failure mode: it destroys the evidence. Anything visible —
 * even an ugly error string — is better, because it can be read, reported and fixed.
 *
 * `global-error` must render its own `<html>` and `<body>`: it replaces the root layout, which by
 * definition may be the thing that failed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: '3rem', lineHeight: 1.6 }}>
        <h1 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>Something broke in the shell</h1>
        <p style={{ marginBottom: '1rem' }}>
          The application could not start. The details below are what to send on.
        </p>
        <pre
          data-testid="global-error-details"
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: '#f4f4f5',
            color: '#18181b',
            padding: '1rem',
            borderRadius: '6px',
            fontSize: '0.8125rem',
          }}
        >
          {error.name}: {error.message}
          {error.digest ? `\ndigest: ${error.digest}` : ''}
        </pre>
        <button
          type="button"
          onClick={() => reset()}
          style={{ marginTop: '1rem', padding: '0.5rem 1rem', cursor: 'pointer' }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
