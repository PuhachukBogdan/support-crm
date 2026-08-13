import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
// ⭐ 2026-08-13: lines WITHOUT the trailing `\r`. An anchored pattern over a raw `split('\n')` matches
// nothing on a CRLF working tree — this file is the one that proved it, by passing for weeks.
import { sourceLines } from '@crm/common';

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
      const lines = sourceLines(readFileSync(file, 'utf8'));
      lines.forEach((line, i) => {
        if (LOG_CALL.test(line) && SENSITIVE.test(line)) {
          offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  const RPC_MESSAGE = /message:\s*(.+)$/;
  const interpolates = (line: string): boolean => {
    const m = RPC_MESSAGE.exec(line);
    // A template literal or concatenation in an RPC message is the smell we are guarding.
    return !!m && /[`+]|\$\{/.test(m[1]!) && !/err instanceof/.test(line);
  };

  /**
   * ⭐⭐ **THE POSITIVE CONTROL, and it is here because its absence cost weeks.**
   *
   * This guard was anchored with `$` and read lines from a raw `split('\n')`. On a CRLF working tree every
   * line still ends with `\r`, and in JavaScript **`.` does not match `\r`** — so `(.+)$` could never
   * reach the end of a line, the pattern matched NOTHING in any file, and the guard reported an empty
   * offender list while asserting nothing at all. It passed on Windows for weeks and fired on CI's LF
   * checkout the first time CI ran (130 commits later), naming a real violation in the W30 solve gate.
   *
   * An emptiness assertion needs a witness that the detector can fire. That is what this is.
   */
  it('the detector FIRES on an interpolated message — and on a CRLF line too', () => {
    expect(interpolates("        message: `required fields are empty: ${missing.join(', ')}`,")).toBe(true);
    expect(interpolates("        message: 'forbidden',")).toBe(false);
    // ⚠️ The CRLF case, stated as its own expectation: this is the one that used to answer `false` for
    // every line in the product, and `sourceLines` is what keeps it honest.
    const crlfSource = "        message: `x: ${y}`,\r\n        message: 'static',\r\n";
    expect(sourceLines(crlfSource).filter(interpolates)).toHaveLength(1);
  });

  it('no 013 error message carries a value the caller supplied (only field names — FR-013)', () => {
    // An RpcException message that interpolated a label id, operator id or canned body would leak
    // through the gateway into a client-visible payload; these messages must stay static strings.
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      sourceLines(readFileSync(file, 'utf8')).forEach((line, i) => {
        if (interpolates(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
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
        .split(/\r\n|\n|\r/)
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

/**
 * T040 (feature 031, roadmap 4.20/4.19) — **routing is the newest way to leak a customer.**
 *
 * Three surfaces arrived with this feature and each is a plausible place for a contact value:
 *
 *  • the **routing diagnostic** — a reason why a desk could serve nobody. The tempting version names the
 *    conversation and the person it is for, because that is what a human debugging it wants;
 *  • the **backlog view** — a queue an agent may SEE. What it may show about *whose* customer is waiting
 *    is D-4 and undecided; what it may never show is a contact value (FR-021);
 *  • the **unroutable event** — audited, and therefore permanent (FR-022).
 *
 * ⚠️ The maintenance responses are asserted to be COUNTS in their own specs. This is the log/PII half:
 * the modules that make routing decisions must not log the work they are deciding about.
 */
describe('chats — feature 031: routing carries no contact value', () => {
  const files = tsFiles(SRC);
  const routing = files.filter((f) =>
    /\/(assignment|conversation\/urgency|conversation\/order-parts)/u.test(f.split(sep).join('/')),
  );

  it('the routing modules were actually scanned (a guard that scans nothing must fail)', () => {
    expect(routing.length).toBeGreaterThan(4);
    expect(routing.some((f) => f.endsWith('backlog.grpc.controller.ts'))).toBe(true);
  });

  it('⛔ no log line in the assignment path references an identifier', () => {
    const offenders: string[] = [];
    for (const file of routing) {
      readFileSync(file, 'utf8')
        .split(/\r\n|\n|\r/)
        .forEach((line, i) => {
          if (LOG_CALL.test(line) && SENSITIVE.test(line)) offenders.push(`${file}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('⭐ the unroutable event carries a reason CLASS and no free text', () => {
    const src = readFileSync(
      files.find((f) => f.endsWith('backlog.grpc.controller.ts'))!,
      'utf8',
    );
    const detail = src.slice(src.indexOf('detail: {'), src.indexOf('} as never'));
    // The class values, and nothing that could hold a sentence or a contact.
    // ⓘ Word-boundary, not `toContain`: `nobody_available` contains "body", and a substring check made
    // this assertion fail on the reason class it exists to permit.
    expect(detail).toMatch(/reasonClass/);
    for (const forbidden of ['body', 'message', 'player_id', 'playerId', 'reasonText', 'contact']) {
      expect(detail).not.toMatch(new RegExp(`\b${forbidden}\b`));
    }
  });

  it('⚠️ the ROUTING DIAGNOSTIC is a reason token, not a sentence about a person', () => {
    // The pool answers `{ candidates, reason }` and the reason is an UPPER_SNAKE token from a closed set.
    // A free-text reason is the shape that ends up naming the customer, because that is the useful
    // version to a human debugging it — and it is then logged, graphed and kept.
    const src = readFileSync(files.find((f) => f.endsWith('group-pool.ts'))!, 'utf8');
    for (const m of src.matchAll(/reason:\s*(.+)$/gm)) {
      const value = m[1]!;
      // Allowed: a named constant, a token in quotes, `null`, or a field reference. Not a template.
      expect(value).not.toMatch(/\$\{/);
    }
  });

  it('the urgency rank is derived from a WORD, so no contact value can reach the order', () => {
    // Structural rather than a log scan: the ordering key's only inputs are the priority word and a
    // timestamp column. There is no path by which a customer fact becomes part of a sort key.
    const src = readFileSync(files.find((f) => f.endsWith('urgency.ts'))!, 'utf8');
    expect(LOG_CALL.test(src)).toBe(false);
    for (const forbidden of ['player_id', 'playerId', 'body', 'author_id']) {
      expect(src).not.toMatch(new RegExp(`\b${forbidden}\b`));
    }
  });
});
