'use client';

import { useRouter } from 'next/navigation';
import { z } from 'zod';
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

// Demo mock login (D1): any well-formed input enters the app. NO auth/network call — the
// mock session is a labeled non-security placeholder (real Auth = Phase 3 / 8.6).
const schema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});

export default function LoginPage() {
  const router = useRouter();
  const { login } = useSession();

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Demo — any credentials work (mock login, no real auth).</CardDescription>
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
                      <Input type="email" placeholder="you@example.com" {...field} />
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
                      <Input type="password" {...field} />
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
  );
}
