import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, checkCode, codeAt, otpauthUrl, stepAt } from '../server/totp';

// RFC 6238, appendix B (SHA-1), last six digits of each eight-digit code.
const SECRET = Buffer.from('12345678901234567890');
const VECTORS: Array<[number, string]> = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']];

describe('two-step codes', () => {
  it('match the RFC 6238 test vectors', () => {
    for (const [seconds, code] of VECTORS) expect(codeAt(SECRET, stepAt(seconds * 1000))).toBe(code);
  });

  it('round-trips base32 the way authenticator apps write it', () => {
    expect(base32Encode(SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')).toEqual(SECRET);
  });

  it('accepts the current code and its neighbours, once', () => {
    const secret = base32Encode(SECRET);
    const time = 1111111111 * 1000;
    const step = stepAt(time);
    expect(checkCode(secret, codeAt(SECRET, step), time)).toBe(step);
    expect(checkCode(secret, codeAt(SECRET, step - 1), time)).toBe(step - 1);
    expect(checkCode(secret, ` ${codeAt(SECRET, step).slice(0, 3)} ${codeAt(SECRET, step).slice(3)} `, time)).toBe(step);
    // Used already, too old, or not a code.
    expect(checkCode(secret, codeAt(SECRET, step), time, step)).toBeNull();
    expect(checkCode(secret, codeAt(SECRET, step - 2), time)).toBeNull();
    expect(checkCode(secret, '12345', time)).toBeNull();
    expect(checkCode(secret, undefined, time)).toBeNull();
  });

  it('builds the address the QR code carries', () => {
    expect(otpauthUrl('ABC', 'my server')).toBe('otpauth://totp/Haul%3Amy%20server?secret=ABC&issuer=Haul&algorithm=SHA1&digits=6&period=30');
  });
});
