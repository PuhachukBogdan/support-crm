/**
 * The export serializer (feature 017, roadmap 4.10 — research R6).
 *
 * RFC 4180 with one addition that is the whole reason this file is not four lines: **formula
 * neutralisation**.
 *
 * ── Why a CSV export is an injection surface ──────────────────────────────────────────────────────
 * A spreadsheet EXECUTES a leading `=`. A player who types `=cmd|' /c calc'!A1` into a chat message
 * has written code that runs on the machine of whichever colleague opens the export. Quoting does not
 * help: Excel strips the quotes and evaluates what is inside.
 *
 * This is the export-shaped twin of the polyglot problem feature 016 answered by re-encoding images.
 * The file is inert to us and active to its consumer, and OUR product produces it, so it is our
 * defect to prevent. Prefixing with a single quote is the standard neutralisation: the spreadsheet
 * treats the cell as text and does not display the prefix.
 *
 * ── What this deliberately does NOT do ───────────────────────────────────────────────────────────
 * It does not STRIP the dangerous character. Stripping silently alters customer data, and then the
 * export no longer says what happened — which defeats the point of exporting it. The value survives
 * intact; only its interpretation changes.
 */

/** Characters that make a spreadsheet treat a cell as a formula rather than text. */
const FORMULA_LEADERS = ['=', '+', '-', '@', '\t', '\r'] as const;

/** RFC 4180 line terminator. CRLF, because the consumer is a spreadsheet on someone's laptop. */
export const CSV_EOL = '\r\n';

/**
 * One field, escaped and neutralised.
 *
 * Order matters: neutralise FIRST, then quote. Quoting first would put the prefix outside the quotes,
 * where it is a literal character in the file instead of a text marker in the cell.
 */
export function csvField(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const neutralised = needsNeutralising(raw) ? `'${raw}` : raw;
  return needsQuoting(neutralised) ? `"${neutralised.replace(/"/g, '""')}"` : neutralised;
}

function needsNeutralising(raw: string): boolean {
  return raw.length > 0 && (FORMULA_LEADERS as readonly string[]).includes(raw[0]!);
}

function needsQuoting(value: string): boolean {
  return /[",\r\n]/.test(value) || value.startsWith("'");
}

/** One row, terminated. A row is always terminated — including the last, so appends are safe. */
export function csvRow(fields: readonly unknown[]): string {
  return fields.map(csvField).join(',') + CSV_EOL;
}

/**
 * A whole document from a header and rows.
 *
 * Convenience for tests and small results only. The producer does NOT use this — it streams rows into
 * a sink so a large export never exists in memory as one string (FR-007 / Principle VII).
 */
export function csvDocument(
  header: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
): string {
  return csvRow(header) + rows.map(csvRow).join('');
}

/**
 * Where produced rows go.
 *
 * An interface rather than a buffer, because it is what makes FR-007 testable: the producer can be
 * driven with far more rows than any page size while a test asserts that nothing accumulates. A
 * `string[]` return type would have made "does not materialise the whole result set" an unverifiable
 * claim in a comment.
 */
export interface CsvSink {
  write(chunk: string): void;
  /** Bytes handed to the sink so far — the running total the byte cap is checked against. */
  readonly byteLength: number;
}

/** A sink that accumulates. For tests and for results known to be small. */
export function arraySink(): CsvSink & { value(): string } {
  const parts: string[] = [];
  let bytes = 0;
  return {
    write(chunk: string): void {
      parts.push(chunk);
      bytes += Buffer.byteLength(chunk, 'utf8');
    },
    get byteLength(): number {
      return bytes;
    },
    value(): string {
      return parts.join('');
    },
  };
}
