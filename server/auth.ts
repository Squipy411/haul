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
/** Wrong passwords from all addresses together before every sign-in slows to one a minute. */
const GLOBAL_FAILURES = 30;
const GLOBAL_WINDOW_MS = 15 * 60_000;

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Loopback, home networks, Docker's networks, and Tailscale's 100.64/10 range. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^::ffff:/, '');
  return ip === '::1' || /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    || /^169\.254\./.test(ip) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip);
}

const peerAddress = (ctx: Context) => (ctx.req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
/** Forwarding headers count only when they come from a proxy or tunnel on this machine or network. */
const fromLocalProxy = (ctx: Context) => isPrivateAddress(peerAddress(ctx)) && Boolean(ctx.req.headers['x-forwarded-for'] || ctx.req.headers['x-real-ip']);

/**
 * The visitor's address. Behind a tunnel (Tailscale Funnel, Cloudflare) or a reverse proxy every request
 * arrives from the proxy, so the address it added is used: the last one in X-Forwarded-For, which a
 * visitor can't forge because the proxy appends it after anything they sent.
 */
export function clientIp(ctx: Context): string {
  if (!fromLocalProxy(ctx)) return peerAddress(ctx);
  const forwarded = String(ctx.req.headers['x-forwarded-for'] ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  return (forwarded[forwarded.length - 1] ?? String(ctx.req.headers['x-real-ip'] ?? '')).replace(/^::ffff:/, '') || peerAddress(ctx);
}

/** Reached over HTTPS, directly or through a tunnel that ends HTTPS in front of Haul. */
export function isHttps(ctx: Context): boolean {
  if ((ctx.req.socket as { encrypted?: boolean }).encrypted) return true;
  return isPrivateAddress(peerAddress(ctx)) && String(ctx.req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() === 'https';
}

/** Someone outside your home network (or Tailscale): the internet, through a tunnel or a forwarded port. */
export const isFromInternet = (ctx: Context) => !isPrivateAddress(clientIp(ctx));

export class Auth {
  private failures = new Map<string, { count: number; until: number }>();
  private recent: number[] = [];

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

  // Password sessions include the password hash, so changing the password signs everyone out, and the
  // session generation, which "Sign out everywhere" moves on.
  private payload(kind: 'p' | 'd', expires: string): string {
    const generation = this.settings.value.sessionGeneration;
    return kind === 'p' ? `p.${expires}.${this.settings.value.passwordHash}${generation ? `.${generation}` : ''}` : `d.${expires}`;
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

  // Over HTTPS the cookie is marked Secure, so it never travels unencrypted.
  private cookie(ctx: Context, value: string, maxAge: number): void {
    ctx.res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(ctx) ? '; Secure' : ''}`);
  }

  startSession(ctx: Context): void {
    this.cookie(ctx, this.mint('p').value, Math.floor(SESSION_MS / 1000));
  }

  endSession(ctx: Context): void {
    this.cookie(ctx, '', 0);
  }

  /**
   * Milliseconds this address must wait before another sign-in attempt. After 5 wrong passwords an
   * address waits 30 s, doubling to 15 min; after 30 from anywhere within 15 minutes (someone trying
   * from many addresses), every attempt waits a minute after the last wrong one.
   */
  waitFor(ip: string): number {
    const now = Date.now();
    const entry = this.failures.get(ip);
    const own = entry && entry.until > now ? entry.until - now : 0;
    this.recent = this.recent.filter((at) => now - at < GLOBAL_WINDOW_MS);
    const everyone = this.recent.length >= GLOBAL_FAILURES ? Math.max(0, this.recent[this.recent.length - 1]! + 60_000 - now) : 0;
    return Math.max(own, everyone);
  }

  /** Records a wrong password; true when this one made the address wait (worth telling the owner). */
  recordFailure(ip: string): boolean {
    const entry = this.failures.get(ip) ?? { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= MAX_FAILURES) entry.until = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (entry.count - MAX_FAILURES));
    this.failures.delete(ip);
    this.failures.set(ip, entry);
    this.recent.push(Date.now());
    // Forget the oldest addresses that aren't waiting, rather than everyone at once.
    if (this.failures.size > 5000) {
      for (const [address, record] of this.failures) {
        if (this.failures.size <= 4000) break;
        if (record.until <= Date.now()) this.failures.delete(address);
      }
    }
    return entry.count === MAX_FAILURES;
  }

  recordSuccess(ip: string): void {
    this.failures.delete(ip);
  }
}

/** "iPhone · Safari", "Windows · Chrome": enough to recognise a sign-in. */
export function describeDevice(userAgent = ''): string {
  const system = /iPhone/.test(userAgent) ? 'iPhone' : /iPad/.test(userAgent) ? 'iPad' : /Android/.test(userAgent) ? 'Android'
    : /Windows/.test(userAgent) ? 'Windows' : /Mac OS X|Macintosh/.test(userAgent) ? 'Mac' : /CrOS/.test(userAgent) ? 'Chromebook' : /Linux/.test(userAgent) ? 'Linux' : '';
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Haul\//.test(userAgent) ? 'Haul app'
    : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : '';
  return [system, browser].filter(Boolean).join(' · ') || 'A browser';
}

export function validPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 8 && password.length <= 256;
}
