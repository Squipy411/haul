import crypto from 'node:crypto';

// Two-step sign-in codes (RFC 6238): the 6-digit codes Google Authenticator, 1Password, Authy and
// the iPhone's Passwords app show for a secret shared once as a QR code.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Not a base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for one 30-second step. */
export function codeAt(secret: Buffer, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hash = crypto.createHmac('sha1', secret).update(counter).digest();
  const offset = hash[hash.length - 1]! & 15;
  const number = (hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(number).padStart(digits, '0');
}

export const stepAt = (time = Date.now()) => Math.floor(time / 1000 / STEP_SECONDS);

/**
 * The step a typed code belongs to, allowing one step either side for a phone clock that's a little
 * off, or null. Steps up to `usedStep` are refused, so a code can't be used twice.
 */
export function checkCode(secretBase32: string, typed: unknown, time = Date.now(), usedStep = -1): number | null {
  const code = typeof typed === 'string' ? typed.replace(/\s/g, '') : '';
  if (!/^\d{6}$/.test(code) || !secretBase32) return null;
  const secret = base32Decode(secretBase32);
  const now = stepAt(time);
  for (const step of [now, now - 1, now + 1]) {
    if (step <= usedStep) continue;
    const expected = codeAt(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return step;
  }
  return null;
}

export const newSecret = () => base32Encode(crypto.randomBytes(20));

/** What authenticator apps read from the QR code. */
export function otpauthUrl(secret: string, account: string): string {
  const label = encodeURIComponent(`Haul:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=Haul&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}
