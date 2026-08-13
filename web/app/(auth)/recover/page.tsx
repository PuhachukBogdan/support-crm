'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { useSession } from '@/session';
import { AuthBackdrop } from '../auth-backdrop';

/**
 * ⭐ W36 / feature 041 (roadmap 8.11) — ask for a recovery link.
 *
 * ── The whole screen exists to say ONE thing ──────────────────────────────────────────────────────
 * *«If that address belongs to an account, a link is on its way.»* The same sentence whether the address
 * exists or not — a form that answers differently is a directory of who works here, and this page is on
 * the public internet. So there is deliberately **one success state and no error state for the address**:
 * an unknown address is not a failure here, it is the same outcome.
 *
 * ⚠️ The only failure this page can show is the request not completing at all (offline, 500). It says so
 * in those words, because «something went wrong» beside an address field reads as «that address is
 * wrong», which is exactly the disclosure the endpoint refuses to make.
 *
 * ⓘ It does not validate the address shape either, for the same reason the edge does not: refusing «not
 * an email» would answer differently for a malformed address than for an unregistered one.
 */
export default function RecoverPage() {
  // ⚠️ The SESSION boundary, not `fetch`: a screen never learns a URL or a status code (Principle II),
  // and `no-direct-network.test.ts` fails the build on a raw call. It also means the day a status
  // changes, one file changes.
  const { session } = useSession();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || state === 'sending') return;
    setState('sending');
    // `accepted` is the only success the vocabulary HAS — there is no rejection to render, which is the
    // anti-enumeration property expressed as a type rather than as discipline.
    const outcome = await session.requestRecovery(email);
    setState(outcome.kind === 'accepted' ? 'sent' : 'failed');
  };

  return (
    <>
      <AuthBackdrop />
      <Card className="relative z-10 w-full max-w-sm shadow-lg animate-in fade-in-50 zoom-in-95 duration-300">
        <CardHeader className="space-y-2 text-center">
          <CardTitle className="text-2xl">Forgotten password</CardTitle>
          <CardDescription>
            We will email a link that lets you set a new one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state === 'sent' ? (
            <div className="space-y-4" data-testid="recovery-sent">
              {/*
                ⚠️ THE FIXED SENTENCE. It must not name the address back, must not say «found», and must
                read the same for a stranger probing the form as for the person who owns the account.
              */}
              <p className="text-sm">
                If that address belongs to an account, a link is on its way. It works once and expires
                shortly, so open it soon.
              </p>
              <p className="text-xs text-muted-foreground">
                Nothing arrived? Check the address and ask again — or ask an administrator to re-invite
                you.
              </p>
              <Button asChild variant="outline" className="w-full">
                <Link href="/login">Back to sign in</Link>
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="email">Work email</Label>
                <Input
                  id="email"
                  data-testid="recovery-email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={state === 'sending'}
                  required
                />
              </div>

              {state === 'failed' && (
                <p role="alert" className="text-sm text-destructive" data-testid="recovery-failed">
                  {/* ⚠️ About the REQUEST, never about the address. */}
                  The request could not be sent. Check your connection and try again.
                </p>
              )}

              <Button
                type="submit"
                className="w-full"
                data-testid="recovery-submit"
                disabled={state === 'sending' || email.trim() === ''}
              >
                {state === 'sending' && <Spinner className="mr-2 h-4 w-4" aria-hidden />}
                {state === 'sending' ? 'Sending…' : 'Email me a link'}
              </Button>

              <Button asChild variant="ghost" className="w-full">
                <Link href="/login">Back to sign in</Link>
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </>
  );
}
