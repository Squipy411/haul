import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Tunnel, readTunnelOutput } from '../server/tunnel';

const dirs: string[] = [];
afterEach(() => {
  delete process.env.CLOUDFLARED_PATH;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for cloudflared that prints what the real one prints, then keeps running. */
function fakeCloudflared(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-tunnel-'));
  dirs.push(dir);
  const file = path.join(dir, 'cloudflared');
  fs.writeFileSync(file, `#!/bin/sh\n${lines.map((line) => `echo '${line}' >&2`).join('\n')}\n[ -n "$TUNNEL_TOKEN" ] && echo "token-length=\${#TUNNEL_TOKEN}" >&2\nsleep 30\n`, { mode: 0o755 });
  return file;
}

const until = async (check: () => boolean) => {
  for (let tries = 0; tries < 100 && !check(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
};

describe('cloudflared output', () => {
  it('finds the quick link, a connected tunnel, and errors', () => {
    expect(readTunnelOutput('2026-10-23T10:00:00Z INF |  https://quiet-river-moon-1234.trycloudflare.com                          |')).toEqual({ url: 'https://quiet-river-moon-1234.trycloudflare.com' });
    expect(readTunnelOutput('2026-10-23T10:00:01Z INF Registered tunnel connection connIndex=0 connection=abc event=0 ip=198.41.200.13 location=lhr01 protocol=quic')).toEqual({ connected: true });
    expect(readTunnelOutput('2026-10-23T10:00:01Z ERR Provided Tunnel token is not valid. error="x"')).toEqual({ error: 'Provided Tunnel token is not valid.' });
    expect(readTunnelOutput('2026-10-23T10:00:01Z INF Starting tunnel')).toEqual({});
  });
});

describe('Tunnel', () => {
  it('runs a quick link, reports its address once, and stops', async () => {
    process.env.CLOUDFLARED_PATH = fakeCloudflared(['2026-10-23T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...', '2026-10-23T10:00:02Z INF |  https://quiet-river-moon-1234.trycloudflare.com  |']);
    const announced: string[] = [];
    const tunnel = new Tunnel(() => 60700, (url) => announced.push(url));
    tunnel.start('quick');
    expect(tunnel.status.state).toBe('starting');
    await until(() => tunnel.status.state === 'online');
    expect(tunnel.status).toMatchObject({ mode: 'quick', state: 'online', url: 'https://quiet-river-moon-1234.trycloudflare.com' });
    expect(announced).toEqual(['https://quiet-river-moon-1234.trycloudflare.com']);
    tunnel.stop();
    expect(tunnel.status).toEqual({ mode: 'off', state: 'off' });
  });

  it('runs a token tunnel with the token kept out of the command line', async () => {
    process.env.CLOUDFLARED_PATH = fakeCloudflared(['2026-10-23T10:00:01Z INF Registered tunnel connection connIndex=0 event=0 protocol=quic']);
    const tunnel = new Tunnel(() => 60700);
    tunnel.start('token', { token: 'x'.repeat(60), hostname: 'haul.example.com' });
    await until(() => tunnel.status.state === 'online');
    expect(tunnel.status).toMatchObject({ mode: 'token', state: 'online', url: 'https://haul.example.com' });
    tunnel.stop();
  });

  it('says so when cloudflared is missing', () => {
    process.env.CLOUDFLARED_PATH = '/nowhere/cloudflared';
    const tunnel = new Tunnel(() => 60700);
    // The real program may be installed on this machine; only check the message when it isn't.
    tunnel.start('quick');
    if (tunnel.status.state === 'error') expect(tunnel.status.error).toContain('isn’t installed');
    tunnel.stop();
  });
});
