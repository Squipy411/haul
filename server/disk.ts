import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DiskSpace } from '../shared/types.js';

/** The nearest folder that exists, so a library folder Haul hasn't created yet still has a disk. */
async function existingAncestor(dir: string): Promise<string> {
  let current = path.resolve(dir);
  for (;;) {
    try { if ((await fsp.stat(current)).isDirectory()) return current; } catch { /* keep climbing */ }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

export async function freeBytes(dir: string): Promise<number> {
  const stats = await fsp.statfs(await existingAncestor(dir));
  return stats.bavail * stats.bsize;
}

/** Free space on each disk the library and downloads use, one entry per disk. Cached for 30 seconds. */
export class DiskMonitor {
  private cached: { at: number; key: string; value: Promise<DiskSpace[]> } | null = null;

  read(folders: Array<{ label: string; dir: string }>): Promise<DiskSpace[]> {
    const key = JSON.stringify(folders);
    if (this.cached && this.cached.key === key && Date.now() - this.cached.at < 30_000) return this.cached.value;
    const value = this.measure(folders).catch(() => []);
    this.cached = { at: Date.now(), key, value };
    return value;
  }

  private async measure(folders: Array<{ label: string; dir: string }>): Promise<DiskSpace[]> {
    const byDevice = new Map<number, DiskSpace>();
    for (const { label, dir } of folders) {
      if (!dir) continue;
      try {
        const existing = await existingAncestor(dir);
        const [stat, fs] = await Promise.all([fsp.stat(existing), fsp.statfs(existing)]);
        const entry = byDevice.get(stat.dev);
        if (entry) { entry.labels.push(label); continue; }
        byDevice.set(stat.dev, { labels: [label], free: fs.bavail * fs.bsize, total: fs.blocks * fs.bsize });
      } catch { /* unreadable folder: leave it out */ }
    }
    return [...byDevice.values()];
  }
}
