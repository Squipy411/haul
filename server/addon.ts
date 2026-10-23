import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LibraryFile, LibraryItem, MediaType } from '../shared/types.js';
import { rawMeta } from './catalog.js';
import { VERSION } from './config.js';
import { type Context, type Router, mimeType, sendFile } from './http.js';
import type { Library } from './library.js';
import { formatBytes } from './release.js';
import type { SettingsService } from './settings.js';

// The personal media addon, rebuilt from Personal Media Addon / Nuvi-Flow:
// your library as Stremio/Nuvio catalogs, plus "Local file" streams on any
// title you own, served straight from disk with byte-range seeking.

const STREAM_TTL_MS = 48 * 60 * 60 * 1000;

const CATALOGS = [
  { type: 'movie', id: 'haul-movies', name: 'My Movies' },
  { type: 'series', id: 'haul-series', name: 'My Shows' },
  { type: 'movie', id: 'haul-recent-movies', name: 'Recently Added Movies' },
  { type: 'series', id: 'haul-recent-series', name: 'Recently Added Shows' }
] as const;

function sign(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url').slice(0, 32);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cors(ctx: Context): void {
  ctx.res.setHeader('Access-Control-Allow-Origin', '*');
  ctx.res.setHeader('Access-Control-Allow-Headers', '*');
}

function parseExtra(extra?: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const part of (extra || '').split('&')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    try { parsed[decodeURIComponent(part.slice(0, index))] = decodeURIComponent(part.slice(index + 1)); } catch { /* ignore */ }
  }
  return parsed;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]!));
}

export function registerAddon(router: Router, deps: { settings: SettingsService; library: Library }): void {
  const { settings, library } = deps;
  const base = (ctx: Context) => settings.value.addon.publicUrl || ctx.baseUrl;

  const authorised = (ctx: Context) => {
    const addon = settings.value.addon;
    if (!addon.enabled || !safeEqual(ctx.params.token ?? '', addon.token)) {
      cors(ctx);
      ctx.json(404, { err: 'Unknown addon' });
      return false;
    }
    cors(ctx);
    return true;
  };

  const previewOf = (item: LibraryItem, ctx: Context) => ({
    id: item.imdbId ?? `haul:${item.id}`,
    type: item.type,
    name: item.title,
    poster: item.poster ?? `${base(ctx)}/addon-poster/${item.id}.svg`,
    background: item.background,
    releaseInfo: item.year ? String(item.year) : undefined,
    posterShape: 'poster'
  });

  router.get('/addon/:token/manifest.json', (ctx) => {
    if (!authorised(ctx)) return;
    ctx.json(200, {
      id: 'community.haul.library',
      version: VERSION,
      name: settings.value.addon.name,
      description: 'Your own movies and shows, streamed straight from your server by Haul.',
      logo: `${base(ctx)}/icon.png`,
      resources: ['catalog', 'meta', 'stream'],
      types: ['movie', 'series'],
      idPrefixes: ['tt', 'haul:'],
      catalogs: CATALOGS.map((catalog) => ({
        ...catalog,
        extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
      })),
      behaviorHints: { configurable: false, configurationRequired: false }
    }, { 'Cache-Control': 'public, max-age=300' });
  });

  const catalogHandler = (ctx: Context) => {
    if (!authorised(ctx)) return;
    const definition = CATALOGS.find((catalog) => catalog.id === ctx.params.id && catalog.type === ctx.params.type);
    if (!definition) return ctx.json(200, { metas: [] });
    const extra = parseExtra(ctx.params.extra);
    const search = (extra.search || '').toLowerCase().trim();
    const skip = Math.max(0, Number(extra.skip) || 0);
    let items = library.items.filter((item) => item.type === definition.type);
    if (search) items = items.filter((item) => item.title.toLowerCase().includes(search));
    items = definition.id.includes('recent')
      ? items.sort((a, b) => b.addedAt - a.addedAt)
      : items.sort((a, b) => a.title.localeCompare(b.title));
    // One entry per title even if it lives in several folders.
    const seen = new Set<string>();
    const metas = items.map((item) => previewOf(item, ctx)).filter((meta) => (seen.has(meta.id) ? false : (seen.add(meta.id), true)));
    ctx.json(200, { metas: metas.slice(skip, skip + 100) }, { 'Cache-Control': 'public, max-age=60' });
  };
  router.get('/addon/:token/catalog/:type/:id.json', catalogHandler);
  router.get('/addon/:token/catalog/:type/:id/:extra.json', catalogHandler);

  const itemsFor = (type: MediaType, id: string): LibraryItem[] => {
    if (id.startsWith('haul:')) {
      const item = library.get(id.slice(5));
      return item && item.type === type ? [item] : [];
    }
    return library.byImdb(type, id);
  };

  router.get('/addon/:token/meta/:type/:id.json', async (ctx) => {
    if (!authorised(ctx)) return;
    const type = ctx.params.type as MediaType;
    const id = ctx.params.id!;
    if (type !== 'movie' && type !== 'series') return ctx.json(200, { meta: null });
    if (id.startsWith('tt')) {
      const meta = await rawMeta(type, id);
      if (meta) return ctx.json(200, { meta }, { 'Cache-Control': 'public, max-age=3600' });
    }
    const items = itemsFor(type, id);
    if (!items.length) return ctx.json(200, { meta: null });
    const item = items[0]!;
    const episodes = new Map<string, { season: number; episode: number }>();
    for (const file of items.flatMap((entry) => entry.files)) {
      if (file.season === undefined || file.episode === undefined) continue;
      for (let episode = file.episode; episode <= (file.episodeEnd ?? file.episode); episode += 1) {
        episodes.set(`${file.season}:${episode}`, { season: file.season, episode });
      }
    }
    ctx.json(200, {
      meta: {
        ...previewOf(item, ctx),
        id,
        description: `From your library: ${item.folder}`,
        videos: type === 'series'
          ? [...episodes.values()].sort((a, b) => a.season - b.season || a.episode - b.episode).map((entry) => ({
            id: `${id}:${entry.season}:${entry.episode}`,
            title: `Episode ${entry.episode}`,
            season: entry.season,
            episode: entry.episode,
            released: new Date(item.addedAt).toISOString()
          }))
          : undefined
      }
    });
  });

  router.get('/addon/:token/stream/:type/:id.json', (ctx) => {
    if (!authorised(ctx)) return;
    const type = ctx.params.type as MediaType;
    const raw = ctx.params.id!;
    let files: LibraryFile[] = [];
    if (type === 'movie') {
      files = itemsFor('movie', raw).flatMap((item) => item.files);
    } else if (type === 'series') {
      const match = /^(.*):(\d+):(\d+)$/.exec(raw);
      if (match) {
        const season = Number(match[2]);
        const episode = Number(match[3]);
        files = itemsFor('series', match[1]!).flatMap((item) => item.files)
          .filter((file) => file.season === season && file.episode !== undefined && file.episode <= episode && (file.episodeEnd ?? file.episode) >= episode);
      }
    }
    const secret = settings.value.streamSecret;
    const expires = Date.now() + STREAM_TTL_MS;
    const streams = files.sort((a, b) => b.size - a.size).map((file) => {
      const signature = sign(`${file.id}.${expires}`, secret);
      const name = path.basename(file.path);
      const quality = file.resolution && file.resolution !== 'unknown' ? (file.resolution === '2160p' ? '4K' : file.resolution) : 'Local';
      return {
        name: `Haul\n${quality}`,
        title: [name, [formatBytes(file.size), ...file.tags].join(' · ')].join('\n'),
        url: `${base(ctx)}/stream-file/${file.id}/${expires}/${signature}/${encodeURIComponent(name)}`,
        subtitles: file.subtitles.map((subtitle, index) => ({
          id: `${file.id}-${index}`,
          lang: subtitle.lang === 'und' ? 'eng' : subtitle.lang,
          url: `${base(ctx)}/stream-sub/${file.id}/${index}/${expires}/${signature}/subtitle.${path.extname(subtitle.path).slice(1) || 'srt'}`
        })),
        behaviorHints: { bingeGroup: `haul-${file.resolution ?? 'local'}`, filename: name, videoSize: file.size, notWebReady: !/\.(mp4|m4v|webm)$/i.test(name) }
      };
    });
    ctx.json(200, { streams }, { 'Cache-Control': 'no-store' });
  });

  const verifyStream = (ctx: Context) => {
    const expires = Number(ctx.params.expires);
    const expected = sign(`${ctx.params.fileId}.${expires}`, settings.value.streamSecret);
    if (!Number.isFinite(expires) || expires < Date.now() || !safeEqual(expected, ctx.params.signature ?? '')) return null;
    return library.lookupFile(ctx.params.fileId!) ?? null;
  };

  router.get('/stream-file/:fileId/:expires/:signature/:name', (ctx) => {
    cors(ctx);
    const found = verifyStream(ctx);
    if (!found) return ctx.json(401, { error: 'This stream link has expired. Reopen the title in Nuvio.' });
    sendFile(ctx, found.file.path);
  });

  router.get('/stream-sub/:fileId/:index/:expires/:signature/:name', (ctx) => {
    cors(ctx);
    const found = verifyStream(ctx);
    const subtitle = found?.file.subtitles[Number(ctx.params.index)];
    if (!subtitle) return ctx.json(404, { error: 'Subtitle not found' });
    try {
      const body = fs.readFileSync(subtitle.path);
      ctx.res.writeHead(200, { 'Content-Type': mimeType(subtitle.path), 'Content-Length': String(body.length), 'Cache-Control': 'private, max-age=3600' });
      ctx.res.end(body);
    } catch {
      ctx.json(404, { error: 'Subtitle not found' });
    }
  });

  router.get('/addon-poster/:id.svg', (ctx) => {
    const item = library.get(ctx.params.id!);
    const title = escapeXml(item?.title ?? 'Unknown title');
    const year = item?.year ? String(item.year) : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
<rect width="400" height="600" fill="#111111"/>
<text x="200" y="300" text-anchor="middle" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="30" font-weight="600" fill="#ffffff">${title.length > 22 ? `${title.slice(0, 21)}…` : title}</text>
<text x="200" y="340" text-anchor="middle" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="20" fill="#949494">${year}</text></svg>`;
    ctx.res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
    ctx.res.end(svg);
  });
}

export function addonUrls(settings: SettingsService, baseUrl: string): { manifestUrl: string; stremioUrl: string } {
  const root = settings.value.addon.publicUrl || baseUrl;
  const manifestUrl = `${root}/addon/${settings.value.addon.token}/manifest.json`;
  return { manifestUrl, stremioUrl: manifestUrl.replace(/^https?:\/\//, 'stremio://') };
}
