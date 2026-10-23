import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Meta, Release } from '../shared/types';
import { optionsFromEnv } from '../server/config';
import { JobManager } from '../server/jobs';
import { parseRelease } from '../server/release';
import { SettingsService } from '../server/settings';
import { type Debrid, DebridError, Services } from '../server/debrid';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-jobs-'));
  dirs.push(dataDir);
  const options = optionsFromEnv({ dataDir, defaults: { torboxApiKey: '', moviesDir: path.join(dataDir, 'm'), tvDir: path.join(dataDir, 't'), incompleteDir: path.join(dataDir, 'i'), publicUrl: '' } });
  const settings = new SettingsService(options);
  const remove = vi.fn(async () => undefined);
  const removeElsewhere = vi.fn(async () => undefined);
  const torbox = { id: 'torbox', name: 'TorBox', configured: false, remove } as unknown as Debrid;
  const realdebrid = { id: 'realdebrid', name: 'Real-Debrid', configured: false, remove: removeElsewhere } as unknown as Debrid;
  const debrid = new Services(() => settings.value.debridService, { torbox, realdebrid, alldebrid: torbox, premiumize: torbox });
  const jobs = new JobManager({ options, settings, debrid, onCompleted: () => undefined });
  return { jobs, remove, removeElsewhere, settings, torbox };
}

const meta: Meta = { id: 'tt0903747', type: 'series', name: 'Breaking Bad', year: 2008, seasons: [1], episodes: [1, 2].map((episode) => ({ id: `tt0903747:1:${episode}`, season: 1, episode, title: `E${episode}` })) };
const release: Release = { hash: 'a'.repeat(40), name: 'Breaking.Bad.S01.1080p', info: parseRelease('Breaking.Bad.S01.1080p'), kind: 'season', cached: true, origin: 'test', score: 0 };

describe('shared TorBox torrents', () => {
  it('keeps a torrent another download still needs, and removes it with the last one', async () => {
    const { jobs, remove } = setup();
    const first = jobs.create({ meta, release, season: 1, episodes: [1] });
    const second = jobs.create({ meta, release, season: 1, episodes: [2] });
    for (const job of [first, second]) { job.status = 'torbox'; job.torbox.id = 42; }
    first.torbox.createdByHaul = true;

    await jobs.cancel(first.id);
    expect(remove).not.toHaveBeenCalled();
    expect(second.torbox.createdByHaul).toBe(true);

    await jobs.cancel(second.id);
    expect(remove).toHaveBeenCalledWith(42);
    jobs.stop();
  });

  it('finishes a download on the service it was started on, after switching to another', async () => {
    const { jobs, remove, removeElsewhere, settings } = setup();
    settings.update({ debridService: 'realdebrid' });
    const job = jobs.create({ meta, release, season: 1 });
    Object.assign(job, { status: 'torbox', torbox: { service: 'realdebrid', id: 'RDID', createdByHaul: true } });
    settings.update({ debridService: 'torbox' });
    await jobs.cancel(job.id);
    expect(removeElsewhere).toHaveBeenCalledWith('RDID');
    expect(remove).not.toHaveBeenCalled();
    jobs.stop();
  });

  it('retry re-reads the torrent from TorBox instead of reusing stale links', () => {
    const { jobs } = setup();
    const job = jobs.create({ meta, release, season: 1 });
    job.status = 'failed';
    job.torbox.id = 7;
    job.files = [{ key: '1', torboxFileId: 1, name: 'x.mkv', size: 10, target: '/tmp/x.mkv', kind: 'video', downloaded: 5, status: 'failed', attempts: 5 }];
    jobs.retry(job.id);
    expect(job.status).toBe('torbox');
    expect(job.files).toEqual([]);
    expect(job.torbox.id).toBe(7);
    jobs.stop();
  });
});

describe('a refused TorBox key', () => {
  it('waits for a working key instead of failing the download', async () => {
    const { jobs, torbox } = setup();
    const refused = new DebridError("TorBox didn't accept your API key.", 'BAD_KEY', 403);
    Object.assign(torbox, { list: vi.fn(async () => { throw refused; }) });
    const job = jobs.create({ meta, release, season: 1 });
    await (jobs as unknown as { addToService: (job: unknown) => Promise<void> }).addToService(job);
    expect(job.status).toBe('queued');
    expect(job.note).toContain("didn't accept");
    expect(job.nextAttemptAt).toBeGreaterThan(Date.now());
    jobs.stop();
  });
});

