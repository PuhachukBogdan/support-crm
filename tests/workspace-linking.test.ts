import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICE_NAMES, noop } from '@crm/common';

// US1 (roadmap 0.1): FAILS if a workspace package is missing/misnamed or if the shared
// lib does not resolve across workspaces; PASSES once the monorepo installs as one linked
// unit. This is the Definition-of-Done test for the "one-command install" story.
const repoRoot = join(__dirname, '..');

const EXPECTED_WORKSPACES: ReadonlyArray<{ dir: string; name: string }> = [
  { dir: 'services/gateway', name: '@crm/gateway' },
  { dir: 'services/auth', name: '@crm/auth' },
  { dir: 'services/users', name: '@crm/users' },
  { dir: 'services/chats', name: '@crm/chats' },
  { dir: 'services/brands', name: '@crm/brands' },
  { dir: 'services/worker', name: '@crm/worker' },
  { dir: 'web', name: 'web' },
  { dir: 'libs/proto', name: '@crm/proto' },
  { dir: 'libs/common', name: '@crm/common' },
];

describe('monorepo workspace linking (US1)', () => {
  it('declares every expected workspace with the right package name', () => {
    for (const ws of EXPECTED_WORKSPACES) {
      const pkgPath = join(repoRoot, ws.dir, 'package.json');
      expect(existsSync(pkgPath)).toBe(true);
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
      expect(pkg.name).toBe(ws.name);
    }
  });

  it('resolves a cross-workspace import from @crm/common', () => {
    expect(Array.isArray(SERVICE_NAMES)).toBe(true);
    expect(SERVICE_NAMES).toContain('gateway');
    expect(typeof noop).toBe('function');
  });
});
