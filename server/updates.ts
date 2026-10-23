import { VERSION } from './config.js';

const RELEASES = 'https://api.github.com/repos/Squipy411/haul/releases/latest';

export interface UpdateInfo {
  version: string;
  url: string;
}

export function newer(candidate: string, current: string): boolean {
  const parse = (value: string) => value.replace(/^v/, '').split('-')[0]!.split('.').map((part) => Number(part) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}

/** Checks GitHub for a newer release twice a day. Set HAUL_UPDATE_CHECK=false to turn it off. */
export class UpdateChecker {
  available: UpdateInfo | null = null;
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (process.env.HAUL_UPDATE_CHECK === 'false') return;
    const check = async () => {
      try {
        const response = await fetch(RELEASES, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': `Haul/${VERSION}`, Accept: 'application/vnd.github+json' } });
        if (!response.ok) return;
        const release = await response.json() as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean };
        if (!release.tag_name || release.draft || release.prerelease) return;
        this.available = newer(release.tag_name, VERSION) ? { version: release.tag_name.replace(/^v/, ''), url: release.html_url ?? 'https://github.com/Squipy411/haul/releases' } : null;
      } catch {
        // Offline or rate limited; try again later.
      }
    };
    setTimeout(check, 20_000).unref();
    this.timer = setInterval(check, 12 * 60 * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
