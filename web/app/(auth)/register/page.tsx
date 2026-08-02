'use client';

import { useEffect, useState, type ComponentType } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { z } from 'zod';
import FerrofluidImpl from '@/components/Ferrofluid';
import {
  AppForm,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from '@/components/composites/form';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { normalizeOtpCode } from '@/lib/otp-code';
import { useSession } from '@/session';

const Ferrofluid = FerrofluidImpl as unknown as ComponentType<Record<string, unknown>>;

/**
 * Invite acceptance (feature 027, roadmap 8.6 — the other half of the way in).
 *
 * ⚠️ **This is not a sign-up page.** There is no self-registration in this product and there must
 * not be: the only route to an account is an invitation issued by somebody who already has one.
 * Roadmap 3.10 is titled "Registration page" and means exactly this screen.
 *
 * ── Two rules that look like details and are not ────────────────────────────────────────────────
 * 1. **The address is typed, never pre-filled from the token.** The server checks that the two
 *    match; filling it in makes that check theatre, since everybody would match by construction.
 * 2. **The token never re-enters a URL** — not a history entry, not a redirect, not a log line
 *    (FR-015). It arrives in the query, is read once, and travels onward only in a request body.
 */

const addressSchema = z.object({
  email: z.string().email('Enter a valid email'),
});

/**
 * A MIRROR of the auth service's default policy (`services/auth/src/auth/password-policy.ts`:
 * min 6, uppercase, digit, symbol — all four on by default), not a replacement for it.
 *
 * ⚠️ The policy is **config-driven and not exposed anywhere**: no gateway route and no proto field
 * carries it, so this text is the default and would drift from a deployment that configured
 * something stricter. Recorded rather than hidden — the server still decides, and the failure
 * message deliberately names no rule (see below).
 */
const passwordSchema = z.object({
  code: z.string().min(1, 'Enter the code we sent you'),
  password: z
    .string()
    .min(6, 'Use at least 6 characters')
    .regex(/[A-Z]/, 'Include an uppercase letter')
    .regex(/[0-9]/, 'Include a digit')
    .regex(/[^A-Za-z0-9]/, 'Include a symbol'),
});

const MESSAGES = {
  noToken: 'Open this page from the invitation link you were emailed.',
  rejected: 'That invitation could not be used.',
  unreachable: 'We could not reach the service. Please try again.',
  /**
   * ⚠️ Names no rule, on purpose. The gateway answers `{status:'weak_password'}` and nothing more —
   * Auth's `failures` list is discarded at the edge (`registration.controller.ts`). Guessing which
   * rule failed would send the person to fix something that was never wrong.
   */
  weakPassword: 'That password does not meet the policy requirements shown above.',
} as const;

export default function RegisterPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { state, session, refresh } = useSession();
  const token = params.get('token');
  const [email, setEmail] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (state.kind === 'authenticated') router.replace('/');
  }, [state.kind, router]);

  async function onAddress(values: z.infer<typeof addressSchema>) {
    if (!token) return;
    setMessage(null);
    const outcome = await session.startInvite(token, values.email);
    switch (outcome.kind) {
      case 'code_sent':
        setEmail(values.email);
        return;
      case 'rejected':
        setMessage(MESSAGES.rejected);
        return;
      case 'unreachable':
        setMessage(MESSAGES.unreachable);
        return;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  }

  async function onComplete(values: z.infer<typeof passwordSchema>) {
    if (!token || !email) return;
    setMessage(null);
    const outcome = await session.completeInvite(
      token,
      email,
      normalizeOtpCode(values.code),
      values.password,
    );
    switch (outcome.kind) {
      case 'ok':
        await refresh();
        router.replace('/');
        return;
      case 'weak_password':
        // The form is NOT reset: losing the code here costs a second email and another chance for
        // the challenge to expire, for a mistake that was only in the password field.
        setMessage(MESSAGES.weakPassword);
        return;
      case 'rejected':
        setMessage(MESSAGES.rejected);
        return;
      case 'unreachable':
        setMessage(MESSAGES.unreachable);
        return;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  }

  return (
    <>
      {/* The same decorative background as the sign-in screen, so the two halves of "the way in"
          look like one product. Frozen there (FR-023); mirrored here. */}
      <div aria-hidden className="dark fixed inset-0 z-0 bg-background">
        <Ferrofluid
          colors={['#ffffff', '#ffffff', '#ffffff']}
          speed={0.5}
          scale={1.6}
          turbulence={1}
          fluidity={0.1}
          rimWidth={0.2}
          sharpness={2.5}
          shimmer={1.5}
          glow={2}
          flowDirection="down"
          opacity={1}
          mouseInteraction
          mouseStrength={1}
          mouseRadius={0.35}
        />
      </div>

      <div
        aria-hidden
        className="pointer-events-none fixed left-1/2 top-1/2 z-[1] h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full backdrop-blur-[8px]"
        style={{
          WebkitMaskImage: 'radial-gradient(closest-side, black 55%, transparent 100%)',
          maskImage: 'radial-gradient(closest-side, black 55%, transparent 100%)',
        }}
      />

      <Card className="relative z-10 w-full max-w-sm shadow-lg animate-in fade-in-50 zoom-in-95 duration-300">
        <CardHeader className="space-y-2 text-center">
          {/* Neutral placeholder wordmark — no brand identity committed (0028). */}
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground text-lg font-semibold">
            C
          </div>
          <CardTitle className="text-2xl">Accept your invitation</CardTitle>
          <CardDescription>
            {email
              ? 'We sent a code to that address. Enter it and choose a password.'
              : 'Confirm the address your invitation was sent to.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(message || !token) && (
            <p role="alert" className="mb-4 text-sm text-destructive">
              {message ?? MESSAGES.noToken}
            </p>
          )}

          {/* ⚠️ No token ⇒ no field and no request. The page has nothing to offer and says so. */}
          {token && !email && (
            <AppForm schema={addressSchema} defaultValues={{ email: '' }} onSubmit={onAddress}>
              {(form) => (
                <>
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input
                            type="email"
                            placeholder="you@example.com"
                            autoComplete="email"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" className="w-full">
                    Continue
                  </Button>
                </>
              )}
            </AppForm>
          )}

          {token && email && (
            <AppForm
              schema={passwordSchema}
              defaultValues={{ code: '', password: '' }}
              onSubmit={onComplete}
            >
              {(form) => (
                <>
                  <FormField
                    control={form.control}
                    name="code"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Code</FormLabel>
                        <FormControl>
                          {/* Letters AND digits — see the sign-in page's note on `inputMode`. */}
                          <Input
                            inputMode="text"
                            autoCapitalize="characters"
                            autoCorrect="off"
                            spellCheck={false}
                            autoComplete="one-time-code"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* FR-008 — the rules come BEFORE the field. A rule shown after a rejection is a
                      guessing game the person has already lost once. */}
                  <p
                    data-testid="password-policy"
                    className="rounded-md bg-muted p-3 text-sm text-muted-foreground"
                  >
                    Your password needs at least 6 characters, an uppercase letter, a digit and a
                    symbol.
                  </p>

                  <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Password</FormLabel>
                        <FormControl>
                          <Input type="password" autoComplete="new-password" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <Button type="submit" className="w-full">
                    Finish
                  </Button>
                </>
              )}
            </AppForm>
          )}
        </CardContent>
      </Card>
    </>
  );
}
