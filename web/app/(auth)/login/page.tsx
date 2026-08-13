'use client';

import { useEffect, useState, type ComponentType } from 'react';
import { useRouter } from 'next/navigation';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { normalizeOtpCode } from '@/lib/otp-code';
import { useSession } from '@/session';

// React Bits Ferrofluid is untyped JS; loosen its props (all optional) for our TS page.
const Ferrofluid = FerrofluidImpl as unknown as ComponentType<Record<string, unknown>>;

/**
 * Sign-in (feature 027, roadmap 8.6). Two steps: credentials, then the emailed code.
 *
 * ⚠️ **THE VISUAL LAYER OF THIS PAGE IS FROZEN BY OPERATOR INSTRUCTION** (FR-023). The Ferrofluid
 * block below, the dark backdrop, the radial-mask blur layer, the card's entrance animation classes
 * and the neutral wordmark are pinned value-by-value in `frozen-visual.test.tsx`. Behaviour may
 * change; those thirteen prop values may not. If that test fails, the fix is the code, not the test.
 *
 * ── What this page is NOT ───────────────────────────────────────────────────────────────────────
 * It is not authentication. Every credential decision is the gateway's; this page collects input,
 * shows what the boundary answered, and never learns a status code (Principle II).
 *
 * ⚠️ There is **no self-registration** in this product, and this is not a registration screen. The
 * only way in is an invitation, which lands on `/register`. Roadmap 3.10 is titled "Registration
 * page" and means *invite acceptance* — a reader who takes the other reading builds a working
 * public sign-up form and nothing stops them.
 */

const credentialsSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});

const codeSchema = z.object({
  code: z.string().min(1, 'Enter the code we sent you'),
});

/** Fixed copy. Never interpolated with anything a person typed (FR-015). */
const MESSAGES = {
  rejected: 'Those details were not accepted.',
  locked: 'This account is locked. Ask an administrator to unlock it.',
  unreachable: 'We could not reach the service. Please try again.',
  badCode: 'That code is not right.',
  expiredCode: 'That code has expired. Start again to get a new one.',
} as const;

interface Challenge {
  challengeId: string;
  /** ⚠️ UNIX **seconds** (`otp.service.ts`), not milliseconds. Compared as seconds, below. */
  codeExpiresAt: number;
}

export default function LoginPage() {
  const router = useRouter();
  const { state, session, refresh } = useSession();
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [rememberMe, setRememberMe] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // FR-004 — a signed-in session has no business sitting on the sign-in screen, however it got
  // here (Back button, a stale tab, a bookmark). `replace`, so Back does not return to it either.
  useEffect(() => {
    if (state.kind === 'authenticated') router.replace('/');
  }, [state.kind, router]);

  async function onCredentials({ email, password }: z.infer<typeof credentialsSchema>) {
    setMessage(null);
    const outcome = await session.signIn(email, password);
    switch (outcome.kind) {
      case 'code_sent':
        setChallenge({ challengeId: outcome.challengeId, codeExpiresAt: outcome.codeExpiresAt });
        return;
      case 'rejected':
        setMessage(MESSAGES.rejected);
        return;
      case 'locked':
        setMessage(MESSAGES.locked);
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

  async function onCode({ code }: z.infer<typeof codeSchema>) {
    if (!challenge) return;
    setMessage(null);
    const outcome = await session.submitCode(
      challenge.challengeId,
      normalizeOtpCode(code),
      rememberMe,
    );
    switch (outcome.kind) {
      case 'ok':
        await refresh();
        router.replace('/');
        return;
      case 'bad_code':
        // ⭐ FR-012. The server answers `invalid_code` for wrong, expired, consumed and exhausted
        // alike — deliberately, and this feature does not ask it to change. The one distinction we
        // can make honestly is from the expiry step 1 already gave us, against our own clock.
        setMessage(hasExpired(challenge) ? MESSAGES.expiredCode : MESSAGES.badCode);
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

  /** Both sides in SECONDS. Mixing the units here is how this distinction becomes always or never. */
  function hasExpired({ codeExpiresAt }: Challenge): boolean {
    return Math.floor(Date.now() / 1000) > codeExpiresAt;
  }

  function backToCredentials() {
    // The challenge is discarded rather than kept for later: it is not a credential and must not
    // survive as one (data-model §2).
    setChallenge(null);
    setRememberMe(false);
    setMessage(null);
  }

  return (
    <>
      {/* Decorative WebGL background (React Bits Ferrofluid). Dark backdrop (token-driven) so
          the white fluid shows. */}
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

      {/* Soft radial gaussian blur around the sign-in card so the fluid near the form is
          gently softened (focus on the card). Light blur, fades out radially. */}
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
          <CardTitle className="text-2xl">Welcome back</CardTitle>
          <CardDescription>
            {challenge ? 'We sent a code to your email address.' : 'Sign in to continue.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {message && (
            <p role="alert" className="mb-4 text-sm text-destructive">
              {message}
            </p>
          )}

          {challenge ? (
            <AppForm schema={codeSchema} defaultValues={{ code: '' }} onSubmit={onCode}>
              {(form) => (
                <>
                  <FormField
                    control={form.control}
                    name="code"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Code</FormLabel>
                        <FormControl>
                          {/* ⚠️ NOT `inputMode="numeric"`. The code is upper-case LETTERS AND
                              DIGITS, so a numeric keypad leaves a phone unable to type it at all —
                              shipped that way on 2026-08-02 and found on the first real sign-in. */}
                          <Input
                            inputMode="text"
                            autoCapitalize="characters"
                            autoCorrect="off"
                            spellCheck={false}
                            autoComplete="one-time-code"
                            autoFocus
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* ⚠️ "Remember me" sits on THIS step because the API takes it on `verify`, not on
                      `login` — a control placed where it is not applied is a promise nobody keeps. */}
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="rememberMe"
                      checked={rememberMe}
                      onCheckedChange={(v) => setRememberMe(v === true)}
                    />
                    <Label htmlFor="rememberMe" className="text-sm font-normal">
                      Remember me
                    </Label>
                  </div>

                  <Button type="submit" className="w-full">
                    Sign in
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    onClick={backToCredentials}
                  >
                    Use a different account
                  </Button>
                </>
              )}
            </AppForm>
          ) : (
            <AppForm
              schema={credentialsSchema}
              defaultValues={{ email: '', password: '' }}
              onSubmit={onCredentials}
            >
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
                  <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Password</FormLabel>
                        <FormControl>
                          <Input type="password" autoComplete="current-password" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" className="w-full">
                    Continue
                  </Button>
                  {/*
                    ⭐ W36 / 041 — the way to recovery, and the ONLY visual change this protected screen
                    takes.
                    ⚠️⚠️ **IN THE CREDENTIALS BRANCH, and the first version was NOT.** It sat in the CODE
                    step, so somebody who cannot sign in — the only person who needs it — never saw it. That
                    is precisely how 8.6 shipped an invitation email with no link in it: the mechanism
                    existed and nothing led to it. Caught by the live run, which is the only place this kind
                    of mistake is visible at all.
                    ⚠️ A text link, not a Button, so the frozen visual (FR-023) keeps its button count.
                  */}
                  <p className="text-center text-sm">
                    <a
                      href="/recover"
                      data-testid="login-forgot-password"
                      className="text-muted-foreground underline-offset-4 hover:underline"
                    >
                      Forgotten your password?
                    </a>
                  </p>
                </>
              )}
            </AppForm>
          )}
        </CardContent>
      </Card>
    </>
  );
}
