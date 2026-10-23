import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Meta, Release } from '../shared/types';
import { optionsFromEnv } from '../server/config';
import { FollowService, checkInterval } from '../server/follows';
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

function setup(episodes: Array<{ season: number; episode: number; released: number }>, found: () => Release[]) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-follows-'));
  dirs.push(dataDir);
  const options = optionsFromEnv({ dataDir, defaults: { torboxApiKey: '', moviesDir: path.join(dataDir, 'm'), tvDir: path.join(dataDir, 't'), incompleteDir: path.join(dataDir, 'i'), publicUrl: '' } });
  const settings = new SettingsService(options);
  const meta: Meta = {
    id: 'tt7587890', type: 'series', name: 'The Rookie', seasons: [1, 8],
    episodes: episodes.map(({ season, episode, released }) => ({ id: `tt7587890:${season}:${episode}`, season, episode, title: `Episode ${episode}`, released: new Date(released).toISOString() }))
  };
  const sent: Array<{ title: string }> = [];
  const notifier = { send: vi.fn(async (note: { title: string }) => { sent.push(note); return { ok: true }; }) } as unknown as Notifier;
  const create = vi.fn(() => ({ id: 'job-1' }));
  const search = { episode: vi.fn(async () => found()), movie: vi.fn(async () => found()) } as unknown as SearchService;
  const library = { ownedEpisodes: () => new Set<string>(), ownsMovie: () => false, items: [] } as unknown as Library;
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
