import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROFILE_COLORS } from '../shared/profiles.js';
import type { Profile } from '../shared/types.js';
import { isHttps } from './auth.js';
import type { Context } from './http.js';
import { HttpError } from './http.js';
import { ProgressStore } from './progress.js';
import { JsonFile } from './store.js';
import { Watchlist } from './watchlist.js';

export const PROFILE_COOKIE = 'haul_profile';
const MAX_PROFILES = 8;
const MAIN = 'main';

/**
 * People in the house. Each has their own watching (progress, Continue watching, My list); the library,
 * downloads and settings are shared. The first profile keeps the files Haul used before profiles, so an
 * install that never adds a second one is unchanged.
 */
export class Profiles {
  private readonly file: JsonFile<{ profiles: Profile[] }>;
  private readonly progressStores = new Map<string, ProgressStore>();
  private readonly lists = new Map<string, Watchlist>();

  constructor(private readonly dataDir: string) {
    this.file = new JsonFile(path.join(dataDir, 'profiles.json'), () => ({ profiles: [{ id: MAIN, name: 'Me', color: PROFILE_COLORS[0]!, createdAt: Date.now() }] }));
  }

  list(): Profile[] {
    return this.file.data.profiles;
  }

  private fileFor(kind: 'progress' | 'watchlist', id: string): string {
    return id === MAIN ? `${kind}.json` : `${kind}-${id}.json`;
  }

  /** Whether this browser has picked a profile that still exists. */
  chosen(ctx: Context): boolean {
    return this.list().some((profile) => profile.id === ctx.cookies[PROFILE_COOKIE]);
  }

  /** The profile this browser picked; the first one until it picks (or if its pick was removed). */
  current(ctx: Context): Profile {
    return this.list().find((profile) => profile.id === ctx.cookies[PROFILE_COOKIE]) ?? this.list()[0]!;
  }

  progress(ctx: Context): ProgressStore {
    const id = this.current(ctx).id;
    let store = this.progressStores.get(id);
    if (!store) { store = new ProgressStore(this.dataDir, this.fileFor('progress', id)); this.progressStores.set(id, store); }
    return store;
  }

  watchlist(ctx: Context): Watchlist {
    const id = this.current(ctx).id;
    let list = this.lists.get(id);
    if (!list) { list = new Watchlist(this.dataDir, this.fileFor('watchlist', id)); this.lists.set(id, list); }
    return list;
  }

  /** Remembers the pick in this browser for a year. */
  select(ctx: Context, id: string): Profile {
    const profile = this.list().find((entry) => entry.id === id);
    if (!profile) throw new HttpError(404, 'That profile is gone. Pick another.');
    ctx.res.setHeader('Set-Cookie', `${PROFILE_COOKIE}=${profile.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${isHttps(ctx) ? '; Secure' : ''}`);
    return profile;
  }

  create(name: unknown, color: unknown): Profile {
    if (this.list().length >= MAX_PROFILES) throw new HttpError(400, `Haul has room for ${MAX_PROFILES} profiles.`);
    const profile: Profile = { id: crypto.randomBytes(6).toString('base64url'), name: cleanName(name), color: cleanColor(color, this.list().length), createdAt: Date.now() };
    this.file.data.profiles.push(profile);
    this.file.save();
    return profile;
  }

  update(id: string, change: { name?: unknown; color?: unknown }): Profile {
    const profile = this.list().find((entry) => entry.id === id);
    if (!profile) throw new HttpError(404, 'No such profile');
    if (change.name !== undefined) profile.name = cleanName(change.name);
    if (change.color !== undefined) profile.color = cleanColor(change.color, 0);
    this.file.save();
    return profile;
  }

  /** Removes a profile and its watching. The first profile stays, so there's always one. */
  remove(id: string): void {
    if (id === MAIN) throw new HttpError(400, "The first profile can't be removed. Rename it instead.");
    if (!this.list().some((entry) => entry.id === id)) throw new HttpError(404, 'No such profile');
    this.file.data.profiles = this.list().filter((entry) => entry.id !== id);
    this.file.save();
    this.progressStores.delete(id);
    this.lists.delete(id);
    for (const kind of ['progress', 'watchlist'] as const) fs.rmSync(path.join(this.dataDir, this.fileFor(kind, id)), { force: true });
  }

  flush(): void {
    this.file.flush();
    for (const store of this.progressStores.values()) store.flush();
    for (const list of this.lists.values()) list.flush();
  }
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 24) : '';
  if (!name) throw new HttpError(400, 'Give the profile a name.');
  return name;
}

function cleanColor(value: unknown, index: number): string {
  return typeof value === 'string' && PROFILE_COLORS.includes(value) ? value : PROFILE_COLORS[index % PROFILE_COLORS.length]!;
}
