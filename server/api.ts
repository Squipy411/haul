import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Meta, MediaType, Release, SettingsPatch, Status } from '../shared/types.js';
import { addonUrls } from './addon.js';
import * as catalog from './catalog.js';
import { type ServerOptions, VERSION } from './config.js';
import { type Context, HttpError, type Router } from './http.js';
import type { JobManager } from './jobs.js';
import type { Library } from './library.js';
import type { SearchService } from './search.js';
import type { SettingsService } from './settings.js';
import type { Torbox } from './torbox.js';

interface Deps {
  options: ServerOptions;
  settings: SettingsService;
  torbox: Torbox;
  search: SearchService;
  jobs: JobManager;
  library: Library;
}

const SESSION_COOKIE = 'haul_session';
const SESSION_DAYS = 30;

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

export function registerApi(router: Router, deps: Deps): { isAuthenticated: (ctx: Context) => boolean } {
  const { settings, torbox, search, jobs, library, options } = deps;

  const sign = (value: string) => crypto.createHmac('sha256', settings.value.sessionSecret).update(value).digest('base64url');
  const isAuthenticated = (ctx: Context) => {
    if (!settings.value.passwordHash) return true;
    const cookie = ctx.cookies[SESSION_COOKIE];
    if (!cookie) return false;
    const [expires, signature] = cookie.split('.');
    if (!expires || !signature || Number(expires) < Date.now()) return false;
    const expected = sign(expires);
    return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  };
  const setSession = (ctx: Context) => {
    const expires = String(Date.now() + SESSION_DAYS * 86_400_000);
    ctx.res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${expires}.${sign(expires)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86_400}`);
  };

  const withOwnership = (meta: Meta): Meta => {
    if (meta.type === 'series') {
      const owned = library.ownedEpisodes(meta.id);
      return { ...meta, inLibrary: owned.size > 0, episodes: meta.episodes.map((episode) => ({ ...episode, owned: owned.has(`${episode.season}:${episode.episode}`) })) };
    }
    const owned = library.ownsMovie(meta.id);
    return { ...meta, inLibrary: owned, ownedMovie: owned };
  };

  router.get('/api/status', (ctx) => {
    const status: Status = {
      version: VERSION,
      authRequired: Boolean(settings.value.passwordHash),
      authenticated: isAuthenticated(ctx),
      setupComplete: Boolean(settings.value.torboxApiKey),
      torboxConfigured: torbox.configured,
      activeDownloads: jobs.activeCount(),
      libraryCounts: library.counts(),
      desktop: options.desktop
    };
    ctx.json(200, status);
  });

  router.post('/api/login', async (ctx) => {
    const body = await ctx.body();
    if (!settings.value.passwordHash) return ctx.json(200, { ok: true });
    if (typeof body.password !== 'string' || !settings.checkPassword(body.password)) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return ctx.json(401, { error: 'Wrong password' });
    }
    setSession(ctx);
    ctx.json(200, { ok: true });
  });

  router.post('/api/logout', (ctx) => {
    ctx.res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    ctx.json(200, { ok: true });
  });

  // --- Settings ---------------------------------------------------------------
  router.get('/api/settings', (ctx) => ctx.json(200, settings.publicView()));

  router.put('/api/settings', async (ctx) => {
    const patch = await ctx.body() as SettingsPatch;
    const hadPassword = Boolean(settings.value.passwordHash);
    const updated = settings.update(patch);
    if (!hadPassword && settings.value.passwordHash) setSession(ctx);
    ctx.json(200, updated);
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
    ctx.json(200, withOwnership(meta));
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

  return { isAuthenticated };
}
