import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Auth, SESSION_COOKIE } from '../server/auth';
import { optionsFromEnv } from '../server/config';
import type { Context } from '../server/http';
import { startServer } from '../server/main';
import { SettingsService } from '../server/settings';

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
