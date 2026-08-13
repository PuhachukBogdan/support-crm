'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useContactLookup } from './use-contact-lookup';

/**
 * W9 / spec 035 — search-and-attach, inside an unidentified ticket (ADR 0044 §4/§5).
 *
 * ⛔ **What this deliberately is NOT:** a directory. It renders only under an unidentified
 * conversation, shows at most ONE match, never a results grid, never a card before attaching, and
 * has no route of its own — the nav must never gain an entry for it (SEC-AP4 ④). Those absences
 * are the feature; the box is the easy part.
 *
 * ⛔ And it renders only for a holder of `crm.contact.lookup` — RENDER-only gating, as always: the
 * server refuses regardless, and this just avoids showing a control that would 403.
 */
export function IdentityPanel({
  conversationId,
  identified,
  canLookUp,
  onChanged,
}: {
  conversationId: string;
  identified: boolean;
  canLookUp: boolean;
  /** Re-read the window: identity changed, so the header, the fields and the rail all move. */
  onChanged: () => void;
}) {
  const lookup = useContactLookup(conversationId);
  const [kind, setKind] = useState<'email' | 'phone'>('email');
  const [value, setValue] = useState('');
  const [confirming, setConfirming] = useState(false);

  if (!canLookUp) return null;

  if (identified) {
    return (
      <div data-testid="identity-panel">
        {!confirming ? (
          <button
            type="button"
            data-testid="detach-start"
            className="text-xs text-primary hover:underline"
            onClick={() => {
              setConfirming(true);
              void lookup.previewDetach();
            }}
          >
            Detach this player
          </button>
        ) : (
          <div className="space-y-2 rounded-md border border-border p-2" data-testid="detach-confirm">
            {/* ⚠️ 0044 §5's hazard, said plainly BEFORE the act: nothing written is taken back. */}
            <p className="text-xs text-muted-foreground">
              Detaching leaves everything written while this player was attached on their record:{' '}
              <strong data-testid="detach-counts">
                {lookup.warning ? `${lookup.warning.publicReplies} replies, ${lookup.warning.privateNotes} notes` : '…'}
              </strong>
              .
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                data-testid="detach-confirm-button"
                onClick={async () => {
                  if (await lookup.detach()) {
                    setConfirming(false);
                    onChanged();
                  }
                }}
              >
                Detach
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {lookup.state.status === 'error' && (
          <p className="mt-1 text-xs text-destructive" data-testid="identity-error">
            {lookup.state.message}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="identity-panel">
      <div className="flex gap-1">
        {(['email', 'phone'] as const).map((k) => (
          <button
            key={k}
            type="button"
            data-testid={`lookup-kind-${k}`}
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
            className={`rounded px-2 py-0.5 text-xs ${kind === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
          >
            {k}
          </button>
        ))}
      </div>
      <Input
        data-testid="lookup-value"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void lookup.search(kind, value);
        }}
        placeholder={kind === 'email' ? 'name@example.com' : '+380…'}
        className="h-8 text-sm"
      />
      <Button
        size="sm"
        variant="outline"
        data-testid="lookup-search"
        disabled={lookup.state.status === 'searching' || value.trim() === ''}
        onClick={() => void lookup.search(kind, value)}
      >
        {lookup.state.status === 'searching' ? 'Searching…' : 'Find player'}
      </Button>

      {lookup.state.status === 'error' && (
        <p className="text-xs text-destructive" data-testid="identity-error">
          {lookup.state.message}
        </p>
      )}
      {lookup.state.status === 'answered' && (
        <div className="rounded-md border border-border p-2 text-xs" data-testid="lookup-result">
          {lookup.state.result.matched ? (
            <>
              {/* Just enough to confirm: the id the attach will use, and nothing about the person. */}
              <p className="mb-2">
                Match: <span className="font-mono">{lookup.state.result.playerId}</span>
              </p>
              <Button
                size="sm"
                data-testid="lookup-attach"
                onClick={async () => {
                  if (await lookup.attach(lookup.state.status === 'answered' ? lookup.state.result.playerId : '')) {
                    setValue('');
                    onChanged();
                  }
                }}
              >
                Attach to this ticket
              </Button>
            </>
          ) : lookup.state.result.ambiguous ? (
            // Two records share this contact — the screen says so and names NOBODY (0044 §4).
            <p className="text-muted-foreground">
              More than one record shares this contact. Resolve it with a supervisor — this screen will not
              choose for you.
            </p>
          ) : (
            <p className="text-muted-foreground">No player with this contact in this brand.</p>
          )}
        </div>
      )}
    </div>
  );
}
