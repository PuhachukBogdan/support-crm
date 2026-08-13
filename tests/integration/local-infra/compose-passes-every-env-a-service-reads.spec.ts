import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * ⭐ **COMPOSE HANDS A CONTAINER ONLY WHAT ITS OWN BLOCK NAMES.**
 *
 * ── Why this guard exists ────────────────────────────────────────────────────────────────────────
 * `.env` **substitutes** `${VAR}`; it does not **inject**. A key can be correctly set in `.env`, correctly
 * read by `loadConfig`, and still be `undefined` inside the process — because the service's `environment:`
 * block never mentioned it. Feature 009's first live boot failed exactly this way, and the `chats` block
 * carries a comment saying so.
 *
 * It happened again anyway, in feature 033, and the comment did not prevent it — which is the point:
 * ⚠️ **a rule recorded in an artefact is not a rule enforced by the process.** `ChatsSmtpTransport` reads
 * seven `MAIL_*` keys and the `chats` block named none of them, so the channel's outbound relay had an
 * empty host in *every* compose deployment. nodemailer then fell back to `localhost:1025` inside a
 * container running no mail server, the agent's reply died after five attempts, and — by deliberate
 * design, because the envelope holds a **customer's** address — the log said only `Error`.
 *
 * That is the failure mode this guard is really about. The defect is invisible three ways at once:
 *   · every unit test passes (a fake transport needs no host),
 *   · the value is present in `.env`, so an operator reading `.env` sees it configured,
 *   · the product reports a mail failure without naming the destination it failed to reach.
 *
 * ── What it asserts ─────────────────────────────────────────────────────────────────────────────
 * For every service, every `MAIL_*` / `CHANNEL_*` env key the service's own source reads must be named in
 * that service's compose block. Scoped to those two prefixes on purpose: they are the ones whose absence
 * fails **silently** rather than at boot. A missing `GRPC_URL` crash-loops in the first second and needs no
 * test; a missing `MAIL_HOST` looks like a working deployment until a customer is waiting for an answer.
 *
 * ⚠️ Deliberately NOT the converse. A block may name a key the service does not read yet (`compose.yaml`
 * documents a deployment surface, and an unused key is harmless), so this guard is one-directional.
 */
const ROOT = resolve(__dirname, '..', '..', '..');

/** CRLF → LF: a Windows checkout may materialize these with CRLF and the anchors below are line-based. */
const readLF = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');

/** Services with an `environment:` block in compose. `minio-init` and the datastores read no app config. */
const SERVICES = ['gateway', 'auth', 'users', 'chats', 'brands', 'worker'] as const;

/** Only these fail quietly; see the header. */
const SILENT_PREFIXES = /^(MAIL|CHANNEL)_/;

/**
 * The compose block for one service: from `  <name>:` to the next line at the same indent.
 *
 * Comments are stripped FIRST. Half the keys in this file appear in prose explaining why they exist, and a
 * guard satisfied by a comment is a guard that passes once somebody documents the key they forgot to pass.
 */
function composeBlock(compose: string, service: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l === `  ${service}:`);
  expect(start).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end))
    .map((l) => l.replace(/#.*$/, ''))
    .join('\n');
}

/** Every `env.KEY` / `process.env.KEY` a service's non-test source reads. */
function envKeysRead(service: string): Set<string> {
  const keys = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        // `generated/` is the Prisma client — vendor output, and it quotes our own doc comments back at us.
        if (entry !== 'generated') walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      if (entry.includes('.spec.') || entry.endsWith('.d.ts')) continue;
      const src = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) keys.add(m[1]);
    }
  };
  walk(join(ROOT, 'services', service, 'src'));
  return keys;
}

describe('compose passes every silently-failing env key a service reads (feature 033)', () => {
  const compose = readLF('compose.yaml');

  it.each(SERVICES)('%s: its block names every MAIL_*/CHANNEL_* key its source reads', (service) => {
    const block = composeBlock(compose, service);
    const missing = [...envKeysRead(service)]
      .filter((k) => SILENT_PREFIXES.test(k))
      .filter((k) => !new RegExp(`^\\s*${k}:`, 'm').test(block))
      .sort();
    expect(missing).toEqual([]);
  });

  /**
   * The regression, stated as the concrete fact rather than as a rule — so a reader who breaks it sees
   * *what* broke. `chats` opens the outbound SMTP connection (research R6/R7: the worker only says "now",
   * chats holds the outbox and fetches the envelope at send time), therefore `chats` needs the relay's
   * address. Naming these on the worker instead — which is where they were — passes them to the one
   * service that never opens a socket.
   */
  it('chats — the service that opens the channel relay — receives the relay address', () => {
    const block = composeBlock(compose, 'chats');
    for (const key of ['MAIL_HOST', 'MAIL_PORT', 'MAIL_SECURE', 'MAIL_USER', 'MAIL_PASSWORD']) {
      expect(block).toMatch(new RegExp(`^\\s*${key}:`, 'm'));
    }
  });

  /**
   * Both egress guards run inside the shared sender before a socket is opened (Principle III). If the
   * process cannot see the lists, the guards are decorative: an empty list reads as *unrestricted*, which
   * is the fail-OPEN direction and the one an absent key silently selects.
   */
  it.each(['chats', 'auth'])('%s: both mail egress allow-lists reach the sender', (service) => {
    const block = composeBlock(compose, service);
    expect(block).toMatch(/^\s*MAIL_ALLOWED_HOSTS:/m);
    expect(block).toMatch(/^\s*MAIL_ALLOWED_RECIPIENT_DOMAINS:/m);
  });
});
