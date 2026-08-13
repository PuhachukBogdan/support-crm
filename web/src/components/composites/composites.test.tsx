import { render, screen, fireEvent } from '@testing-library/react';
import { StatusBadge } from './status-badge/status-badge';
import { ConfirmDialog } from './confirm-dialog/confirm-dialog';
import { ErrorState, EmptyState } from './states';
import { SidePanel } from './side-panel/side-panel';

// T025 [US5] — supporting composites render from the registry, token-driven, no inline color.

describe('supporting composites', () => {
  it('StatusBadge maps status & priority to token-driven variants (no inline color)', () => {
    // ⚠️ `open` is the NEUTRAL foreground token since W6 (R38) — red is reserved. See below.
    const { rerender } = render(<StatusBadge kind="status" value="open" />);
    const openBadge = screen.getByText('open');
    expect(openBadge.className).toMatch(/bg-foreground/);
    expect(openBadge.getAttribute('style') ?? '').not.toMatch(/#|rgb\(/);

    rerender(<StatusBadge kind="priority" value="urgent" />);
    expect(screen.getByText('urgent').className).toMatch(/bg-destructive/);
  });

  /**
   * ⭐ The status palette the operator specified from the real Zendesk (2026-08-03):
   * **Open red · Pending blue · Solved grey · everything else near-black**, in rounded rectangles
   * rather than pills. Before this, every status had its own bright hue and the column read as a
   * rainbow — *«какие-то у нас слишком цветастые, яркие»*.
   */
  describe('*** the status palette carries colour only where it means something ***', () => {
    const toneOf = (value: string) => {
      const { unmount } = render(<StatusBadge kind="status" value={value} />);
      const cls = screen.getByText(value).className;
      unmount();
      return cls;
    };

    it('⭐ open is NEUTRAL and red is FREED (R38, W6) — pending stays blue', () => {
      // R38 (operator, 2026-08-05): «Open moves to the neutral foreground token, and red is freed to
      // mean exactly one thing: a new message from the customer» — the 9.12 unread marker. Until 9.12
      // ships, NO status is red, so the colour cannot spend the interim meaning something else.
      expect(toneOf('open')).toMatch(/bg-foreground/);
      expect(toneOf('open')).not.toMatch(/bg-destructive/);
      expect(toneOf('pending')).toMatch(/bg-info/);
    });

    it('solved/resolved is grey, under either spelling', () => {
      // Our wire says `resolved`; Zendesk says `Solved`. A rename on either side must not fall
      // through to the neutral tone and silently look like an unknown status.
      expect(toneOf('resolved')).toMatch(/bg-muted/);
      expect(toneOf('solved')).toMatch(/bg-muted/);
    });

    it('⭐ every other status — including custom ones — is the neutral near-black', () => {
      // Custom statuses are data (§17) and there will be many. None may be handed a colour nobody
      // chose, and none may be dressed as "solved".
      for (const value of ['snoozed', 'vip pending', 'in progress', 'supervisor review']) {
        expect(toneOf(value)).toMatch(/bg-foreground/);
      }
    });

    it('⚠️ "black" is the FOREGROUND token, so it survives the dark theme', () => {
      // A literal black chip is invisible in dark mode — which Zendesk's screenshots cannot reveal,
      // because they only exist in light. `bg-foreground/text-background` inverts with the theme.
      const cls = toneOf('snoozed');
      expect(cls).toMatch(/bg-foreground/);
      expect(cls).toMatch(/text-background/);
      expect(cls).not.toMatch(/black|#000/);
    });

    it('the badge is a rounded RECTANGLE, not a pill', () => {
      const cls = toneOf('open');
      expect(cls).toMatch(/\brounded\b/);
      expect(cls).not.toMatch(/rounded-full/);
    });

    it('no status tone carries a literal colour — white-label holds (rule 6 / ADR 0028)', () => {
      for (const value of ['open', 'pending', 'resolved', 'snoozed']) {
        expect(toneOf(value)).not.toMatch(/#[0-9a-f]{3,8}|rgb\(|\bred\b|\bblue\b/i);
      }
    });
  });

  it('ConfirmDialog requires an explicit confirm click', () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    render(
      <ConfirmDialog
        open
        title="Delete brand?"
        description="This cannot be undone."
        destructive
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText('Delete brand?')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('ErrorState shows a sanitized message + retry', () => {
    const onRetry = jest.fn();
    render(<ErrorState error={{ message: 'Something went wrong.', retryable: true }} onRetry={onRetry} />);
    expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('EmptyState renders its title', () => {
    render(<EmptyState title="No records" description="Add one to get started" />);
    expect(screen.getByText('No records')).toBeInTheDocument();
  });

  it('SidePanel renders content when open', () => {
    render(
      <SidePanel open title="Details" onClose={() => {}}>
        <p>Panel body</p>
      </SidePanel>,
    );
    expect(screen.getByText('Panel body')).toBeInTheDocument();
    expect(screen.getByText('Details')).toBeInTheDocument();
  });
});
