import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from '../server/main';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function server() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-lists-'));
  dirs.push(dir);
  const running = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, webDir: dir, auth: 'none', defaults: { torboxApiKey: '', moviesDir: path.join(dir, 'm'), tvDir: path.join(dir, 't'), incompleteDir: path.join(dir, 'i'), publicUrl: '' } });
  const call = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`${running.url}${route}`, { method, headers: { 'X-Haul-Request': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { running, call };
}

describe('My list', () => {
  it('saves a title once, newest first, and removes it', async () => {
    const { running, call } = await server();
    try {
      await call('POST', '/api/watchlist', { type: 'series', imdbId: 'tt0903747', title: 'Breaking Bad' });
      await call('POST', '/api/watchlist', { type: 'movie', imdbId: 'tt0816692', title: 'Interstellar' });
      await call('POST', '/api/watchlist', { type: 'series', imdbId: 'tt0903747', title: 'Breaking Bad' });
      expect((await call('GET', '/api/watchlist')).data.items.map((item: { title: string }) => item.title)).toEqual(['Breaking Bad', 'Interstellar']);
      expect((await call('POST', '/api/watchlist', { type: 'series', imdbId: 'not-an-id' })).status).toBe(400);
      await call('DELETE', '/api/watchlist/series/tt0903747');
      expect((await call('GET', '/api/watchlist')).data.items.map((item: { title: string }) => item.title)).toEqual(['Interstellar']);
    } finally {
      await running.close();
    }
  });
});

describe('Marking as watched', () => {
  it('marks a season watched in episode order, and unmarks single episodes', async () => {
    const { running, call } = await server();
    try {
      const marked = await call('POST', '/api/progress/watched', { type: 'series', imdbId: 'tt0903747', title: 'Breaking Bad', episodes: [{ season: 1, episode: 2 }, { season: 1, episode: 1 }, { season: 1, episode: 3 }] });
      expect(marked.status).toBe(200);
      const items = marked.data.items as Array<{ episode: number; position: number; duration: number; updatedAt: number }>;
      expect(items.every((item) => item.position === item.duration)).toBe(true);
      // The last marked is the latest, so Continue watching picks up after episode 3.
      expect([...items].sort((a, b) => b.updatedAt - a.updatedAt)[0]!.episode).toBe(3);
      const unmarked = await call('POST', '/api/progress/watched', { type: 'series', imdbId: 'tt0903747', episodes: [{ season: 1, episode: 2 }], watched: false });
      expect(unmarked.data.items.map((item: { episode: number }) => item.episode).sort()).toEqual([1, 3]);
      expect((await call('POST', '/api/progress/watched', { type: 'series', imdbId: 'tt0903747', episodes: [] })).status).toBe(400);
      expect((await call('POST', '/api/progress/watched', { type: 'movie', imdbId: 'tt0816692', title: 'Interstellar' })).data.items).toHaveLength(1);
    } finally {
      await running.close();
    }
  });
});

describe('Profiles', () => {
  it('keeps each profile’s list and progress apart, and asks who is watching once there are two', async () => {
    const { running } = await server();
    const call = async (method: string, route: string, body?: unknown, cookie = '') => {
      const response = await fetch(`${running.url}${route}`, { method, headers: { 'X-Haul-Request': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
    };
    try {
      const alone = (await call('GET', '/api/status')).data;
      expect(alone.profiles).toHaveLength(1);
      // The first profile keeps working without picking anything.
      await call('POST', '/api/watchlist', { type: 'movie', imdbId: 'tt0816692', title: 'Interstellar' });

      const kid = (await call('POST', '/api/profiles', { name: '  Sam  ' })).data;
      expect(kid.name).toBe('Sam');
      expect((await call('GET', '/api/status')).data).toMatchObject({ profileChosen: false });
      const asKid = (await call('POST', '/api/profiles/select', { id: kid.id })).cookie;
      expect(asKid).toBe(`haul_profile=${kid.id}`);
      expect((await call('GET', '/api/status', undefined, asKid)).data).toMatchObject({ profileChosen: true, profile: { name: 'Sam' } });

      expect((await call('GET', '/api/watchlist', undefined, asKid)).data.items).toEqual([]);
      await call('POST', '/api/progress/watched', { type: 'movie', imdbId: 'tt0816692', title: 'Interstellar' }, asKid);
      expect((await call('GET', '/api/progress/history', undefined, asKid)).data.items).toHaveLength(1);
      expect((await call('GET', '/api/progress/history')).data.items).toHaveLength(0);
      expect((await call('GET', '/api/watchlist')).data.items).toHaveLength(1);

      expect((await call('DELETE', '/api/profiles/main')).status).toBe(400);
      await call('DELETE', `/api/profiles/${kid.id}`);
      // A browser still pointing at a removed profile falls back to the first one.
      expect((await call('GET', '/api/status', undefined, asKid)).data).toMatchObject({ profileChosen: false, profile: { id: 'main' } });
    } finally {
      await running.close();
    }
  });
});
