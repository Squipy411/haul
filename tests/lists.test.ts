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
