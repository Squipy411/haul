import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '../server/main';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for a debrid service's download server: one file, with byte ranges. */
async function fileServer(bytes: Buffer) {
  const server = http.createServer((req, res) => {
    const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (!match) { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length }); return res.end(bytes); }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : bytes.length - 1;
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${bytes.length}` });
    res.end(bytes.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/film.mp4`, close: () => new Promise((resolve) => server.close(resolve)) };
}

describe('Playing from Real-Debrid', () => {
  it('tries versions until one is ready, removes the one that was not, and plays the link through Haul', { timeout: 30_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-remote-'));
    dirs.push(dir);
    const video = crypto.randomBytes(300_000);
    const cdn = await fileServer(video);
    const realFetch = globalThis.fetch;
    const uncached = 'c'.repeat(40);
    const cached = 'd'.repeat(40);
    const removed: string[] = [];
    const json = (value: unknown, status = 200) => new Response(value === null ? null : JSON.stringify(value), { status });
    const info = (id: string) => ({
      id, filename: id === 'RD-d' ? 'Interstellar.2014.720p' : 'Interstellar.2014.1080p', hash: id === 'RD-d' ? cached : uncached, bytes: video.length,
      progress: id === 'RD-d' ? 100 : 3, status: id === 'RD-d' ? 'downloaded' : 'downloading', speed: 1000,
      files: [{ id: 1, path: '/Interstellar.2014.mp4', bytes: video.length, selected: 1 }],
      links: id === 'RD-d' ? ['https://real-debrid.com/d/film'] : []
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === '127.0.0.1') return realFetch(input, init);
      const method = init.method ?? 'GET';
      if (url.hostname === 'v3-cinemeta.strem.io') {
        return url.pathname.startsWith('/meta/') ? json({ meta: { id: 'tt0816692', type: 'movie', name: 'Interstellar', year: 2014, releaseInfo: '2014' } }) : json({ metas: [] });
      }
      if (url.hostname === 'torrentio.strem.fun') {
        return json({ streams: [
          { infoHash: uncached, title: 'Interstellar.2014.1080p.WEB-DL.x264-GRP\n👤 90 💾 2.1 GB ⚙️ Test' },
          { infoHash: cached, title: 'Interstellar.2014.720p.WEB-DL.x264-GRP\n👤 40 💾 1.1 GB ⚙️ Test' }
        ] });
      }
      if (url.hostname === 'api.real-debrid.com') {
        const route = `${method} ${url.pathname.replace('/rest/1.0', '')}`;
        if (route === 'GET /torrents') return json([]);
        if (route === 'POST /torrents/addMagnet') {
          const magnet = new URLSearchParams(String(init.body)).get('magnet') ?? '';
          return json({ id: magnet.includes(cached) ? 'RD-d' : 'RD-c' }, 201);
        }
        if (route.startsWith('GET /torrents/info/')) return json(info(route.split('/').pop()!));
        if (route.startsWith('POST /torrents/selectFiles/')) return json(null, 204);
        if (route.startsWith('DELETE /torrents/delete/')) { removed.push(route.split('/').pop()!); return json(null, 204); }
        if (route === 'POST /unrestrict/link') return json({ download: cdn.url, filename: 'Interstellar.2014.mp4' });
      }
      return json({ error: 'not here' }, 404);
    }));

    const running = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, webDir: dir, auth: 'none', defaults: { torboxApiKey: '', moviesDir: path.join(dir, 'm'), tvDir: path.join(dir, 't'), incompleteDir: path.join(dir, 'i'), publicUrl: '' } });
    const call = async (method: string, route: string, body?: unknown, headers: Record<string, string> = {}) => realFetch(`${running.url}${route}`, { method, headers: { 'X-Haul-Request': '1', 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    try {
      await call('PUT', '/api/settings', { debridService: 'realdebrid', debridKeys: { realdebrid: 'rd-test-key' }, sources: { torrentsdb: false, torboxSearch: false } });
      const status = await (await call('GET', '/api/status')).json();
      expect(status).toMatchObject({ setupComplete: true, service: { id: 'realdebrid', name: 'Real-Debrid', checksCache: false }, torboxConfigured: true });

      const session = await (await call('POST', '/api/play', { type: 'movie', imdbId: 'tt0816692' })).json();
      expect(session).toMatchObject({ kind: 'remote', service: 'Real-Debrid', mode: 'direct', title: 'Interstellar' });
      // The 1080p version wasn't ready, so it was taken off the account again.
      expect(removed).toEqual(['RD-c']);

      const piece = await call('GET', session.url, undefined, { Range: 'bytes=1000-1999' });
      expect(piece.status).toBe(206);
      expect(piece.headers.get('content-range')).toBe(`bytes 1000-1999/${video.length}`);
      expect(Buffer.from(await piece.arrayBuffer()).equals(video.subarray(1000, 2000))).toBe(true);
    } finally {
      await running.close();
      await cdn.close();
    }
  });
});
