'use client';

import type { ComponentType } from 'react';
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
import { useSession } from '@/session';

// React Bits Ferrofluid is untyped JS; loosen its props (all optional) for our TS page.
const Ferrofluid = FerrofluidImpl as unknown as ComponentType<Record<string, unknown>>;

// Demo mock login (D1). Access is invite-only in the real product (no self-registration) —
// here any well-formed email enters, with NO auth/network call. Real Auth = Phase 3 / 8.6.
const schema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});

export default function LoginPage() {
  const router = useRouter();
  const { login } = useSession();

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
          <CardDescription>Sign in to continue — demo, any credentials work.</CardDescription>
        </CardHeader>
        <CardContent>
          <AppForm
            schema={schema}
            defaultValues={{ email: '', password: '' }}
            onSubmit={() => {
              login();
              router.push('/');
            }}
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
                        <Input type="email" placeholder="you@example.com" autoComplete="email" {...field} />
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
              </>
            )}
          </AppForm>
        </CardContent>
      </Card>
    </>
  );
}
