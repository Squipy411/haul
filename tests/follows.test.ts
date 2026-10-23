import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryItem, Meta, Release } from '../shared/types';
import { optionsFromEnv } from '../server/config';
import { FollowService, checkInterval, cleanFilter, matchesFilter } from '../server/follows';
import type { JobManager } from '../server/jobs';
import type { Library } from '../server/library';
import { Notifier } from '../server/notify';
import { parseRelease } from '../server/release';
import type { SearchService } from '../server/search';
import { SettingsService } from '../server/settings';
import type * as catalog from '../server/catalog';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const release = (name: string, extra: Partial<Release> = {}): Release => ({ hash: name.padEnd(40, '0').slice(0, 40), name, info: parseRelease(name), kind: 'episode', cached: true, origin: 'test', score: 50, ...extra });

function setup(episodes: Array<{ season: number; episode: number; released: number }>, found: () => Release[], extra: { type?: 'movie' | 'series'; released?: number; owned?: LibraryItem[] } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-follows-'));
  dirs.push(dataDir);
  const options = optionsFromEnv({ dataDir, defaults: { torboxApiKey: '', moviesDir: path.join(dataDir, 'm'), tvDir: path.join(dataDir, 't'), incompleteDir: path.join(dataDir, 'i'), publicUrl: '' } });
  const settings = new SettingsService(options);
  const meta: Meta = extra.type === 'movie' ? {
    id: 'tt33764258', type: 'movie', name: 'The Odyssey', year: 2026, seasons: [], episodes: [], released: new Date(extra.released ?? Date.now() - 90 * DAY).toISOString()
  } : {
    id: 'tt7587890', type: 'series', name: 'The Rookie', seasons: [1, 8],
    episodes: episodes.map(({ season, episode, released }) => ({ id: `tt7587890:${season}:${episode}`, season, episode, title: `Episode ${episode}`, released: new Date(released).toISOString() }))
  };
  const sent: Array<{ title: string }> = [];
  const notifier = { send: vi.fn(async (note: { title: string }) => { sent.push(note); return { ok: true }; }) } as unknown as Notifier;
  const create = vi.fn(() => ({ id: 'job-1' }));
  const search = { episode: vi.fn(async () => found()), movie: vi.fn(async () => found()) } as unknown as SearchService;
  const owned = extra.owned ?? [];
  const library = { ownedEpisodes: () => new Set<string>(), ownsMovie: () => owned.length > 0, byImdb: () => owned, items: owned } as unknown as Library;
  const service = new FollowService({
    options, settings, notifier, search, library,
    catalog: { meta: async () => meta } as unknown as typeof catalog,
    jobs: { create } as unknown as JobManager
  });
  return { service, meta, sent, create, search, settings };
}

describe('checkInterval', () => {
  it('checks often right after release and backs off', () => {
    expect(checkInterval(-2 * HOUR)).toBeNull();
    expect(checkInterval(10 * 60_000)).toBe(5 * 60_000);
    expect(checkInterval(3 * DAY)).toBe(30 * 60_000);
    expect(checkInterval(30 * DAY)).toBe(6 * HOUR);
    expect(checkInterval(90 * DAY)).toBeNull();
  });
});

describe('following a show', () => {
  it('ignores the back catalogue and notifies once when a new episode torrent appears', async () => {
    const now = Date.now();
    const { service, meta, sent, create, search } = setup(
      [{ season: 8, episode: 1, released: now - 30 * DAY }, { season: 8, episode: 2, released: now - 20 * 60_000 }],
      () => [release('The.Rookie.S08E02.1080p.WEB.h264')]
    );
    const follow = service.follow(meta, false);
    expect(follow.since).toEqual({ season: 8, episode: 1 });
    await service['tick']();
    expect(search.episode).toHaveBeenCalledTimes(1);
    expect(search.episode).toHaveBeenCalledWith('tt7587890', 8, 2, { fresh: true });
    expect(sent.map((note) => note.title)).toEqual(['The Rookie S08E02 is available']);
    expect(create).not.toHaveBeenCalled();

    await service['tick']();
    expect(sent).toHaveLength(1);
  });

  it('stays quiet until a torrent exists, and never counts camera copies', async () => {
    const now = Date.now();
    let results: Release[] = [];
    const { service, meta, sent } = setup([{ season: 8, episode: 2, released: now - 60_000 }], () => results);
    service.follow(meta, false);
    await service['tick']();
    expect(sent).toHaveLength(0);

    results = [release('The.Rookie.S08E02.HDCAM.x264')];
    vi.useFakeTimers({ now: now + 6 * 60_000, toFake: ['Date'] });
    await service['tick']();
    expect(sent).toHaveLength(0);
  });

  it('auto-downloads the preferred resolution straight away', async () => {
    const now = Date.now();
    const { service, meta, sent, create } = setup([{ season: 8, episode: 2, released: now - 60_000 }], () => [release('The.Rookie.S08E02.1080p.WEB.h264')]);
    service.follow(meta, true);
    await service['tick']();
    expect(create).toHaveBeenCalledTimes(1);
    expect(sent.map((note) => note.title)).toEqual(['The Rookie S08E02 is downloading']);
    expect(service.follows[0]!.found['8:2']!.downloadedAt).toBeTypeOf('number');
  });

  it('waits up to 12 hours for the preferred resolution, then takes the best there is', async () => {
    const now = Date.now();
    const { service, meta, sent, create } = setup([{ season: 8, episode: 2, released: now - 60_000 }], () => [release('The.Rookie.S08E02.720p.WEB.h264')]);
    service.follow(meta, true);
    await service['tick']();
    expect(create).not.toHaveBeenCalled();
    expect(sent.map((note) => note.title)).toEqual(['The Rookie S08E02 is out in 720p']);

    vi.useFakeTimers({ now: now + 13 * HOUR, toFake: ['Date'] });
    await service['tick']();
    expect(create).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)!.title).toBe('The Rookie S08E02 is downloading');
  });
});

describe('version filters', () => {
  const want = { resolutions: ['2160p' as const], sources: ['WEB-DL'], hdr: [] };

  it('matches only the chosen resolution and source; scene WEB counts as WEB-DL', () => {
    expect(matchesFilter(parseRelease('The.Odyssey.2026.2160p.AMZN.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX'), want)).toBe(true);
    expect(matchesFilter(parseRelease('The.Odyssey.2026.2160p.WEB.H265-SceneGroup'), want)).toBe(true);
    expect(matchesFilter(parseRelease('The.Odyssey.2026.2160p.WEBRip.x265-RARBG'), want)).toBe(false);
    expect(matchesFilter(parseRelease('The.Odyssey.2026.1080p.WEB-DL.H264-FLUX'), want)).toBe(false);
    expect(matchesFilter(parseRelease('The.Odyssey.2026.2160p.UHD.BluRay.REMUX.DV-FGT'), want)).toBe(false);
  });

  it('tells Dolby Vision, HDR10 and SDR apart', () => {
    const dv = { resolutions: [], sources: [], hdr: ['DV' as const] };
    const sdr = { resolutions: [], sources: [], hdr: ['SDR' as const] };
    expect(matchesFilter(parseRelease('Film.2026.2160p.WEB-DL.DV.H265'), dv)).toBe(true);
    expect(matchesFilter(parseRelease('Film.2026.2160p.WEB-DL.HDR10.H265'), dv)).toBe(false);
    expect(matchesFilter(parseRelease('Film.2026.2160p.WEB-DL.HDR10.H265'), sdr)).toBe(false);
    expect(matchesFilter(parseRelease('Film.2026.1080p.WEB-DL.H264'), sdr)).toBe(true);
  });

  it('drops unknown values and treats an empty filter as none', () => {
    expect(cleanFilter({ resolutions: ['2160p', '8K'], sources: ['WEB-DL', 'CAM'], hdr: 'DV' })).toEqual({ resolutions: ['2160p'], sources: ['WEB-DL'], hdr: [] });
    expect(cleanFilter({ resolutions: [], sources: [], hdr: [] })).toBeUndefined();
    expect(cleanFilter('4K')).toBeUndefined();
  });

  it('ignores every other version, then grabs the first 4K WEB-DL the moment it appears', async () => {
    const now = Date.now();
    let results = [release('The.Odyssey.2026.1080p.BluRay.x264-GROUP', { kind: 'movie' }), release('The.Odyssey.2026.2160p.WEBRip.x265', { kind: 'movie' }), release('The.Odyssey.2026.HDTS.x264', { kind: 'movie' })];
    const { service, meta, sent, create } = setup([], () => results, { type: 'movie' });
    service.follow(meta, true, want);
    await service['tick']();
    expect(sent).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();

    results = [...results, release('The.Odyssey.2026.2160p.AMZN.WEB-DL.DDP5.1.Atmos.DV.H.265-FLUX', { kind: 'movie', cached: false, score: -10 })];
    vi.useFakeTimers({ now: now + 21 * 60_000, toFake: ['Date'] });
    await service['tick']();
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0] as unknown as [{ release: Release }])[0].release.name).toContain('2160p.AMZN.WEB-DL');
    expect(sent.map((note) => note.title)).toEqual(['The Odyssey is downloading']);
  });

  it('still looks for 4K when only a 1080p copy is in the library', async () => {
    const owned = [{ files: [{ resolution: '1080p', tags: ['WEB-DL'] }] }] as unknown as LibraryItem[];
    const { service, meta, create } = setup([], () => [release('The.Odyssey.2026.2160p.WEB-DL.H265', { kind: 'movie' })], { type: 'movie', owned });
    service.follow(meta, true, want);
    await service['tick']();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('skips trailers, prologues and films from another year', async () => {
    const { service, meta, create } = setup([], () => [
      release('The.Odyssey.Official.Trailer.2026.2160p.WEB-DL.H265', { kind: 'movie' }),
      release('The.Odyssey.Prologue.2026.2160p.WEB-DL.H265', { kind: 'movie' }),
      release('The.Odyssey.1997.2160p.WEB-DL.H265', { kind: 'movie' })
    ], { type: 'movie' });
    service.follow(meta, true, want);
    await service['tick']();
    expect(create).not.toHaveBeenCalled();
  });

  it('starts over when the filter changes', async () => {
    const { service, meta } = setup([], () => [release('The.Odyssey.2026.1080p.WEB-DL.H264', { kind: 'movie' })], { type: 'movie' });
    const follow = service.follow(meta, false);
    await service['tick']();
    expect(follow.found.movie).toBeDefined();
    service.update(follow.id, { want });
    expect(follow.found.movie).toBeUndefined();
    await service['tick']();
    expect(follow.found.movie).toBeUndefined();
  });
});

describe('Notifier', () => {
  it('publishes to ntfy as JSON with a tap-through link', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-notify-'));
    dirs.push(dataDir);
    const options = optionsFromEnv({ dataDir, defaults: { torboxApiKey: '', moviesDir: dataDir, tvDir: dataDir, incompleteDir: dataDir, publicUrl: '' } });
    const settings = new SettingsService(options);
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const notifier = new Notifier(settings);
    notifier.baseUrl = 'http://10.0.0.5:60700';
    expect(await notifier.send({ title: 'Off by default', message: '' })).toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();

    settings.update({ notifications: { enabled: true } });
    const result = await notifier.send({ title: 'The Rookie S08E02 is available', message: '1080p', path: '/title/series/tt7587890?season=8' });

    expect(result.ok).toBe(true);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ntfy.sh');
    const body = JSON.parse(String(init.body));
    expect(body.topic).toBe(settings.value.notifications.ntfyTopic);
    expect(body.topic).toMatch(/^haul-[a-z0-9]{8,}$/);
    expect(body.click).toBe('http://10.0.0.5:60700/title/series/tt7587890?season=8');
    expect(body.actions[0]).toMatchObject({ action: 'view', url: body.click });
  });
});
