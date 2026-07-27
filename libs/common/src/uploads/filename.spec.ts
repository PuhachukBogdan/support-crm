import { toDisplayLabel } from './filename';

/**
 * T011 (feature 016) — a client filename becomes a display label and nothing more (FR-008).
 *
 * The storage identity is system-generated, so none of these inputs can reach a path. These tests
 * are therefore about the SECOND hazard: the label travels in a `Content-Disposition` header, where
 * a CR, an LF or a quote is a header-injection primitive.
 */
describe('path traversal cannot survive into a label', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\garry\\secret.png', 'secret.png'],
    ['/var/lib/app/receipt.pdf', 'receipt.pdf'],
    ['..\\..\\windows\\system32\\cmd.exe', 'cmd.exe'],
    ['folder/sub/image.webp', 'image.webp'],
  ])('%s → %s', (input, expected) => {
    expect(toDisplayLabel(input)).toBe(expected);
  });

  it('a name that is only traversal has nothing left', () => {
    expect(toDisplayLabel('..')).toBeNull();
    expect(toDisplayLabel('../..')).toBeNull();
    expect(toDisplayLabel('.')).toBeNull();
    expect(toDisplayLabel('/')).toBeNull();
    expect(toDisplayLabel('\\')).toBeNull();
  });
});

describe('*** header injection is removed, not escaped ***', () => {
  it('CR and LF cannot reach the label', () => {
    const injected = 'receipt.pdf\r\nX-Injected: yes';
    const label = toDisplayLabel(injected)!;
    expect(label).not.toContain('\r');
    expect(label).not.toContain('\n');
    expect(label).toBe('receipt.pdfX-Injected: yes');
  });

  it('a quote cannot break out of the quoted header value', () => {
    // Escaping would also work until someone re-encodes the value. Removal cannot be undone
    // downstream, which is why it is the choice here.
    expect(toDisplayLabel('a";attachment;filename="evil.exe')).toBe('a;attachment;filename=evil.exe');
  });

  it('other control characters are stripped', () => {
    expect(toDisplayLabel('na\u0000me\u0007.png')).toBe('name.png');
    expect(toDisplayLabel('tab\there.png')).toBe('tabhere.png');
  });
});

describe('length is capped, and the extension survives', () => {
  it('a 4 000-character name is truncated', () => {
    const label = toDisplayLabel(`${'a'.repeat(4000)}.png`)!;
    expect(label.length).toBeLessThanOrEqual(120);
    expect(label.endsWith('.png')).toBe(true);
  });

  it('a long name with no extension is simply cut', () => {
    const label = toDisplayLabel('b'.repeat(500))!;
    expect(label.length).toBe(120);
  });

  it('an absurd "extension" is not preserved at the cost of the name', () => {
    // A 300-character suffix is not an extension; treating it as one would truncate the whole name.
    const label = toDisplayLabel(`${'c'.repeat(200)}.${'d'.repeat(300)}`)!;
    expect(label.length).toBe(120);
    expect(label.startsWith('c')).toBe(true);
  });
});

describe('normal names pass through', () => {
  it('keeps unicode intact', () => {
    expect(toDisplayLabel('квитанция.pdf')).toBe('квитанция.pdf');
    expect(toDisplayLabel('スクリーンショット.png')).toBe('スクリーンショット.png');
  });

  it('keeps ordinary names and spaces', () => {
    expect(toDisplayLabel('Screenshot 2026-07-27 at 12.04.png')).toBe(
      'Screenshot 2026-07-27 at 12.04.png',
    );
  });

  it('keeps a dotfile as a name rather than reading it as an extension', () => {
    expect(toDisplayLabel('.gitignore')).toBe('.gitignore');
  });
});

describe('nothing usable yields null, never a placeholder', () => {
  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['control characters only', '\u0000\u0001'],
  ])('%s', (_label, input) => {
    expect(toDisplayLabel(input)).toBeNull();
  });

  it('a missing filename is null', () => {
    expect(toDisplayLabel(undefined)).toBeNull();
    expect(toDisplayLabel(null)).toBeNull();
    // A non-string arriving from an untyped wire boundary must not throw.
    expect(toDisplayLabel(42 as unknown as string)).toBeNull();
  });

  it('a manufactured name is never substituted', () => {
    // "unnamed.bin" would be indistinguishable from a real filename to every reader downstream.
    expect(toDisplayLabel('')).toBeNull();
  });
});
