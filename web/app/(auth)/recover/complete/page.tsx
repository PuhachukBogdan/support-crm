'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { useSession } from '@/session';
import { AuthBackdrop } from '../../auth-backdrop';

/**
 * ⭐ W36 / feature 041 (roadmap 8.11) — the page the emailed link opens.
 *
 * ── What it does, and the one thing it deliberately does NOT do ──────────────────────────────────
 * It sets a password. It does **not** sign anybody in: the block's rule is «двухшаговый вход этим не
 * обходится», so after success the person goes to sign-in with the password they just chose and the code
 * we email then. This overrides roadmap 8.11's «and signs them in» (spec 041 FR-009) — a link that both
 * set a password and handed out a session would make the email a complete authentication factor.
 *
 * ⚠️ **A dead link must say what to do next.** Expired and already-used are different facts from «wrong
 * link», and each one ends with the same actionable sentence rather than a shrug: ask for another.
 */

/** The policy's own vocabulary, in the words a person can act on. Never a generic «invalid». */
const RULE_TEXT: Readonly<Record<string, string>> = {
  min_length: 'at least 8 characters',
  uppercase: 'an upper-case letter',
  digit: 'a digit',
  symbol: 'a symbol',
};

type Outcome = 'idle' | 'saving' | 'ok' | 'gone' | 'bad' | 'weak' | 'not_eligible' | 'failed';

export default function CompleteRecoveryPage() {
  // The session boundary owns the transport; this page never sees a status code.
  const { session } = useSession();
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [state, setState] = useState<Outcome>('idle');
  const [failures, setFailures] = useState<string[]>([]);
  const [revoked, setRevoked] = useState(0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || state === 'saving') return;
    setState('saving');
    setFailures([]);
    const outcome = await session.completeRecovery(token, password);
    if (outcome.kind === 'ok') {
      setRevoked(outcome.revokedCount);
      return setState('ok');
    }
    if (outcome.kind === 'gone') return setState('gone');
    if (outcome.kind === 'weak_password') {
      setFailures(outcome.failures);
      return setState('weak');
    }
    if (outcome.kind === 'not_eligible') return setState('not_eligible');
    if (outcome.kind === 'rejected') return setState('bad');
    setState('failed');
  };

  const dead = state === 'gone' || state === 'bad' || state === 'not_eligible' || !token;

  return (
    <>
      <AuthBackdrop />
      <Card className="relative z-10 w-full max-w-sm shadow-lg animate-in fade-in-50 zoom-in-95 duration-300">
        <CardHeader className="space-y-2 text-center">
          <CardTitle className="text-2xl">Set a new password</CardTitle>
          {!dead && state !== 'ok' && (
            <CardDescription>
              Choose a password with {Object.values(RULE_TEXT).join(', ')}.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {state === 'ok' ? (
            <div className="space-y-4" data-testid="recovery-complete-ok">
              <p className="text-sm">Your password is set.</p>
              {/*
                ⚠️ The bound, stated rather than glossed: the renewable sessions are gone. An access token
                already in a browser lives out its ~15 minutes, and saying «signed out everywhere» without
                that would be a promise the product does not keep.
              */}
              <p className="text-xs text-muted-foreground">
                {revoked > 0
                  ? `${revoked} signed-in session${revoked === 1 ? '' : 's'} ended. `
                  : ''}
                Sign in with the new password — we will email you a code, as always.
              </p>
              <Button asChild className="w-full" data-testid="recovery-to-login">
                <Link href="/login">Go to sign in</Link>
              </Button>
            </div>
          ) : dead ? (
            <div className="space-y-4" data-testid="recovery-link-dead">
              <Alert role="alert">
                <AlertTitle>
                  {state === 'gone'
                    ? 'This link has already been used or has expired'
                    : state === 'not_eligible'
                      ? 'This link cannot set a password'
                      : 'This link is not valid'}
                </AlertTitle>
                <AlertDescription>
                  {/* Every dead-link state ends in the SAME actionable sentence. */}
                  Ask for a new one — links work once and expire shortly after they are sent.
                </AlertDescription>
              </Alert>
              <Button asChild className="w-full" data-testid="recovery-ask-again">
                <Link href="/recover">Ask for a new link</Link>
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="password">New password</Label>
                <Input
                  id="password"
                  data-testid="recovery-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={state === 'saving'}
                  required
                />
              </div>

              {state === 'weak' && (
                <p role="alert" className="text-sm text-destructive" data-testid="recovery-weak">
                  {/* The policy's OWN failures, in words. A generic «invalid» would leave somebody
                      guessing which rule they missed. */}
                  Add {failures.map((f) => RULE_TEXT[f] ?? f).join(', ')}.
                </p>
              )}
              {state === 'failed' && (
                <p role="alert" className="text-sm text-destructive" data-testid="recovery-complete-failed">
                  The password could not be saved. Check your connection and try again.
                </p>
              )}

              <p className="text-xs text-muted-foreground">
                Setting it signs you out everywhere, so you will sign in again afterwards.
              </p>

              <Button
                type="submit"
                className="w-full"
                data-testid="recovery-complete-submit"
                disabled={state === 'saving' || password === ''}
              >
                {state === 'saving' && <Spinner className="mr-2 h-4 w-4" aria-hidden />}
                {state === 'saving' ? 'Saving…' : 'Set password'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </>
  );
}
