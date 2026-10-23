import fs from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { registerAddon } from './addon.js';
import { OPEN_ROUTES, registerApi } from './api.js';
import { Auth, isHttps } from './auth.js';
import { type ServerOptions, VERSION, optionsFromEnv } from './config.js';
import { type Context, HttpError, Router, compressSync, parseCookies, pickEncoding, readBody, requestBaseUrl, serveStatic } from './http.js';
import { JobManager } from './jobs.js';
import { Library } from './library.js';
import { MediaTools } from './media.js';
import { registerPlay } from './play.js';
import { SearchService } from './search.js';
import { SettingsService } from './settings.js';
import { Torbox, TorboxError } from './torbox.js';
import { Profiles } from './profiles.js';
import { Tunnel } from './tunnel.js';
import * as catalog from './catalog.js';
import { FollowService } from './follows.js';
import { Notifier } from './notify.js';
import { UpdateChecker } from './updates.js';

export interface RunningServer {
  port: number;
  url: string;
  /** Session cookie for the Windows app's own window (desktop mode only). */
  desktopSession: () => { name: string; value: string; expires: number };
  close: () => Promise<void>;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

let guarded = false;

export async function startServer(overrides: Partial<ServerOptions> = {}): Promise<RunningServer> {
  // A background check or one request that fails in an unexpected way is logged, rather than taking
  // the server (and every download in progress) down with it.
  if (!guarded) {
    guarded = true;
    process.on('unhandledRejection', (reason) => console.error('[haul] unexpected error, carrying on:', reason));
  }
  const options = optionsFromEnv(overrides);
  fs.mkdirSync(options.dataDir, { recursive: true });

  const settings = new SettingsService(options);
  // Lost the phone with the authenticator on it: start once with HAUL_RESET_TWO_FACTOR=1.
  if (process.env.HAUL_RESET_TWO_FACTOR === '1' && settings.value.totpSecret) {
    settings.setTotp({ secret: '', pending: '', usedStep: -1 });
    console.log('[haul] two-step sign-in is off (HAUL_RESET_TWO_FACTOR). Set it up again in Settings, then remove the variable.');
  }
  const auth = new Auth(settings, options.auth);
  const updates = new UpdateChecker();
  const torbox = new Torbox(() => settings.value.torboxApiKey);
  const search = new SearchService({ torbox, settings: () => ({ ...settings.publicView(), torboxApiKey: settings.value.torboxApiKey }) });
  const library = new Library(options, settings);
  const notifier = new Notifier(settings);
  const where = (job: { type: string; imdbId: string; season?: number }) => `/title/${job.type}/${job.imdbId}${job.season !== undefined ? `?season=${job.season}` : ''}`;
  const jobs = new JobManager({
    options,
    settings,
    torbox,
    onCompleted: (job) => {
      library.recordDownload(job);
      if (settings.value.notifications.downloadFinished) {
        void notifier.send({ title: `${job.title} is in your library`, message: job.label === 'Movie' ? 'Ready to watch.' : `${job.label} is ready to watch.`, path: where(job), priority: 3, tags: ['white_check_mark'] });
      }
    },
    onFailed: (job) => {
      if (settings.value.notifications.downloadFailed) {
        void notifier.send({ title: `${job.title}: download failed`, message: job.error ?? 'Open Haul to try again.', path: '/downloads', priority: 4, tags: ['warning'] });
      }
    }
  });
  const follows = new FollowService({ options, settings, catalog, search, jobs, library, notifier });

  const router = new Router();
  router.get('/health', (ctx) => ctx.json(200, { status: 'ok', version: VERSION }));
  registerAddon(router, { settings, library });
  const profiles = new Profiles(options.dataDir);
  let listeningPort = options.port;
  // When a quick link comes up (its address changes each time), your phone hears the new one.
  const tunnel = new Tunnel(() => listeningPort, (url) => {
    if (notifier.configured) void notifier.send({ title: 'Haul’s link from anywhere', message: url, url, priority: 3, tags: ['globe_with_meridians'] });
  });
  registerApi(router, { options, settings, auth, torbox, search, jobs, library, updates, follows, notifier, profiles, tunnel });
  const media = new MediaTools();
  const transcodes = registerPlay(router, { library, catalog, search, torbox, media, progress: (ctx) => profiles.progress(ctx), apiKey: () => settings.value.torboxApiKey });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://haul.local');
    const ctx: Context = {
      req,
      res,
      url,
      params: {},
      query: url.searchParams,
      cookies: parseCookies(req.headers.cookie),
      body: () => readBody(req),
      json: (status, data, headers = {}) => {
        if (res.headersSent) return;
        const text = Buffer.from(JSON.stringify(data));
        const type = 'application/json; charset=utf-8';
        const encoding = pickEncoding(req, type, text.length);
        const body = encoding ? compressSync(text, encoding) : text;
        res.writeHead(status, { 'Content-Type': type, 'Content-Length': String(body.length), ...(encoding ? { 'Content-Encoding': encoding, Vary: 'Accept-Encoding' } : {}), ...headers });
        res.end(req.method === 'HEAD' ? undefined : body);
      },
      baseUrl: requestBaseUrl(req)
    };
    // Reached over HTTPS: browsers stick to HTTPS for this address from now on.
    if (isHttps(ctx)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' });
        return res.end();
      }
      const match = router.match(req.method || 'GET', url.pathname);
      if (match) {
        ctx.params = match.params;
        if (url.pathname.startsWith('/api/')) {
          // Browsers can't send this header cross-site without a CORS preflight, which Haul never grants.
          if (!SAFE_METHODS.has(req.method || 'GET') && req.headers['x-haul-request'] !== '1') {
            return ctx.json(403, { error: 'Missing request header.' });
          }
          // A playing stream's own addresses work without the cookie, so an Apple TV (AirPlay) can fetch
          // them: each carries a random 96-bit session id, made only for a signed-in player, kept 12 hours.
          const playerStream = req.method === 'GET' && /^\/api\/play\/(torbox|local)\/[\w-]{16}\//.test(url.pathname);
          if (!OPEN_ROUTES.has(url.pathname) && !playerStream && !auth.isAuthenticated(ctx)) {
            return ctx.json(401, { error: 'Sign in to Haul first.' });
          }
        }
        await match.handler(ctx);
        return;
      }
      if (url.pathname.startsWith('/api/')) return ctx.json(404, { error: 'Not found' });
      if (serveStatic(options.webDir, ctx)) return;
      ctx.json(404, { error: 'Not found' });
    } catch (error) {
      // TorBox saying no (a refused key, a full queue) is TorBox's answer, not a fault in Haul.
      const status = error instanceof HttpError ? error.status : error instanceof TorboxError ? 502 : 500;
      if (status === 500) console.error(`[http] ${req.method} ${url.pathname}`, error);
      ctx.json(status, { error: (error as Error).message || 'Something went wrong' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  listeningPort = port;
  // Sharing that was on stays on across restarts (sign-in permitting).
  const remote = settings.value.remote;
  if (remote.mode !== 'off' && options.auth !== 'none' && settings.value.passwordHash) tunnel.start(remote.mode, { token: remote.token || undefined, hostname: remote.hostname || undefined });
  library.start();
  jobs.start();
  updates.start();
  follows.start();
  // Home's rows come from the catalog, cached for an hour: fetch them now and as each hour runs out,
  // so nobody waits for them.
  const warmCatalog = () => { void catalog.home().catch(() => undefined); };
  warmCatalog();
  const catalogTimer = setInterval(warmCatalog, 60 * 60_000 + 15_000);
  catalogTimer.unref();
  console.log(`[haul] v${VERSION} listening on http://${options.host === '0.0.0.0' ? 'localhost' : options.host}:${port}`);

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    desktopSession: () => {
      if (options.auth !== 'desktop') throw new Error('Desktop sessions are only for the Windows app.');
      return auth.mint('d');
    },
    close: async () => {
      tunnel.stop();
      updates.stop();
      follows.stop();
      jobs.stop();
      library.stop();
      transcodes.close();
      clearInterval(catalogTimer);
      profiles.flush();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry || process.env.HAUL_AUTOSTART === '1') {
  startServer().then((running) => {
    const shutdown = async () => { await running.close(); process.exit(0); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }).catch((error) => {
    console.error('[haul] failed to start', error);
    process.exit(1);
  });
}
