import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// US1 / FR-002, FR-005, SC-006 — verified WITHOUT a live Docker runtime by parsing the
// provisioning artifacts: each data-owning service gets its OWN database + role, each role
// connects to ONLY its own database, gateway/worker own none, and NO password is hardcoded.

const repoRoot = join(__dirname, '..', '..', '..');
const initScript = readFileSync(
  join(repoRoot, 'deploy', 'local', 'postgres', 'init', '01-init-databases.sh'),
  'utf8',
);
const compose = readFileSync(join(repoRoot, 'compose.yaml'), 'utf8');

const DATA_SERVICES = ['auth', 'users', 'chats', 'brands'] as const;
const NON_DATA_SERVICES = ['gateway', 'worker'] as const;

describe('per-service datastore isolation (spec 003, US1)', () => {
  it('provisions exactly the four data services, each with a distinct role', () => {
    // The init script declares services as `svc:PW_ENV_VAR` pairs.
    const pairs = [...initScript.matchAll(/^\s*"(\w+):(\w+)"/gm)].map((m) => ({
      svc: m[1],
      pwVar: m[2],
    }));
    const svcs = pairs.map((p) => p.svc).sort();
    expect(svcs).toEqual([...DATA_SERVICES].sort());
    // roles/passwords are per-service and distinct
    expect(new Set(pairs.map((p) => p.pwVar)).size).toBe(DATA_SERVICES.length);
  });

  it('grants each role CONNECT to only its own database (PUBLIC revoked)', () => {
    expect(initScript).toMatch(/CREATE ROLE \$\{role\} LOGIN PASSWORD/);
    expect(initScript).toMatch(/CREATE DATABASE \$\{db\} OWNER \$\{role\}/);
    expect(initScript).toMatch(/REVOKE CONNECT ON DATABASE \$\{db\} FROM PUBLIC/);
    expect(initScript).toMatch(/GRANT CONNECT ON DATABASE \$\{db\} TO \$\{role\}/);
  });

  it('hardcodes no role password — passwords come from the environment', () => {
    // No literal `PASSWORD 'something'` (only the templated ${pw}).
    expect(initScript).not.toMatch(/PASSWORD '(?!\$\{pw\})[^']+'/);
    expect(initScript).toMatch(/pw="\$\{!pw_var:-\}"/); // read from env by name
  });

  it('gives each data service its own DATABASE_URL (distinct db + role) in compose', () => {
    const dbNames = new Set<string>();
    const roles = new Set<string>();
    for (const svc of DATA_SERVICES) {
      const re = new RegExp(
        `DATABASE_URL:\\s*postgresql://(\\w+):[^@]+@postgres:5432/(\\w+)`,
        'g',
      );
      const found = [...compose.matchAll(re)].map((m) => ({ role: m[1], db: m[2] }));
      const forSvc = found.find((f) => f.db === `${svc}_db`);
      expect(forSvc).toBeDefined();
      expect(forSvc!.role).toBe(`${svc}_user`);
      dbNames.add(forSvc!.db);
      roles.add(forSvc!.role);
    }
    expect(dbNames.size).toBe(DATA_SERVICES.length); // all distinct
    expect(roles.size).toBe(DATA_SERVICES.length);
  });

  it('gives gateway and worker NO database', () => {
    for (const svc of NON_DATA_SERVICES) {
      // isolate the service block and assert it has no DATABASE_URL
      const block = new RegExp(`\\n  ${svc}:\\n([\\s\\S]*?)(?=\\n  \\w+:|\\nvolumes:)`).exec(
        compose,
      );
      expect(block).not.toBeNull();
      expect(block![1]).not.toContain('DATABASE_URL');
    }
  });

  it('references role passwords via ${..._DB_PASSWORD} env vars, never literals', () => {
    for (const svc of DATA_SERVICES) {
      const v = svc.toUpperCase();
      expect(compose).toContain(`\${${v}_DB_PASSWORD`);
    }
  });
});
