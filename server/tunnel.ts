import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { RemoteStatus } from '../shared/types.js';

// "Share over the internet": Cloudflare's tunnel program connects out to Cloudflare and Cloudflare sends
// visitors back through it, so Haul gets a public HTTPS address with no router changes. A quick link needs
// no account (its address changes each time it starts); a tunnel token from a free Cloudflare account
// gives a permanent address on your own domain.

const PLACES = [
  '/usr/local/bin/cloudflared',
  '/usr/bin/cloudflared',
  '/opt/homebrew/bin/cloudflared',
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe'
];

export function findCloudflared(): string | null {
  for (const place of [process.env.CLOUDFLARED_PATH, ...PLACES]) if (place && fs.existsSync(place)) return place;
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8' });
  return probe.status === 0 ? probe.stdout.split(/\r?\n/)[0]!.trim() || null : null;
}

/** The address a quick tunnel prints, or that a tunnel is connected (token tunnels print no address). */
export function readTunnelOutput(line: string): { url?: string; connected?: boolean; error?: string } {
  const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line)?.[0];
  if (url) return { url };
  if (/Registered tunnel connection|Connection [0-9a-f-]+ registered/i.test(line)) return { connected: true };
  const error = / ERR (.+)$/.exec(line)?.[1]?.replace(/\s+\w+=\S+/g, '').trim();
  return error ? { error } : {};
}

export class Tunnel {
  private child: ChildProcess | null = null;
  private wanted: { mode: 'quick' | 'token'; token?: string; hostname?: string } | null = null;
  private retries = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private state: RemoteStatus = { mode: 'off', state: 'off' };

  constructor(private readonly port: () => number, private readonly onOnline: (url: string) => void = () => undefined) {}

  get status(): RemoteStatus {
    return this.state;
  }

  start(mode: 'quick' | 'token', options: { token?: string; hostname?: string } = {}): void {
    this.stop();
    this.wanted = { mode, ...options };
    this.retries = 0;
    this.launch();
  }

  stop(): void {
    this.wanted = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const child = this.child;
    this.child = null;
    child?.kill();
    this.state = { mode: 'off', state: 'off' };
  }

  private launch(): void {
    const wanted = this.wanted;
    if (!wanted) return;
    const program = findCloudflared();
    if (!program) {
      this.state = { mode: wanted.mode, state: 'error', error: 'Cloudflare’s tunnel program (cloudflared) isn’t installed here.' };
      return;
    }
    this.state = { mode: wanted.mode, state: 'starting', hostname: wanted.hostname };
    const args = wanted.mode === 'quick'
      ? ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port()}`]
      : ['tunnel', '--no-autoupdate', 'run'];
    // The token goes in the environment, not the command line, so it doesn't show in the process list.
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...(wanted.token ? { TUNNEL_TOKEN: wanted.token } : {}) } });
    this.child = child;
    let buffered = '';
    const read = (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const found = readTunnelOutput(line);
        if (found.url && wanted.mode === 'quick') {
          this.state = { mode: 'quick', state: 'online', url: found.url };
          this.retries = 0;
          this.onOnline(found.url);
        } else if (found.connected && wanted.mode === 'token' && this.state.state !== 'online') {
          this.state = { mode: 'token', state: 'online', hostname: wanted.hostname, url: wanted.hostname ? `https://${wanted.hostname}` : undefined };
          this.retries = 0;
        } else if (found.error && this.state.state !== 'online') {
          this.state = { ...this.state, error: found.error };
        }
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.on('error', (error) => { this.state = { mode: wanted.mode, state: 'error', error: error.message }; });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.wanted) return;
      // It stopped by itself: try again, waiting longer each time (5 s, 10 s, … up to 2 minutes).
      const wait = Math.min(120_000, 5_000 * 2 ** this.retries);
      this.retries += 1;
      this.state = { mode: wanted.mode, state: 'error', error: this.state.error ?? `The tunnel stopped (code ${code}). Trying again in ${Math.round(wait / 1000)} s.` };
      this.retryTimer = setTimeout(() => this.launch(), wait);
    });
  }
}
