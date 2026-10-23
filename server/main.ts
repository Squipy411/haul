import fs from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { registerAddon } from './addon.js';
import { registerApi } from './api.js';
import { type ServerOptions, VERSION, optionsFromEnv } from './config.js';
import { type Context, HttpError, Router, parseCookies, readBody, requestBaseUrl, serveStatic } from './http.js';
import { JobManager } from './jobs.js';
import { Library } from './library.js';
import { SearchService } from './search.js';
import { SettingsService } from './settings.js';
import { Torbox } from './torbox.js';

export interface RunningServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

const OPEN_API = new Set(['/api/status', '/api/login', '/api/logout']);

export async function startServer(overrides: Partial<ServerOptions> = {}): Promise<RunningServer> {
  const options = optionsFromEnv(overrides);
  fs.mkdirSync(options.dataDir, { recursive: true });

  const settings = new SettingsService(options);
  const torbox = new Torbox(() => settings.value.torboxApiKey);
  const search = new SearchService({ torbox, settings: () => ({ ...settings.publicView(), torboxApiKey: settings.value.torboxApiKey }) });
  const library = new Library(options, settings);
  const jobs = new JobManager({ options, settings, torbox, onCompleted: (job) => library.recordDownload(job) });

  const router = new Router();
  router.get('/health', (ctx) => ctx.json(200, { status: 'ok', version: VERSION }));
  registerAddon(router, { settings, library });
  const { isAuthenticated } = registerApi(router, { options, settings, torbox, search, jobs, library });

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
        const body = JSON.stringify(data);
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(body)), ...headers });
        res.end(req.method === 'HEAD' ? undefined : body);
      },
      baseUrl: requestBaseUrl(req)
    };
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' });
        return res.end();
      }
      const match = router.match(req.method || 'GET', url.pathname);
      if (match) {
        ctx.params = match.params;
        if (url.pathname.startsWith('/api/') && !OPEN_API.has(url.pathname) && !isAuthenticated(ctx)) {
          return ctx.json(401, { error: 'Sign in to Haul first.' });
        }
        await match.handler(ctx);
        return;
      }
      if (url.pathname.startsWith('/api/')) return ctx.json(404, { error: 'Not found' });
      if (serveStatic(options.webDir, ctx)) return;
      ctx.json(404, { error: 'Not found' });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
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
  library.start();
  jobs.start();
  console.log(`[haul] v${VERSION} listening on http://${options.host === '0.0.0.0' ? 'localhost' : options.host}:${port}`);

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      jobs.stop();
      library.stop();
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
