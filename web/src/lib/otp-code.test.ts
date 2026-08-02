import { normalizeOtpCode } from './otp-code';

/**
 * Written after the first real sign-in on the hosted stand failed with a CORRECT code
 * (2026-08-02). The code had been copied out of a chat message and carried a trailing newline;
 * the server compares the string to an argon2 hash exactly as it arrives, so it was refused — and
 * the screen could only say "that code is not right", because the gateway deliberately will not
 * say which of four reasons it was. The person is then debugging the one thing that was fine.
 */
describe('normalizeOtpCode', () => {
  it('strips the whitespace a copy-paste brings with it', () => {
    expect(normalizeOtpCode('RFDV8T\n')).toBe('RFDV8T');
    expect(normalizeOtpCode('  RFDV8T  ')).toBe('RFDV8T');
    expect(normalizeOtpCode('\tRFDV8T')).toBe('RFDV8T');
  });

  it('strips whitespace in the MIDDLE — a wrapped email breaks a code in half', () => {
    expect(normalizeOtpCode('RFD V8T')).toBe('RFDV8T');
  });

  it('upper-cases, because the alphabet has no lower-case letters', () => {
    expect(normalizeOtpCode('rfdv8t')).toBe('RFDV8T');
    expect(normalizeOtpCode('RfDv8T')).toBe('RFDV8T');
  });

  it('leaves a correct code exactly as it is', () => {
    // The property that makes this safe: it can only turn an invalid string into a valid one.
    for (const code of ['RFDV8T', 'ABCDEF', '234567', 'Z9K3MP']) {
      expect(normalizeOtpCode(code)).toBe(code);
    }
  });

  it('does not invent characters or pad', () => {
    expect(normalizeOtpCode('')).toBe('');
    expect(normalizeOtpCode('   ')).toBe('');
    // A wrong code stays wrong — normalising is not guessing.
    expect(normalizeOtpCode('zzz')).toBe('ZZZ');
  });
});
