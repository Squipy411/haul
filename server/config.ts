import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthMode } from './auth.js';

export interface ServerOptions {
  port: number;
  host: string;
  dataDir: string;
  webDir: string;
  desktop: boolean;
  auth: AuthMode;
  defaults: {
    torboxApiKey: string;
    moviesDir: string;
    tvDir: string;
    incompleteDir: string;
    publicUrl: string;
  };
  owner?: { uid: number; gid: number };
}

export const VERSION = '1.7.0';

function numberEnv(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function optionsFromEnv(overrides: Partial<ServerOptions> = {}): ServerOptions {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mediaRoot = process.env.MEDIA_ROOT || '/media';
  const uid = numberEnv('PUID');
  const gid = numberEnv('PGID');
  return {
    port: Number(process.env.PORT || 60700),
    host: process.env.HOST || '0.0.0.0',
    dataDir: path.resolve(process.env.DATA_DIR || './data'),
    // dist/server.mjs serves dist/web; in development the server runs from source.
    webDir: process.env.WEB_DIR || path.resolve(here, 'web'),
    desktop: false,
    // HAUL_AUTH=none is only for installs behind a proxy that does its own login.
    auth: process.env.HAUL_AUTH === 'none' ? 'none' : 'password',
    defaults: {
      torboxApiKey: process.env.TORBOX_API_KEY || '',
      moviesDir: process.env.MOVIES_DIR || path.join(mediaRoot, 'Movies'),
      tvDir: process.env.TV_DIR || path.join(mediaRoot, 'TV Shows'),
      incompleteDir: process.env.INCOMPLETE_DIR || path.join(mediaRoot, 'downloads', '.haul-incomplete'),
      publicUrl: process.env.PUBLIC_URL || ''
    },
    owner: uid !== undefined && gid !== undefined ? { uid, gid } : undefined,
    ...overrides
  };
}
