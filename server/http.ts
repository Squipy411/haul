import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

export interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  cookies: Record<string, string>;
  body: () => Promise<any>;
  json: (status: number, data: unknown, headers?: Record<string, string>) => void;
  baseUrl: string;
}

export type Handler = (ctx: Context) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class Router {
  private routes: Route[] = [];

  add(method: string | string[], route: string, handler: Handler): void {
    const keys: string[] = [];
    const source = route
      .split('/')
      .map((segment) => {
        // ":name" matches a whole segment; ":name.json" matches a segment ending in .json
        const match = /^:([a-zA-Z]+)(\.[a-z]+)?$/.exec(segment);
        if (!match) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        keys.push(match[1]!);
        return match[2] ? `([^/]+?)${match[2].replace('.', '\\.')}` : '([^/]+)';
      })
      .join('/');
    for (const verb of Array.isArray(method) ? method : [method]) {
      this.routes.push({ method: verb, pattern: new RegExp(`^${source}$`), keys, handler });
    }
  }

  get(route: string, handler: Handler): void { this.add(['GET', 'HEAD'], route, handler); }
  post(route: string, handler: Handler): void { this.add('POST', route, handler); }
  put(route: string, handler: Handler): void { this.add('PUT', route, handler); }
  delete(route: string, handler: Handler): void { this.add('DELETE', route, handler); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, index) => {
        try { params[key] = decodeURIComponent(match[index + 1]!); } catch { params[key] = match[index + 1]!; }
      });
      return { handler: route.handler, params };
    }
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    try { cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); } catch { /* skip */ }
  }
  return cookies;
}

export function readBody(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new HttpError(400, 'Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

export function requestBaseUrl(req: IncomingMessage): string {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0]?.trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0]?.trim();
  const proto = forwardedProto || ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  const host = forwardedHost || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.ts': 'video/mp2t',
  '.srt': 'application/x-subrip; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8'
};

export function mimeType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Serves the built dashboard, falling back to index.html for client-side routes. */
export function serveStatic(webDir: string, ctx: Context): boolean {
  const { req, res, url } = ctx;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { return false; }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const resolved = path.resolve(webDir, `.${pathname}`);
  if (!resolved.startsWith(path.resolve(webDir))) return false;
  let file = resolved;
  let stat: fs.Stats | null = null;
  try { stat = fs.statSync(file); } catch { /* fall back to the app shell */ }
  if (!stat?.isFile()) {
    if (path.extname(pathname)) return false;
    file = path.join(webDir, 'index.html');
    try { stat = fs.statSync(file); } catch { return false; }
  }
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  const headers: Record<string, string> = {
    'Content-Type': mimeType(file),
    'Content-Length': String(stat.size),
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  };
  // Posters and backdrops come from catalog CDNs; everything else is served from here.
  if (file.endsWith('.html')) {
    headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; script-src 'self'; frame-ancestors 'self'; base-uri 'self'";
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
  return true;
}
