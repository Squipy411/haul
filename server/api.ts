import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Meta, MediaType, NewEpisodes, Release, SettingsPatch, SetupRequest, Status } from '../shared/types.js';
import { addonUrls } from './addon.js';
import { type Auth, clientIp, validPassword } from './auth.js';
import * as catalog from './catalog.js';
import { type ServerOptions, VERSION } from './config.js';
import { type Context, HttpError, type Router } from './http.js';
import type { JobManager } from './jobs.js';
import type { Library } from './library.js';
import type { SearchService } from './search.js';
import type { SettingsService } from './settings.js';
import type { Torbox } from './torbox.js';
import type { FollowService } from './follows.js';
import type { Notifier } from './notify.js';
import type { UpdateChecker } from './updates.js';

interface Deps {
  options: ServerOptions;
  settings: SettingsService;
  auth: Auth;
  torbox: Torbox;
  search: SearchService;
  jobs: JobManager;
  library: Library;
  updates: UpdateChecker;
  follows: FollowService;
  notifier: Notifier;
}

/** Routes that answer before sign-in. Setup routes also check that setup is actually open. */
export const OPEN_ROUTES = new Set(['/api/status', '/api/login', '/api/logout', '/api/setup', '/api/setup/defaults', '/api/setup/torbox-test']);

const asType = (value: string | undefined): MediaType => {
  if (value === 'movie' || value === 'series') return value;
  throw new HttpError(400, 'Type must be movie or series');
};
const asImdb = (value: string | undefined): string => {
  if (value && /^tt\d{5,10}$/.test(value)) return value;
  throw new HttpError(400, 'Unknown title id');
};
const asInt = (value: unknown, name: string): number => {
  const number = Number(value);
  if (Number.isInteger(number) && number >= 0 && number < 5000) return number;
  throw new HttpError(400, `Invalid ${name}`);
};

function isRelease(value: any): value is Release {
  return value && typeof value.hash === 'string' && /^[a-f0-9]{40}$/i.test(value.hash) && typeof value.name === 'string' && value.info && typeof value.kind === 'string';
}

function aired(released?: string): boolean {
  return !released || Date.parse(released) <= Date.now() + 12 * 60 * 60 * 1000;
}

export function registerApi(router: Router, deps: Deps): void {
  const { settings, auth, torbox, search, jobs, library, options, updates, follows, notifier } = deps;

  const withOwnership = (meta: Meta): Meta => {
    if (meta.type === 'series') {
      const owned = library.ownedEpisodes(meta.id);
      return { ...meta, inLibrary: owned.size > 0, episodes: meta.episodes.map((episode) => ({ ...episode, owned: owned.has(`${episode.season}:${episode.episode}`) })) };
    }
    const owned = library.ownsMovie(meta.id);
    return { ...meta, inLibrary: owned, ownedMovie: owned };
  };

  const status = (ctx: Context): Status => {
    const authenticated = auth.isAuthenticated(ctx);
    // Remember the address people use, so a tapped notification opens the same place.
    if (authenticated) notifier.baseUrl = ctx.baseUrl;
    return {
      version: VERSION,
      authenticated,
      needsPassword: auth.locked,
      passwordSet: Boolean(settings.value.passwordHash),
      canRemovePassword: auth.canRemovePassword,
      setupComplete: Boolean(settings.value.torboxApiKey) && !auth.locked,
      torboxConfigured: torbox.configured,
      // Signed-out visitors learn nothing about the library or queue.
      activeDownloads: authenticated ? jobs.activeCount() : 0,
      transferSpeed: authenticated ? jobs.jobs.reduce((sum, job) => sum + (job.status === 'downloading' ? job.speed : 0), 0) : 0,
      libraryCounts: authenticated ? library.counts() : { movies: 0, series: 0, episodes: 0 },
      desktop: options.desktop,
      update: authenticated ? updates.available : null
    };
  };

  router.get('/api/status', (ctx) => ctx.json(200, status(ctx), { 'Cache-Control': 'no-store' }));

  router.post('/api/login', async (ctx) => {
    const ip = clientIp(ctx);
    const wait = auth.waitFor(ip);
    if (wait > 0) return ctx.json(429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.` });
    const body = await ctx.body();
    if (!settings.value.passwordHash) {
      return ctx.json(400, { error: options.desktop ? 'No password is set. Set one in the Haul app under Settings → Password to sign in from other devices.' : 'Finish setup first.' });
    }
    if (typeof body.password !== 'string' || !settings.checkPassword(body.password)) {
      auth.recordFailure(ip);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return ctx.json(401, { error: 'Wrong password' });
    }
    auth.recordSuccess(ip);
    auth.startSession(ctx);
    ctx.json(200, { ok: true });
  });

  router.post('/api/logout', (ctx) => {
    auth.endSession(ctx);
    ctx.json(200, { ok: true });
  });

  // --- First-run setup ----------------------------------------------------------
  // Open while a server install has no password yet; afterwards only to signed-in users
  // who still need a TorBox key.
  const setupOpen = (ctx: Context) => auth.locked || (auth.isAuthenticated(ctx) && !settings.value.torboxApiKey);

  router.get('/api/setup/defaults', (ctx) => {
    if (!setupOpen(ctx)) throw new HttpError(403, 'Setup is already done.');
    ctx.json(200, { moviesDir: settings.value.moviesDir, tvDir: settings.value.tvDir, needsPassword: auth.locked });
  });

  router.post('/api/setup/torbox-test', async (ctx) => {
    if (!setupOpen(ctx)) throw new HttpError(403, 'Setup is already done.');
    const body = await ctx.body();
    if (typeof body.apiKey !== 'string' || !body.apiKey.trim()) throw new HttpError(400, 'Enter your TorBox API key.');
    ctx.json(200, await torbox.account(body.apiKey.trim()));
  });

  router.post('/api/setup', async (ctx) => {
    if (!setupOpen(ctx)) throw new HttpError(403, 'Setup is already done.');
    const body = await ctx.body() as SetupRequest;
    if (auth.locked && !validPassword(body.password)) throw new HttpError(400, 'Choose a password of at least 8 characters.');
    const key = typeof body.torboxApiKey === 'string' ? body.torboxApiKey.trim() : '';
    const account = await torbox.account(key);
    if (!account.ok) throw new HttpError(400, account.error ?? 'TorBox did not accept that key.');
    settings.update({ torboxApiKey: key, moviesDir: body.moviesDir, tvDir: body.tvDir });
    if (auth.locked) {
      settings.setPassword(body.password!);
      auth.startSession(ctx);
    }
    ctx.json(200, { ok: true, account });
  });

  // --- Settings ---------------------------------------------------------------
  router.get('/api/settings', (ctx) => ctx.json(200, settings.publicView()));

  router.put('/api/settings', async (ctx) => {
    const patch = await ctx.body() as SettingsPatch;
    ctx.json(200, settings.update(patch));
  });

  router.post('/api/password', async (ctx) => {
    const body = await ctx.body() as { current?: string; next?: string | null };
    const ip = clientIp(ctx);
    if (settings.value.passwordHash) {
      if (auth.waitFor(ip) > 0) throw new HttpError(429, 'Too many attempts. Wait a moment.');
      if (typeof body.current !== 'string' || !settings.checkPassword(body.current)) {
        auth.recordFailure(ip);
        throw new HttpError(401, 'Current password is wrong.');
      }
      auth.recordSuccess(ip);
    }
    if (body.next === null) {
      if (!auth.canRemovePassword) throw new HttpError(400, 'A server install always needs a password.');
      settings.setPassword(null);
      return ctx.json(200, { ok: true });
    }
    if (!validPassword(body.next)) throw new HttpError(400, 'Use at least 8 characters.');
    settings.setPassword(body.next);
    // Other browsers are signed out by the change; keep this one signed in.
    if (!options.desktop || ctx.cookies.haul_session?.startsWith('p.')) auth.startSession(ctx);
    ctx.json(200, { ok: true });
  });

  router.post('/api/settings/torbox-test', async (ctx) => {
    const body = await ctx.body();
    const key = typeof body.apiKey === 'string' && body.apiKey.trim() && !body.apiKey.includes('•') ? body.apiKey.trim() : undefined;
    ctx.json(200, await torbox.account(key));
  });

  router.post('/api/settings/check-folders', async (ctx) => {
    const value = settings.value;
    const check = (dir: string) => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, `.haul-write-test-${process.pid}`);
        fs.writeFileSync(probe, 'ok');
        fs.rmSync(probe);
        return { dir, ok: true };
      } catch (error) {
        return { dir, ok: false, error: (error as Error).message };
      }
    };
    ctx.json(200, { results: [check(value.moviesDir), check(value.tvDir), check(value.incompleteDir)] });
  });

  // --- Catalog ---------------------------------------------------------------
  router.get('/api/home', async (ctx) => {
    const rows = await catalog.home();
    const owned = library.ownedImdbIds();
    ctx.json(200, { rows: rows.map((row) => ({ ...row, items: row.items.map((item) => ({ ...item, inLibrary: owned.has(item.id) })) })) });
  });

  // Shows you own that have aired episodes after the newest one on disk.
  let newEpisodesCache: { at: number; value: NewEpisodes[] } | null = null;
  router.get('/api/new-episodes', async (ctx) => {
    if (newEpisodesCache && Date.now() - newEpisodesCache.at < 10 * 60_000) return ctx.json(200, { shows: newEpisodesCache.value });
    const ids = [...new Set(library.items.filter((item) => item.type === 'series' && item.imdbId).map((item) => item.imdbId!))].slice(0, 60);
    const shows: NewEpisodes[] = [];
    const queue = [...ids];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try {
          const meta = await catalog.meta('series', id);
          const owned = library.ownedEpisodes(id);
          let last = { season: 0, episode: 0 };
          for (const key of owned) {
            const [season, episode] = key.split(':').map(Number) as [number, number];
            if (season > 0 && (season > last.season || (season === last.season && episode > last.episode))) last = { season, episode };
          }
          if (!last.season) continue;
          const fresh = meta.episodes.filter((episode) => episode.season > 0 && aired(episode.released)
            && !owned.has(`${episode.season}:${episode.episode}`)
            && (episode.season > last.season || (episode.season === last.season && episode.episode > last.episode)));
          if (!fresh.length) continue;
          // Offer the first season that has new episodes; later seasons appear once that one is in.
          const season = fresh[0]!.season;
          const inSeason = fresh.filter((episode) => episode.season === season);
          shows.push({
            imdbId: id, name: meta.name, poster: meta.poster, background: meta.background, season,
            episodes: inSeason.map((episode) => ({ episode: episode.episode, title: episode.title, released: episode.released })),
            latest: inSeason[inSeason.length - 1]!.released ?? ''
          });
        } catch { /* skip titles the catalog can't describe */ }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    shows.sort((a, b) => b.latest.localeCompare(a.latest));
    newEpisodesCache = { at: Date.now(), value: shows };
    ctx.json(200, { shows });
  });

  router.get('/api/catalog/:type/:id', async (ctx) => {
    const type = asType(ctx.params.type);
    const id = ctx.params.id as 'top' | 'year' | 'imdbRating';
    if (!['top', 'year', 'imdbRating'].includes(id)) throw new HttpError(404, 'Unknown catalog');
    const items = await catalog.catalog(type, id, {
      genre: ctx.query.get('genre') || undefined,
      skip: Number(ctx.query.get('skip')) || undefined
    });
    const owned = library.ownedImdbIds();
    ctx.json(200, { items: items.map((item) => ({ ...item, inLibrary: owned.has(item.id) })) });
  });

  router.get('/api/search', async (ctx) => {
    const results = await catalog.search(ctx.query.get('q') || '');
    const owned = library.ownedImdbIds();
    const mark = (items: typeof results.movies) => items.map((item) => ({ ...item, inLibrary: owned.has(item.id) }));
    ctx.json(200, { movies: mark(results.movies), series: mark(results.series) });
  });

  router.get('/api/meta/:type/:id', async (ctx) => {
    const meta = await catalog.meta(asType(ctx.params.type), asImdb(ctx.params.id));
    ctx.json(200, { ...withOwnership(meta), follow: follows.find(meta.type, meta.id) ?? null });
  });

  // --- Releases ---------------------------------------------------------------
  router.get('/api/releases/movie/:id', async (ctx) => {
    ctx.json(200, { releases: await search.movie(asImdb(ctx.params.id)) });
  });

  router.get('/api/releases/series/:id/:season', async (ctx) => {
    const id = asImdb(ctx.params.id);
    const season = asInt(ctx.params.season, 'season');
    const meta = await catalog.meta('series', id);
    const episodes = meta.episodes.filter((episode) => episode.season === season);
    if (!episodes.length) throw new HttpError(404, 'That season has no episodes listed');
    ctx.json(200, { releases: await search.seasonPacks(id, season, episodes[0]!.episode, episodes.length) });
  });

  router.get('/api/releases/series/:id/:season/:episode', async (ctx) => {
    const id = asImdb(ctx.params.id);
    ctx.json(200, { releases: await search.episode(id, asInt(ctx.params.season, 'season'), asInt(ctx.params.episode, 'episode')) });
  });

  router.post('/api/plan/season', async (ctx) => {
    const body = await ctx.body();
    const id = asImdb(body.imdbId);
    const season = asInt(body.season, 'season');
    const meta = withOwnership(await catalog.meta('series', id));
    const inSeason = meta.episodes.filter((episode) => episode.season === season);
    const requested = Array.isArray(body.episodes) && body.episodes.length
      ? inSeason.filter((episode) => body.episodes.includes(episode.episode))
      : inSeason;
    const skipped: number[] = [];
    const wanted: number[] = [];
    for (const episode of requested) {
      if (!aired(episode.released) || (body.skipOwned !== false && episode.owned)) skipped.push(episode.episode);
      else wanted.push(episode.episode);
    }
    const plan = await search.planSeason(id, season, wanted);
    plan.skipped = skipped;
    ctx.json(200, plan);
  });

  // --- Downloads --------------------------------------------------------------
  router.get('/api/downloads', (ctx) => ctx.json(200, { jobs: jobs.jobs }));

  router.post('/api/downloads', async (ctx) => {
    const body = await ctx.body();
    const type = asType(body.type);
    const meta = await catalog.meta(type, asImdb(body.imdbId));
    const items: Array<{ release: unknown; season?: unknown; episodes?: unknown }> = Array.isArray(body.items) ? body.items : [body];
    if (!items.length || items.length > 200) throw new HttpError(400, 'Nothing to download');
    const groupId = items.length > 1 ? crypto.randomUUID() : undefined;
    const created = items.map((item) => {
      if (!isRelease(item.release)) throw new HttpError(400, 'Invalid release');
      const season = type === 'series' ? asInt(item.season, 'season') : undefined;
      const episodes = Array.isArray(item.episodes) ? item.episodes.map((value: unknown) => asInt(value, 'episode')) : undefined;
      return jobs.create({ meta, release: item.release, season, episodes, groupId });
    });
    ctx.json(200, { jobs: created });
  });

  router.post('/api/downloads/clear', (ctx) => { jobs.clearFinished(); ctx.json(200, { ok: true }); });

  router.post('/api/downloads/:id/:action', async (ctx) => {
    const id = ctx.params.id!;
    const action = ctx.params.action;
    const job = action === 'pause' ? jobs.pause(id)
      : action === 'resume' ? jobs.resume(id)
        : action === 'retry' ? jobs.retry(id)
          : action === 'cancel' ? await jobs.cancel(id)
            : (() => { throw new HttpError(404, 'Unknown action'); })();
    if (!job) throw new HttpError(404, 'Download not found');
    ctx.json(200, { job });
  });

  router.delete('/api/downloads/:id', async (ctx) => {
    await jobs.remove(ctx.params.id!);
    ctx.json(200, { ok: true });
  });

  // --- Follows, schedule, notifications --------------------------------------------
  router.get('/api/follows', (ctx) => ctx.json(200, { follows: follows.follows }));

  router.post('/api/follows', async (ctx) => {
    const body = await ctx.body();
    const meta = await catalog.meta(asType(body.type), asImdb(body.imdbId));
    ctx.json(200, { follow: follows.follow(meta, body.autoDownload === true), notificationsReady: notifier.configured });
  });

  router.post('/api/follows/:id', async (ctx) => {
    const body = await ctx.body();
    const follow = follows.update(ctx.params.id!, { autoDownload: body.autoDownload });
    if (!follow) throw new HttpError(404, 'Not following that');
    ctx.json(200, { follow });
  });

  router.delete('/api/follows/:id', (ctx) => {
    follows.unfollow(ctx.params.id!);
    ctx.json(200, { ok: true });
  });

  router.get('/api/schedule', async (ctx) => {
    ctx.json(200, { items: await follows.schedule(jobs.jobs) });
  });

  router.post('/api/notifications/test', async (ctx) => {
    const result = await notifier.send({ title: 'Haul is connected', message: 'Notifications from Haul will look like this.', path: '/upcoming', priority: 3, tags: ['white_check_mark'] });
    ctx.json(result.ok ? 200 : 400, result.ok ? { ok: true } : { error: result.error });
  });

  // --- Library ----------------------------------------------------------------
  router.get('/api/library', (ctx) => ctx.json(200, { items: library.summaries(), scanning: library.isScanning, scannedAt: library.scannedAt }));

  router.post('/api/library/scan', async (ctx) => {
    void library.scan();
    ctx.json(200, { ok: true });
  });

  router.get('/api/library/:id', (ctx) => {
    const item = library.get(ctx.params.id!);
    if (!item) throw new HttpError(404, 'Not in the library');
    ctx.json(200, item);
  });

  router.post('/api/library/:id/match', async (ctx) => {
    const body = await ctx.body();
    const imdbId = body.imdbId ? asImdb(body.imdbId) : null;
    const item = await library.setMatch(ctx.params.id!, imdbId);
    if (!item) throw new HttpError(404, 'Not in the library');
    ctx.json(200, item);
  });

  // --- Addon ----------------------------------------------------------------
  router.get('/api/addon', (ctx) => {
    ctx.json(200, { enabled: settings.value.addon.enabled, ...addonUrls(settings, ctx.baseUrl), baseUrlSource: settings.value.addon.publicUrl ? 'setting' : 'request' });
  });

  router.post('/api/addon/regenerate', (ctx) => {
    settings.regenerateAddonToken();
    ctx.json(200, { enabled: settings.value.addon.enabled, ...addonUrls(settings, ctx.baseUrl), baseUrlSource: settings.value.addon.publicUrl ? 'setting' : 'request' });
  });

}
