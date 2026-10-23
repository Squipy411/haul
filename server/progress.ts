import path from 'node:path';
import type { MediaType, WatchProgress } from '../shared/types.js';
import { JsonFile } from './store.js';

/** Under this many seconds in, a title hasn't really been started. */
const STARTED = 60;
/** Past this share of the running time, it counts as watched (credits). */
const FINISHED = 0.92;

export const progressKey = (type: MediaType, imdbId: string, season?: number, episode?: number) =>
  type === 'series' ? `series:${imdbId}:${season}:${episode}` : `movie:${imdbId}`;

export const isFinished = (entry: Pick<WatchProgress, 'position' | 'duration'>) => entry.duration > 0 && entry.position / entry.duration >= FINISHED;

/** Where you got to in everything you've watched in Haul's player. */
export class ProgressStore {
  private readonly file: JsonFile<{ items: Record<string, WatchProgress> }>;
  /** Saves get strictly increasing times, so "latest" is never a tie. */
  private last = 0;

  constructor(dataDir: string) {
    this.file = new JsonFile(path.join(dataDir, 'progress.json'), () => ({ items: {} }));
  }

  get(key: string): WatchProgress | undefined {
    return this.file.data.items[key];
  }

  /** Seconds to resume from, or undefined to start at the beginning. */
  resumeAt(key: string): number | undefined {
    const entry = this.get(key);
    return entry && entry.position >= STARTED && !isFinished(entry) ? Math.max(0, entry.position - 3) : undefined;
  }

  save(entry: Omit<WatchProgress, 'updatedAt'>): WatchProgress {
    this.last = Math.max(Date.now(), this.last + 1);
    const saved = { ...entry, updatedAt: this.last };
    this.file.data.items[entry.key] = saved;
    // Keep the store small: the latest 500 titles are plenty for Continue watching.
    const keys = Object.keys(this.file.data.items);
    if (keys.length > 500) {
      for (const key of keys.sort((a, b) => this.file.data.items[a]!.updatedAt - this.file.data.items[b]!.updatedAt).slice(0, keys.length - 500)) delete this.file.data.items[key];
    }
    this.file.save();
    return saved;
  }

  remove(key: string): void {
    delete this.file.data.items[key];
    this.file.save();
  }

  /** Started and unfinished titles, newest first; for a show, only its latest episode. */
  recent(limit = 30): WatchProgress[] {
    const latest = new Map<string, WatchProgress>();
    for (const entry of Object.values(this.file.data.items).sort((a, b) => b.updatedAt - a.updatedAt)) {
      const title = `${entry.type}:${entry.imdbId}`;
      if (!latest.has(title)) latest.set(title, entry);
    }
    return [...latest.values()].filter((entry) => entry.position >= STARTED || isFinished(entry)).slice(0, limit);
  }

  flush(): void {
    this.file.flush();
  }
}
