import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { Providers } from './providers';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { GatewayDataAccess } from '@/data/gateway/gateway-data-access';
import { MockDataAccess } from '@/data/mock/mock-data-access';

/**
 * ⭐⭐ **The application binds the REAL transport.** Found live on 2026-08-02, after the Inbox shipped.
 *
 * ── What went wrong ─────────────────────────────────────────────────────────────────────────────
 * `getDataAccess()` defaults to `MockDataAccess`, and nothing in the application ever replaced it.
 * `GatewayDataAccess` existed, was thoroughly tested against recorded responses, and was constructed
 * **only in tests**. The shipped Inbox therefore asked the demo store for conversations.
 *
 * ── Why the whole suite was green anyway ────────────────────────────────────────────────────────
 * `swap-point.test.ts` proves the swap MECHANISM: call `setDataAccess`, the accessor returns the new
 * one. True, and it never asked whether the app calls it. The screen tests inject their own stub, so
 * they cannot see the default either. The live script talks to the gateway directly with `curl`, so
 * it cannot see the browser. Three honest checks, and the wire between them was nobody's.
 *
 * ⇒ This file is deliberately about the DEFAULT the app boots with — the one thing no other test
 * could observe.
 */
describe('*** the app binds the gateway transport, not the demo store ***', () => {
  afterEach(() => setDataAccess(new MockDataAccess()));

  it('⭐ rendering Providers publishes a GatewayDataAccess to the saga accessor', () => {
    // The sagas read `getDataAccess()` from outside React, so this accessor is what actually decides
    // where a list request goes.
    setDataAccess(new MockDataAccess());
    expect(getDataAccess()).toBeInstanceOf(MockDataAccess);

    render(
      <Providers>
        <div>x</div>
      </Providers>,
    );

    expect(getDataAccess()).toBeInstanceOf(GatewayDataAccess);
  });

  it('the binding is not the demo store under another name', () => {
    render(
      <Providers>
        <div>x</div>
      </Providers>,
    );
    expect(getDataAccess()).not.toBeInstanceOf(MockDataAccess);
  });

  it('⚠️ the mock is not referenced by the app shell at all — it is a dev fixture', () => {
    // A screen importing the mock directly would route around the swap point entirely, which is the
    // same defect wearing a different shape.
    const providers = readFileSync(join(__dirname, 'providers.tsx'), 'utf8');
    expect(providers).toContain('GatewayDataAccess');
    expect(providers).not.toMatch(/new MockDataAccess/);
  });
});
