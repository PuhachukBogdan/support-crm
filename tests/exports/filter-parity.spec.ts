import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * T006a (feature 017, US1) — `ExportFilters` and the conversation list speak ONE filter vocabulary.
 *
 * FR-027 says an export request carries "the same filter vocabulary as the existing list endpoint".
 * The two are separate proto messages, so "the same" is a claim that decays the moment someone adds a
 * filter to one side. This test is what makes it a property instead of an intention.
 *
 * ── Why mirrored and not extracted ───────────────────────────────────────────────────────────────
 * Extracting a shared nested message out of the shipped `ListConversationsRequest` would renumber it
 * and touch feature 012's wire tests — a real risk taken for tidiness on an internal contract. The
 * cheaper structural choice is safe only if the sameness is asserted, which is this file. Field NUMBERS
 * are compared too, so the comparison reads as an equality rather than a mapping somebody maintains.
 *
 * `page_token` / `page_size` are excluded on purpose: an export covers the whole filtered set up to its
 * scope's row limit, so paging is an internal production concern and never a request parameter.
 *
 * ── Feature 029 (2026-08-02): this test caught exactly what its own comment predicted ─────────────
 * The Inbox added two fields to the list request, and the header above says in as many words that
 * intent "does not survive a future field added to one side only". It did not have to survive —
 * the test failed and named both fields.
 *
 * The two were resolved differently, and the distinction is the point:
 *   • `channel` is a FILTER  → mirrored into ExportFilters. An admin who narrows the Inbox to one
 *     channel and exports must not receive the whole set; that is more customer rows than the screen
 *     showed, which is the anti-pitching failure itself (SEC-AP2).
 *   • `order` is SEQUENCING → excluded, like paging. An export is a set, not a sequence.
 *
 * ⇒ The excluded list is therefore not "paging", it is **everything that is not a filter**, and it is
 * named that way so the next person adding a field has to decide which of the two it is.
 */
const ROOT = resolve(__dirname, '..', '..');
const CHATS_PROTO = join(ROOT, 'libs', 'proto', 'crm', 'chats', 'v1', 'chats.proto');

/** `field name = number` pairs inside `message <name> { … }`, comments stripped. */
function fieldsOf(message: string): Array<{ name: string; number: number; type: string }> {
  const src = readFileSync(CHATS_PROTO, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const start = new RegExp(`^\\s*message\\s+${message}\\s*\\{`, 'm').exec(src);
  if (!start) throw new Error(`message ${message} not found in chats.proto`);
  const body = src.slice(start.index + start[0].length);
  const end = body.indexOf('\n}');
  const fields: Array<{ name: string; number: number; type: string }> = [];
  for (const line of body.slice(0, end).split(/\r?\n/)) {
    const m = /^\s*(?:(repeated)\s+)?([\w.]+)\s+(\w+)\s*=\s*(\d+)\s*;/.exec(line);
    if (m) fields.push({ type: m[2]!, name: m[3]!, number: Number(m[4]) });
  }
  return fields;
}

/**
 * Fields on the list request that are NOT part of the filter vocabulary, and therefore are not
 * expected to appear on `ExportFilters`. Adding a name here is a claim that the field does not narrow
 * WHICH rows come back — check that before extending it.
 */
const NOT_A_FILTER = ['page_token', 'page_size', 'order'];

describe('the scan finds what it is meant to police (guards against a vacuous pass)', () => {
  it('both messages exist and are non-trivial', () => {
    expect(fieldsOf('ListConversationsRequest').length).toBeGreaterThan(5);
    expect(fieldsOf('ExportFilters').length).toBeGreaterThan(3);
  });
});

describe('*** ExportFilters === the list request filters (FR-027) ***', () => {
  const listFilters = fieldsOf('ListConversationsRequest').filter(
    (f) => !NOT_A_FILTER.includes(f.name),
  );
  const exportFilters = fieldsOf('ExportFilters');

  it('the field NAMES are identical sets', () => {
    expect(exportFilters.map((f) => f.name).sort()).toEqual(listFilters.map((f) => f.name).sort());
  });

  it('each shared field keeps the same TYPE — a widened filter is a different question', () => {
    for (const f of listFilters) {
      const mirrored = exportFilters.find((e) => e.name === f.name);
      expect({ name: f.name, type: mirrored?.type }).toEqual({ name: f.name, type: f.type });
    }
  });

  it('each shared field keeps the same field NUMBER, so the mirror reads as an equality', () => {
    for (const f of listFilters) {
      const mirrored = exportFilters.find((e) => e.name === f.name);
      expect({ name: f.name, number: mirrored?.number }).toEqual({
        name: f.name,
        number: f.number,
      });
    }
  });

  it('paging and ordering are absent from ExportFilters — an export is not a page, nor a sequence', () => {
    for (const notAFilter of NOT_A_FILTER) {
      expect(exportFilters.map((f) => f.name)).not.toContain(notAFilter);
    }
  });
});
