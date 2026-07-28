import { arraySink, csvDocument, csvField, csvRow, CSV_EOL } from './csv';

/**
 * T020 (feature 017, US1) — the serializer, and the one thing about it that is a security control.
 *
 * RFC 4180 is table stakes. The reason this file matters is FORMULA NEUTRALISATION: a spreadsheet
 * executes a leading `=`, so a player who types a formula into a chat message has written code that
 * runs on a colleague's machine when the export is opened. Our product produces the file, so it is
 * our defect to prevent (research R6).
 */
describe('RFC 4180 basics', () => {
  it('leaves an ordinary value untouched', () => {
    expect(csvField('open')).toBe('open');
    expect(csvField(42)).toBe('42');
    expect(csvField(true)).toBe('true');
  });

  it('renders null and undefined as an empty field, not as the words "null"/"undefined"', () => {
    // A CSV cell reading `null` is indistinguishable from a customer whose value IS the text "null".
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('quotes a value containing a comma, a quote or a newline, and doubles inner quotes', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
    expect(csvField('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('terminates every row, including the last, so appends are safe', () => {
    expect(csvRow(['a', 'b'])).toBe(`a,b${CSV_EOL}`);
  });

  it('builds a document as header + rows', () => {
    expect(csvDocument(['id', 'status'], [['c1', 'open']])).toBe(
      `id,status${CSV_EOL}c1,open${CSV_EOL}`,
    );
  });

  it('a zero-row export is a header and nothing else — a valid file, not an error', () => {
    expect(csvDocument(['id', 'status'], [])).toBe(`id,status${CSV_EOL}`);
  });
});

describe('*** formula injection is neutralised, not stripped *** (research R6)', () => {
  it.each([
    ['=cmd|\' /c calc\'!A1', "'=cmd|' /c calc'!A1"],
    ['+1+1', "'+1+1"],
    ['-1+1', "'-1+1"],
    ['@SUM(A1)', "'@SUM(A1)"],
  ])('prefixes %s', (input, expectedInner) => {
    // The neutralised value is then quoted, because it now starts with a quote character.
    expect(csvField(input)).toBe(`"${expectedInner}"`);
  });

  it('neutralises a leading TAB and a leading CR too', () => {
    expect(csvField('\t=1+1')).toContain("'\t=1+1");
    expect(csvField('\r=1+1')).toContain("'\r=1+1");
  });

  it('*** the value SURVIVES — the payload is recoverable, never edited away ***', () => {
    // Stripping the `=` would silently alter customer data, and then the export no longer says what
    // happened, which defeats the point of exporting it. Only the interpretation changes.
    //
    // Asserted as a ROUND TRIP rather than a substring, because a payload containing quotes is
    // correctly re-escaped by RFC 4180 (`"` → `""`) and so is not a literal substring of the field.
    // Recoverability is the property that matters: undo the CSV escaping and the neutralising prefix,
    // and the original value is byte-for-byte back.
    const payload = '=HYPERLINK("http://evil.example","click")';
    const field = csvField(payload);
    expect(field.startsWith('"\'')).toBe(true);

    const unquoted = field.slice(1, -1).replace(/""/g, '"');
    expect(unquoted.slice(1)).toBe(payload);
  });

  it('a message body that merely CONTAINS an equals sign is not touched', () => {
    // Neutralising mid-string `=` would mangle ordinary support text ("price = 10").
    expect(csvField('price = 10')).toBe('price = 10');
  });

  it('an empty field is not mistaken for a formula', () => {
    expect(csvField('')).toBe('');
  });
});

describe('the sink is what makes "does not materialise the whole result" testable (FR-007)', () => {
  it('reports the running byte length, so the cap can be checked as rows are written', () => {
    const sink = arraySink();
    sink.write(csvRow(['id']));
    const afterHeader = sink.byteLength;
    expect(afterHeader).toBeGreaterThan(0);
    sink.write(csvRow(['c1']));
    expect(sink.byteLength).toBeGreaterThan(afterHeader);
  });

  it('counts BYTES, not characters — a multi-byte value must not slip under a byte cap', () => {
    const sink = arraySink();
    sink.write('é'); // 2 bytes in UTF-8, 1 JS character
    expect(sink.byteLength).toBe(2);
  });
});
