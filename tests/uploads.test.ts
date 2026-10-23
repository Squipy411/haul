import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from '../server/main';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function server() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-uploads-'));
  dirs.push(dir);
  const running = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, webDir: dir, auth: 'none', defaults: { torboxApiKey: '', moviesDir: path.join(dir, 'Movies'), tvDir: path.join(dir, 'TV'), incompleteDir: path.join(dir, 'incomplete'), publicUrl: '' } });
  const call = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`${running.url}${route}`, { method, headers: { 'X-Haul-Request': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const piece = async (id: string, offset: number, bytes: Buffer) => {
    const response = await fetch(`${running.url}/api/uploads/${id}?offset=${offset}`, { method: 'PUT', headers: { 'X-Haul-Request': '1', 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes) });
    return { status: response.status, data: await response.json() };
  };
  return { dir, running, call, piece };
}

/** A file of the given size that's quick to make and compare: zeros, with its size written at the start. */
function sample(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32BE(size, 0);
  bytes.writeUInt32BE(0xdeadbeef, size - 4);
  return bytes;
}

describe('Adding files from the browser', { timeout: 30_000 }, () => {
  it('takes a film in pieces, refuses one out of order, and files it under Movies', async () => {
    const { dir, running, call, piece } = await server();
    try {
      const file = sample(21 * 1024 * 1024);
      const started = await call('POST', '/api/uploads', { name: 'C:\\fakepath\\Big.Buck.Bunny.2008.1080p.BluRay.x264.mkv', size: file.length });
      expect(started.status).toBe(200);
      const { id } = started.data;
      const half = 11 * 1024 * 1024;
      expect((await piece(id, 0, file.subarray(0, half))).data).toEqual({ received: half });
      // Resending the first piece (say, after a timeout) is answered with where to carry on.
      expect(await piece(id, 0, file.subarray(0, half))).toEqual({ status: 409, data: { received: half, resumeFrom: half } });
      expect((await call('POST', `/api/uploads/${id}/finish`)).status).toBe(409);
      expect((await piece(id, half, file.subarray(half))).data).toEqual({ received: file.length });
      const done = await call('POST', `/api/uploads/${id}/finish`);
      expect(done.data).toEqual({ type: 'movie', title: 'Big Buck Bunny (2008)', file: 'Big Buck Bunny (2008).mkv' });
      const saved = path.join(dir, 'Movies', 'Big Buck Bunny (2008)', 'Big Buck Bunny (2008).mkv');
      expect(fs.readFileSync(saved).equals(file)).toBe(true);
      expect(fs.readdirSync(path.join(dir, 'incomplete', '.uploads'))).toEqual([]);
    } finally {
      await running.close();
    }
  });

  it('files an episode under its show and season, and turns away what it can’t place', async () => {
    const { dir, running, call, piece } = await server();
    try {
      const file = sample(20 * 1024 * 1024 + 5);
      const { data } = await call('POST', '/api/uploads', { name: 'severance.s01e04.1080p.web.h264.mkv', size: file.length });
      await piece(data.id, 0, file);
      expect((await call('POST', `/api/uploads/${data.id}/finish`)).data).toMatchObject({ type: 'series', file: 'Severance - S01E04.mkv' });
      expect(fs.existsSync(path.join(dir, 'TV', 'Severance', 'Season 01', 'Severance - S01E04.mkv'))).toBe(true);

      expect((await call('POST', '/api/uploads', { name: 'notes.txt', size: 50_000_000 })).status).toBe(400);
      expect((await call('POST', '/api/uploads', { name: 'sample.mkv', size: 1_000_000 })).data.error).toMatch(/too small/);
      expect((await call('POST', '/api/uploads', { name: 'Home video.mkv', size: 50_000_000, type: 'series' })).data.error).toMatch(/S01E04/);
      // A piece longer than the file is refused, and cancelling removes what arrived.
      const other = (await call('POST', '/api/uploads', { name: 'Film (2020).mp4', size: 21 * 1024 * 1024 })).data;
      expect((await piece(other.id, 0, sample(22 * 1024 * 1024))).status).toBe(400);
      await call('DELETE', `/api/uploads/${other.id}`);
      expect((await piece(other.id, 0, Buffer.alloc(10))).status).toBe(404);
    } finally {
      await running.close();
    }
  });
});
