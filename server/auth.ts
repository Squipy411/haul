import crypto from 'node:crypto';
import type { Context } from './http.js';
import type { SettingsService } from './settings.js';

/**
 * - `password`: server installs. A password is created during setup; until then only setup answers.
 * - `desktop`: the Windows app running Haul itself. Its own window gets a session from the app;
 *   other devices need a password, which is optional.
 * - `none`: no login at all, for installs behind a proxy that already authenticates.
 */
export type AuthMode = 'password' | 'desktop' | 'none';

export const SESSION_COOKIE = 'haul_session';
const SESSION_MS = 30 * 86_400_000;
const MAX_FAILURES = 5;

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function clientIp(ctx: Context): string {
  return ctx.req.socket.remoteAddress ?? 'unknown';
}

export class Auth {
  private failures = new Map<string, { count: number; until: number }>();

  constructor(private readonly settings: SettingsService, readonly mode: AuthMode) {}

  /** A server install that has no password yet. */
  get locked(): boolean {
    return this.mode === 'password' && !this.settings.value.passwordHash;
  }

  get canRemovePassword(): boolean {
    return this.mode !== 'password';
  }

  private sign(value: string): string {
    return crypto.createHmac('sha256', this.settings.value.sessionSecret).update(value).digest('base64url');
  }

  // Password sessions include the password hash, so changing the password signs everyone out.
  private payload(kind: 'p' | 'd', expires: string): string {
    return kind === 'p' ? `p.${expires}.${this.settings.value.passwordHash}` : `d.${expires}`;
  }

  mint(kind: 'p' | 'd'): { name: string; value: string; expires: number } {
    const expires = Date.now() + SESSION_MS;
    return { name: SESSION_COOKIE, value: `${kind}.${expires}.${this.sign(this.payload(kind, String(expires)))}`, expires };
  }

  isAuthenticated(ctx: Context): boolean {
    if (this.mode === 'none') return true;
    const cookie = ctx.cookies[SESSION_COOKIE];
    if (!cookie) return false;
    const [kind, expires, signature, extra] = cookie.split('.');
    if ((kind !== 'p' && kind !== 'd') || !expires || !signature || extra !== undefined) return false;
    if (Number(expires) < Date.now()) return false;
    if (kind === 'd' && this.mode !== 'desktop') return false;
    if (kind === 'p' && !this.settings.value.passwordHash) return false;
    return sameText(this.sign(this.payload(kind, expires)), signature);
  }

  startSession(ctx: Context): void {
    const session = this.mint('p');
    ctx.res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${session.value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}`);
  }

  endSession(ctx: Context): void {
    ctx.res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  }

  /** Milliseconds this address must wait before another login attempt. */
  waitFor(ip: string): number {
    const entry = this.failures.get(ip);
    return entry && entry.until > Date.now() ? entry.until - Date.now() : 0;
  }

  recordFailure(ip: string): void {
    const entry = this.failures.get(ip) ?? { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= MAX_FAILURES) entry.until = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (entry.count - MAX_FAILURES));
    this.failures.set(ip, entry);
    if (this.failures.size > 5000) this.failures.clear();
  }

  recordSuccess(ip: string): void {
    this.failures.delete(ip);
  }
}

export function validPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 8 && password.length <= 256;
}
