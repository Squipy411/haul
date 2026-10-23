import path from 'node:path';
import type { MediaType, WatchlistItem } from '../shared/types.js';
import { JsonFile } from './store.js';

const LIMIT = 500;

/** "My list": titles saved to watch later, newest first. */
export class Watchlist {
  private readonly file: JsonFile<{ items: WatchlistItem[] }>;

  constructor(dataDir: string) {
    this.file = new JsonFile(path.join(dataDir, 'watchlist.json'), () => ({ items: [] }));
  }

  list(): WatchlistItem[] {
    return [...this.file.data.items].sort((a, b) => b.addedAt - a.addedAt);
  }

  has(type: MediaType, imdbId: string): boolean {
    return this.file.data.items.some((item) => item.type === type && item.imdbId === imdbId);
  }

  add(item: Omit<WatchlistItem, 'addedAt'>): WatchlistItem {
    const saved = { ...item, addedAt: Date.now() };
    this.file.data.items = [saved, ...this.file.data.items.filter((entry) => !(entry.type === item.type && entry.imdbId === item.imdbId))].slice(0, LIMIT);
    this.file.save();
    return saved;
  }

  remove(type: MediaType, imdbId: string): void {
    this.file.data.items = this.file.data.items.filter((entry) => !(entry.type === type && entry.imdbId === imdbId));
    this.file.save();
  }

  flush(): void {
    this.file.flush();
  }
}
