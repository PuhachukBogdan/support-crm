import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * T034 (feature 012) — no PII in logs (Principle IV / SEC-26 / SC-007). Structural guard: scan the
 * chats service source for logging calls and assert none reference message content or identifiers.
 * Track A (source scan, Docker-independent). A log line that interpolated `body`/`mentions`/a
 * player/author id would fail this.
 */
const SRC = resolve(__dirname, '..', 'src');
// Feature 014: the automation engine, the dispatcher, the clock and the sweep all use the Nest Logger,
// so `this.logger.*` joins the scan — a rule that matched on message text must log THAT it matched,
// never what it matched on.
const LOG_CALL = /(console\.\w+|logInfo|logError|logWarn|logDebug|logger\.(log|warn|error|debug|verbose))\s*\(/;
// Feature 013 adds more things that must never reach a log line: canned-response text, macro action
// values (a macro carries operator ids and label ids), and the operator id an assignment writes.
// Feature 014 adds the condition inputs — `messageText` is the customer's own words, and `facts` is the
// object carrying them, so neither may appear in a log line even indirectly.
const SENSITIVE =
  /\b(body|mentions|author_id|authorId|player_id|playerId|operator_id|operatorId|assignee_operator_id|assigneeOperatorId|definition|actions|messageText|message_text|facts)\b/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'generated') continue; // Prisma-generated client — not our code
      out.push(...tsFiles(p));
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('chats — no PII in logs (SC-007)', () => {
  it('no logging call references message content or identifiers', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (LOG_CALL.test(line) && SENSITIVE.test(line)) {
          offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('no 013 error message carries a value the caller supplied (only field names — FR-013)', () => {
    // An RpcException message that interpolated a label id, operator id or canned body would leak
    // through the gateway into a client-visible payload; these messages must stay static strings.
    const offenders: string[] = [];
    const RPC_MESSAGE = /message:\s*(.+)$/;
    for (const file of tsFiles(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const m = RPC_MESSAGE.exec(line);
        // A template literal or concatenation in an RPC message is the smell we are guarding.
        if (m && /[`+]|\$\{/.test(m[1]!) && !/err instanceof/.test(line)) {
          offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * T051 (feature 014) — the new paths, and the one that could genuinely leak: a keyword rule matches
 * against **message text**. So the text must exist only in memory during matching, and never reach a
 * log line, a run record or an error payload (FR-020 / SC-010).
 */
describe('chats — feature 014: automations + SLA carry no PII', () => {
  const files = tsFiles(SRC);
  const read = (suffix: string) =>
    readFileSync(files.find((f) => f.endsWith(suffix))!, 'utf8');

  it('no log line in the automation/SLA/event code interpolates the matched text or the facts', () => {
    const offenders: string[] = [];
    for (const file of files) {
      // Normalise Windows separators so the folder match works on both platforms.
      if (!/\/(automation|sla|events)\//u.test(file.split(sep).join('/'))) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (LOG_CALL.test(line) && SENSITIVE.test(line)) {
            offenders.push(`${file}:${i + 1}  ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  // The run record is a diagnostic, and a diagnostic must not become a PII sink. The row simply has no
  // column that could hold text — asserted at the schema level as well as here.
  it('the run-record writer stores ids, an outcome and a short reason — nothing else', () => {
    const src = read('automations.repository.ts');
    const runData = src.slice(src.indexOf('function runData'));
    for (const forbidden of ['body', 'messageText', 'facts', 'player_id']) {
      expect(runData).not.toContain(forbidden);
    }
  });

  it('the matched text never leaves the matcher (conditions.ts holds no logging at all)', () => {
    const src = read('conditions.ts');
    expect(LOG_CALL.test(src)).toBe(false);
  });

  it('the refusal reasons the engine records are permission keys and static phrases', () => {
    const src = read('engine.ts');
    // Every recorded reason must be a template of static text + a PERMISSION KEY, never a fact value.
    for (const m of src.matchAll(/record\([^)]*'(refused|not_matched)'[^)]*\)/gs)) {
      expect(m[0]).not.toMatch(/facts|messageText|body/);
    }
  });

  it('the sweep answers with counts only — no id fields in its response shape', () => {
    const src = read('sla.grpc.controller.ts');
    const ret = src.slice(src.indexOf('return { checked'));
    expect(ret.slice(0, 120)).not.toMatch(/conversation_id|account_id/);
  });
});

/**
 * Feature 022 (roadmap 4.13), T028 — the contact-summary path.
 *
 * The scan above already covers these files (it walks all of `src/`), and the sensitive-token list
 * already includes `player_id` / `playerId`. What is added here is the stronger local statement: this
 * module logs **nothing at all**, so there is no line for a future edit to interpolate an identifier
 * into.
 *
 * ⚠️ `channel` is deliberately NOT a sensitive token. A channel KIND ("email", "whatsapp") is not
 * contact data and the card is useless without it; a channel IDENTIFIER (a phone number, a handle) is
 * contact data — and there is no field anywhere in this feature that could hold one, which is asserted
 * structurally in `tests/contracts/no-contact-fields-in-summary.spec.ts` rather than by grepping logs.
 */
describe('chats — the contact-summary path logs nothing (feature 022)', () => {
  const CONTACT_DIR = join(SRC, 'contact');

  it('the module exists and was actually scanned (a guard that scans nothing must fail)', () => {
    const files = tsFiles(CONTACT_DIR);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith('contact.grpc.controller.ts'))).toBe(true);
  });

  it('no file in it contains a logging call of any kind', () => {
    for (const file of tsFiles(CONTACT_DIR)) {
      expect({ file, logs: LOG_CALL.test(readFileSync(file, 'utf8')) }).toEqual({
        file,
        logs: false,
      });
    }
  });

  it('the refusal message names no caller-supplied value', () => {
    // Feature 021's live-only defect, second half: an error message that echoed an arbitrary caller key
    // back through the gateway and into its logs. The only refusal on this path is "brandId is required",
    // which is static text.
    const src = readFileSync(join(CONTACT_DIR, 'contact.grpc.controller.ts'), 'utf8');
    for (const m of src.matchAll(/message:\s*(['"`])([^'"`]*)\1/g)) {
      expect(m[2]).not.toMatch(/\$\{/);
    }
  });
});
