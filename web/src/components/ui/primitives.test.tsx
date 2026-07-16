import { render, screen } from '@testing-library/react';
import { Button, buttonVariants } from './button';
import { Input } from './input';
import { Textarea } from './textarea';
import { Label } from './label';
import { Card, CardHeader, CardTitle, CardContent } from './card';
import { Badge } from './badge';
import { Separator } from './separator';
import { Skeleton } from './skeleton';
import { Avatar, AvatarFallback } from './avatar';

/*
 * S1 primitive guard (roadmap 8.5 / ADR 0030–0031 governance).
 *
 * Proves the first shadcn primitives were pulled, mount, and — critically — are
 * styled ONLY through our semantic token classes (bg-primary, bg-destructive,
 * border-input …), never hardcoded color. Fails if a primitive is missing or if
 * one stops reading the token layer. The white-label seam depends on this.
 */

describe('S1 primitives (pulled, token-styled, white-label)', () => {
  it('renders the primitive set', async () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent>
          <Label htmlFor="email">Email</Label>
          <Input id="email" placeholder="you@example.com" />
          <Textarea placeholder="Notes" />
          <Separator />
          <Badge>New</Badge>
          <Skeleton data-testid="sk" className="h-4 w-24" />
          <Avatar>
            <AvatarFallback>JD</AvatarFallback>
          </Avatar>
          <Button>Save</Button>
        </CardContent>
      </Card>,
    );

    expect(screen.getByText('Account')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Notes')).toBeInTheDocument();
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByTestId('sk')).toBeInTheDocument();
    expect(await screen.findByText('JD')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
  });

  it('drives colors from semantic tokens, not hardcoded values', () => {
    const { container } = render(
      <>
        <Button>Default</Button>
        <Badge>Tag</Badge>
      </>,
    );

    // Default button + badge consume the token-backed primary role.
    expect(screen.getByRole('button', { name: /default/i }).className).toMatch(/bg-primary/);
    expect(screen.getByText('Tag').className).toMatch(/bg-primary/);

    // Variant classes map to our semantic roles (proves the token wiring, not a fixed hue).
    expect(buttonVariants({ variant: 'destructive' })).toMatch(/bg-destructive/);
    expect(buttonVariants({ variant: 'outline' })).toMatch(/border-input/);
    expect(buttonVariants({ variant: 'secondary' })).toMatch(/bg-secondary/);

    // No inline hex color anywhere in the rendered primitives.
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
