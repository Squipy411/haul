import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Auth, SESSION_COOKIE, clientIp, isFromInternet, isHttps } from '../server/auth';
import { optionsFromEnv } from '../server/config';
import type { Context } from '../server/http';
import { startServer } from '../server/main';
import { SettingsService } from '../server/settings';
import { base32Decode, codeAt, stepAt } from '../server/totp';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-auth-')); dirs.push(dir); return dir; };
const defaults = (dir: string) => ({ torboxApiKey: '', moviesDir: path.join(dir, 'm'), tvDir: path.join(dir, 't'), incompleteDir: path.join(dir, 'i'), publicUrl: '' });
const withCookie = (value?: string) => ({ cookies: value ? { [SESSION_COOKIE]: value } : {} }) as unknown as Context;

describe('Auth', () => {
  it('locks a server install until a password exists', () => {
    const dir = tempDir();
    const settings = new SettingsService(optionsFromEnv({ dataDir: dir, defaults: defaults(dir) }));
    const auth = new Auth(settings, 'password');
    expect(auth.locked).toBe(true);
    expect(auth.isAuthenticated(withCookie())).toBe(false);
    settings.setPassword('correct horse');
    expect(auth.locked).toBe(false);
  });

  it('signs everyone out when the password changes', () => {
    const dir = tempDir();
    const settings = new SettingsService(optionsFromEnv({ dataDir: dir, defaults: defaults(dir) }));
    const auth = new Auth(settings, 'password');
    settings.setPassword('first password');
    const session = auth.mint('p').value;
    expect(auth.isAuthenticated(withCookie(session))).toBe(true);
    expect(auth.isAuthenticated(withCookie(`${session}x`))).toBe(false);
    settings.setPassword('second password');
    expect(auth.isAuthenticated(withCookie(session))).toBe(false);
  });

  it('only accepts app-window sessions in desktop mode', () => {
    const dir = tempDir();
    const settings = new SettingsService(optionsFromEnv({ dataDir: dir, defaults: defaults(dir) }));
    const desktop = new Auth(settings, 'desktop');
    const server = new Auth(settings, 'password');
    const session = desktop.mint('d').value;
    expect(desktop.isAuthenticated(withCookie(session))).toBe(true);
    expect(server.isAuthenticated(withCookie(session))).toBe(false);
  });

  it('slows down repeated wrong passwords', () => {
    const dir = tempDir();
    const auth = new Auth(new SettingsService(optionsFromEnv({ dataDir: dir, defaults: defaults(dir) })), 'password');
    for (let attempt = 0; attempt < 4; attempt += 1) auth.recordFailure('1.2.3.4');
    expect(auth.waitFor('1.2.3.4')).toBe(0);
    auth.recordFailure('1.2.3.4');
    expect(auth.waitFor('1.2.3.4')).toBeGreaterThan(0);
    expect(auth.waitFor('5.6.7.8')).toBe(0);
  });
});

describe('HTTP gate', () => {
  it('keeps everything but setup closed on a fresh server install', async () => {
    const dir = tempDir();
    const server = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, webDir: dir, defaults: defaults(dir) });
    try {
      const status = await (await fetch(`${server.url}/api/status`)).json();
      expect(status).toMatchObject({ needsPassword: true, authenticated: false, setupComplete: false });
      expect((await fetch(`${server.url}/api/settings`)).status).toBe(401);
      expect((await fetch(`${server.url}/api/downloads`)).status).toBe(401);
      expect((await fetch(`${server.url}/api/setup/defaults`)).status).toBe(200);
      // A cross-site form post can't add the custom header, so it is refused before anything else.
      expect((await fetch(`${server.url}/api/setup`, { method: 'POST', body: '{}' })).status).toBe(403);
      const weak = await fetch(`${server.url}/api/setup`, { method: 'POST', headers: { 'X-Haul-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'short', torboxApiKey: 'x' }) });
      expect(weak.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('serves pages with a content security policy', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Haul</title>');
    const server = await startServer({ port: 0, host: '127.0.0.1', dataDir: path.join(dir, 'data'), webDir: dir, defaults: defaults(dir) });
    try {
      const response = await fetch(`${server.url}/library`);
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect((await fetch(`${server.url}/%E0%A4%A`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe('behind a tunnel', () => {
  const request = (peer: string, headers: Record<string, string> = {}) => ({ req: { socket: { remoteAddress: peer }, headers } }) as unknown as Context;

  it('uses the address the tunnel added, and only from a tunnel on this network', () => {
    // Tailscale Funnel or cloudflared next to Haul: the visitor's own header can't hide them.
    expect(clientIp(request('172.18.0.3', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }))).toBe('203.0.113.9');
    expect(isFromInternet(request('172.18.0.3', { 'x-forwarded-for': '203.0.113.9' }))).toBe(true);
    // Straight from the internet (a forwarded port), the header is the visitor's own and is ignored.
    expect(clientIp(request('203.0.113.9', { 'x-forwarded-for': '10.0.0.5' }))).toBe('203.0.113.9');
    expect(clientIp(request('::ffff:10.0.0.20'))).toBe('10.0.0.20');
    expect(isFromInternet(request('10.0.0.20'))).toBe(false);
    expect(isFromInternet(request('100.101.102.103'))).toBe(false);
  });

  it('marks the session cookie Secure only over HTTPS', () => {
    const dir = tempDir();
    const settings = new SettingsService(optionsFromEnv({ dataDir: dir, defaults: defaults(dir) }));
    settings.setPassword('correct horse');
    const auth = new Auth(settings, 'password');
    const cookieFor = (ctx: Context) => {
      let cookie = '';
      auth.startSession({ ...ctx, res: { setHeader: (_name: string, value: string) => { cookie = value; } } } as unknown as Context);
      return cookie;
    };
    expect(isHttps(request('172.18.0.3', { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' }))).toBe(true);
    expect(cookieFor(request('172.18.0.3', { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' }))).toContain('; Secure');
    expect(cookieFor(request('10.0.0.20'))).not.toContain('Secure');
    expect(isHttps(request('203.0.113.9', { 'x-forwarded-proto': 'https' }))).toBe(false);
  });

  it('slows everyone down when wrong passwords come from many addresses', () => {
    const dir = tempDir();
    const auth = new Auth(new SettingsService(optionsFromEnv({ dataDir: dir, defaults: defaults(dir) })), 'password');
    for (let n = 0; n < 29; n += 1) auth.recordFailure(`198.51.100.${n}`);
    expect(auth.waitFor('192.0.2.1')).toBe(0);
    auth.recordFailure('198.51.100.200');
    expect(auth.waitFor('192.0.2.1')).toBeGreaterThan(50_000);
  });

  it('ends every other session with Sign out everywhere', () => {
    const dir = tempDir();
    const settings = new SettingsService(optionsFromEnv({ dataDir: dir, defaults: defaults(dir) }));
    settings.setPassword('correct horse');
    const auth = new Auth(settings, 'password');
    const before = auth.mint('p').value;
    settings.newSessionGeneration();
    expect(auth.isAuthenticated(withCookie(before))).toBe(false);
    expect(auth.isAuthenticated(withCookie(auth.mint('p').value))).toBe(true);
  });
});

describe('two-step sign-in', () => {
  it('asks for the code with the password, refuses a reused one, and can be turned off', async () => {
    const dir = tempDir();
    const options = { port: 0, host: '127.0.0.1', dataDir: dir, webDir: dir, defaults: { ...defaults(dir), torboxApiKey: 'test-key' } };
    new SettingsService(optionsFromEnv(options)).setPassword('correct horse');
    const server = await startServer(options);
    const post = (route: string, body: unknown, cookie = '') => fetch(`${server.url}${route}`, { method: 'POST', headers: { 'X-Haul-Request': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    const twoFactor = async () => (await (await fetch(`${server.url}/api/status`)).json()).twoFactor;
    try {
      const cookie = (await post('/api/login', { password: 'correct horse' })).headers.get('set-cookie')!.split(';')[0]!;
      expect((await post('/api/two-factor/start', { password: 'wrong' }, cookie)).status).toBe(401);
      const started = await (await post('/api/two-factor/start', { password: 'correct horse' }, cookie)).json();
      expect(started.url).toMatch(/^otpauth:\/\/totp\/Haul%3A127\.0\.0\.1\?secret=[A-Z2-7]{32}&issuer=Haul/);
      const secret = base32Decode(started.secret);
      expect((await post('/api/two-factor/confirm', { code: '000000' }, cookie)).status).toBe(400);
      const first = codeAt(secret, stepAt());
      expect((await post('/api/two-factor/confirm', { code: first }, cookie)).status).toBe(200);
      expect(await twoFactor()).toBe(true);

      // The password alone, or a code used already, isn't enough, and the message never says which was wrong.
      const noCode = await post('/api/login', { password: 'correct horse' });
      expect(noCode.status).toBe(401);
      expect((await noCode.json()).error).toBe('Wrong password or code.');
      expect((await post('/api/login', { password: 'correct horse', code: first })).status).toBe(401);
      expect((await post('/api/login', { password: 'correct horse', code: codeAt(secret, stepAt() + 1) })).status).toBe(200);

      expect((await post('/api/two-factor/off', { password: 'correct horse', code: '000000' }, cookie)).status).toBe(401);
      expect((await post('/api/two-factor/off', { password: 'correct horse', code: codeAt(secret, stepAt()) }, cookie)).status).toBe(200);
      expect(await twoFactor()).toBe(false);
    } finally {
      await server.close();
    }
  });
});

describe('sign-in alerts', () => {
  it('tells your phone about a new sign-in and about an address paused for wrong passwords', async () => {
    const received: Array<{ title: string; message: string }> = [];
    const ntfy = http.createServer((req, res) => {
      let text = '';
      req.on('data', (chunk) => { text += chunk; });
      req.on('end', () => { received.push(JSON.parse(text)); res.end('{}'); });
    });
    await new Promise<void>((resolve) => ntfy.listen(0, '127.0.0.1', resolve));
    const dir = tempDir();
    const options = { port: 0, host: '127.0.0.1', dataDir: dir, webDir: dir, defaults: { ...defaults(dir), torboxApiKey: 'test-key' } };
    const settings = new SettingsService(optionsFromEnv(options));
    settings.setPassword('correct horse');
    settings.update({ notifications: { enabled: true, ntfyServer: `http://127.0.0.1:${(ntfy.address() as { port: number }).port}`, ntfyTopic: 'test-topic' } });
    const server = await startServer(options);
    const login = (password: string) => fetch(`${server.url}/api/login`, {
      method: 'POST',
      headers: { 'X-Haul-Request': '1', 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9', 'X-Forwarded-Proto': 'https', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1' },
      body: JSON.stringify({ password })
    });
    try {
      expect((await login('correct horse')).status).toBe(200);
      for (let attempt = 0; attempt < 5; attempt += 1) await login('wrong');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received.map((note) => note.title)).toEqual(['New sign-in to Haul', 'Haul paused sign-ins from one address']);
      expect(received[0]!.message).toBe('iPhone · Safari from 203.0.113.9, over the internet');
      expect(received[1]!.message).toContain('203.0.113.9');
    } finally {
      await server.close();
      ntfy.close();
    }
  });
});

