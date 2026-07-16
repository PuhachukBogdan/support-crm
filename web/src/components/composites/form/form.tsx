'use client';

import { type ReactNode } from 'react';
import {
  FormProvider,
  useForm,
  type DefaultValues,
  type UseFormReturn,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ZodType, infer as zInfer } from 'zod';
import { cn } from '@/lib/utils';

export type AppFormProps<S extends ZodType> = {
  schema: S;
  defaultValues?: DefaultValues<zInfer<S>>;
  onSubmit: (values: zInfer<S>) => void | Promise<void>;
  children: ReactNode | ((form: UseFormReturn<zInfer<S>>) => ReactNode);
  className?: string;
};

/**
 * Shared Form composite (S2): react-hook-form + zod validation over the shadcn Form
 * primitives. Consistent field/error rendering; yields typed values on valid submit.
 * Compose fields inside via FormField/FormItem/FormControl/FormMessage (re-exported below).
 */
export function AppForm<S extends ZodType>({
  schema,
  defaultValues,
  onSubmit,
  children,
  className,
}: AppFormProps<S>) {
  // zod 3.25 ships v4 core types that skew against @hookform/resolvers' expected ZodType;
  // the cast keeps runtime correct while sidestepping the version-skew type mismatch.
  const form = useForm<zInfer<S>>({ resolver: zodResolver(schema as never), defaultValues });
  return (
    <FormProvider {...form}>
      <form
        noValidate
        className={cn('space-y-4', className)}
        onSubmit={form.handleSubmit(onSubmit)}
      >
        {typeof children === 'function' ? children(form) : children}
      </form>
    </FormProvider>
  );
}
