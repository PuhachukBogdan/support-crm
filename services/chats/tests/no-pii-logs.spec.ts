import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * T034 (feature 012) — no PII in logs (Principle IV / SEC-26 / SC-007). Structural guard: scan the
 * chats service source for logging calls and assert none reference message content or identifiers.
 * Track A (source scan, Docker-independent). A log line that interpolated `body`/`mentions`/a
 * player/author id would fail this.
 */
const SRC = resolve(__dirname, '..', 'src');
const LOG_CALL = /(console\.\w+|logInfo|logError|logWarn|logDebug)\s*\(/;
// Feature 013 adds more things that must never reach a log line: canned-response text, macro action
// values (a macro carries operator ids and label ids), and the operator id an assignment writes.
const SENSITIVE =
  /\b(body|mentions|author_id|authorId|player_id|playerId|operator_id|operatorId|assignee_operator_id|assigneeOperatorId|definition|actions)\b/;

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
