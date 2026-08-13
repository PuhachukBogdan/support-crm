import { render, screen } from '@testing-library/react';
import AdminCenterPage from '../../../app/(dashboard)/admin/page';
import { ADMIN_SECTIONS } from './admin-sections';
import { MODULE_CATALOGUE } from './nav-items';

/**
 * W13 (subpoints 3.7 + 3.13) — every promised surface has a labelled place, and every placeholder
 * ADMITS what it is.
 *
 * The failure this guards against is specific and this project has shipped it once: a screen that
 * looks unfinished rather than reserved, which reads as "broken" to the person opening it (the
 * operator clicked Knowledge Base and found exactly that).
 */

describe('the rail carries a slot for every top-level surface', () => {
  const keys = MODULE_CATALOGUE.map((m) => m.key);

  it('⭐ 3.13: Escalations and Workforce have reserved entries', () => {
    // Both were approved by the operator and neither exists yet — «оставляем, только UX поправить»
    // for WFM, and the Notion register for escalations.
    expect(keys).toContain('escalations');
    expect(keys).toContain('workforce');
    for (const key of ['escalations', 'workforce']) {
      expect(MODULE_CATALOGUE.find((m) => m.key === key)?.state).toBe('coming_soon');
    }
  });

  it('⛔ and 3.13’s other surfaces are NOT on the rail — they are sections of the admin centre', () => {
    // Putting five more entries on the rail would answer the operator's own complaint («если их
    // больше четырёх, надо скроллить») with the thing he complained about.
    for (const key of ['macros', 'automations', 'retention', 'access', 'statuses']) {
      expect(keys).not.toContain(key);
    }
  });

  it('the three states are all in use — the mechanism is not theoretical', () => {
    const states = new Set(MODULE_CATALOGUE.map((m) => m.state));
    expect(states).toContain('active');
    expect(states).toContain('coming_soon');
    expect(states).toContain('hidden');
  });
});

describe('the admin centre says what it will hold', () => {
  it('renders every reserved section, each labelled and each owned by a point', () => {
    render(<AdminCenterPage />);
    for (const s of ADMIN_SECTIONS) {
      const el = screen.getByTestId(`admin-section-${s.key}`);
      expect(el).toHaveTextContent(s.label);
      // ⭐ The owning point is the promise: a slot with no owner is how a screen stays reserved
      // for ever.
      expect(el).toHaveTextContent(`point ${s.point}`);
    }
  });

  /**
   * ⭐ SHARPENED in W14, not relaxed. The rule was "nothing here is clickable", which held while
   * every section was a promise. Now that People & groups EXISTS, the rule it was standing for is
   * the precise one: **a RESERVED section must not look clickable, and a real one must**. Anything
   * else makes a placeholder indistinguishable from a working control — in either direction.
   */
  it('⛔ a reserved section is plain text; a built one is a link', () => {
    const { container } = render(<AdminCenterPage />);
    const built = ADMIN_SECTIONS.filter((s) => s.href);
    const reserved = ADMIN_SECTIONS.filter((s) => !s.href);
    expect(built.length).toBeGreaterThan(0);
    expect(reserved.length).toBeGreaterThan(0);

    // Exactly as many links as there are built sections — no reserved one sneaks in.
    expect(container.querySelectorAll('a')).toHaveLength(built.length);
    for (const s of built) {
      expect(screen.getByRole('link', { name: s.label })).toHaveAttribute('href', s.href!);
    }
    for (const s of reserved) {
      expect(screen.queryByRole('link', { name: s.label })).toBeNull();
    }
    // And no buttons at all: a reserved slot that looks pressable is a control that does nothing.
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('every section names a roadmap point, so none is reserved anonymously', () => {
    for (const s of ADMIN_SECTIONS) {
      expect(s.point.trim().length).toBeGreaterThan(0);
      expect(s.summary.trim().length).toBeGreaterThan(10);
    }
  });
});
