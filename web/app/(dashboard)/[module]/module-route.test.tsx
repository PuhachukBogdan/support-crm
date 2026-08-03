import { render, screen } from '@testing-library/react';
import ModulePage from './page';

/**
 * The half of roadmap 9.1's *Done when* that shipped untested — and therefore unbuilt.
 *
 * The point promises that a hidden module has **no link AND no route**, and FR-021 promises that a
 * "coming soon" module renders **a static screen**. Feature 029 asserted the resolver
 * (`module-states.test.tsx`) and the links (`shell.test.tsx`) and stopped there, so both routes kept
 * answering: `/telephony` — the slot the operator asked us to hide — served a page to anyone typing
 * the URL, and `/knowledge` served a generic placeholder that reads as an unfinished screen.
 *
 * ⚠️ **Found by the operator clicking the link, not by the suite.** The lesson is the same one this
 * feature kept re-learning one level down: a rule can be correct and have no consumer exercising it.
 * These tests assert what a PERSON REACHING THE URL gets.
 */
jest.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

async function renderModule(module: string) {
  const ui = await ModulePage({ params: Promise.resolve({ module }) });
  return render(ui);
}

describe('*** a hidden module has NO ROUTE, not just no link ***', () => {
  it('⭐ /telephony is not found — the reserved slot is unreachable by URL', async () => {
    await expect(renderModule('telephony')).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('an unknown module is the same answer — existence is not disclosed', async () => {
    // Distinguishing "switched off" from "never existed" would tell a prober which modules exist.
    await expect(renderModule('no-such-module')).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('*** a coming-soon module renders a static screen that reads as RESERVED ***', () => {
  it('⭐ /knowledge says it is reserved, not that something is missing or broken', async () => {
    await renderModule('knowledge');
    expect(screen.getByTestId('module-coming-soon')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Knowledge Base' })).toBeInTheDocument();
    expect(screen.getByText(/reserved and not built yet/i)).toBeInTheDocument();
    // ⚠️ The word a person must not see here: the generic placeholder that reads as unfinished work.
    expect(screen.queryByText(/^Placeholder for/i)).not.toBeInTheDocument();
  });

  it('it reassures rather than alarms — nothing suggests a fault or a missing permission', async () => {
    await renderModule('knowledge');
    const text = screen.getByTestId('module-coming-soon').textContent ?? '';
    expect(text).not.toMatch(/error|denied|forbidden|not allowed|failed/i);
  });
});

describe('an active module still renders its placeholder until its real screen lands', () => {
  it('/contacts renders, titled from the catalogue rather than from the URL', async () => {
    await renderModule('contacts');
    // Titled "Contacts" from the catalogue — not "Contacts" capitalised out of the path, which is
    // how "Knowledge" used to appear instead of "Knowledge Base".
    expect(screen.getByRole('heading', { name: 'Contacts' })).toBeInTheDocument();
  });
});
