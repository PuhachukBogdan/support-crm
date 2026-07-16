import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { z } from 'zod';
import { AppForm, FormField, FormItem, FormLabel, FormControl, FormMessage } from './index';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

// T023 [US4] — Form: invalid submit blocked with per-field errors; valid submit yields typed values.

const schema = z.object({ email: z.string().email('Invalid email') });

function SampleForm({ onSubmit }: { onSubmit: (v: { email: string }) => void }) {
  return (
    <AppForm schema={schema} defaultValues={{ email: '' }} onSubmit={onSubmit}>
      {(form) => (
        <>
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input placeholder="email" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit">Save</Button>
        </>
      )}
    </AppForm>
  );
}

describe('AppForm', () => {
  it('blocks an invalid submit and shows a per-field error', async () => {
    const onSubmit = jest.fn();
    render(<SampleForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByPlaceholderText('email'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText('Invalid email')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits typed values when valid', async () => {
    const onSubmit = jest.fn();
    render(<SampleForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByPlaceholderText('email'), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({ email: 'a@b.com' }, expect.anything());
  });
});
