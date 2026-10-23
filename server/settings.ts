import crypto from 'node:crypto';
import path from 'node:path';
import type { Settings, SettingsPatch } from '../shared/types.js';
import type { ServerOptions } from './config.js';
import { JsonFile } from './store.js';

interface StoredSettings extends Omit<Settings, 'passwordSet'> {
  passwordHash: string;
  sessionSecret: string;
  streamSecret: string;
}

export const MASK = '••••••••';

function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function defaults(options: ServerOptions): StoredSettings {
  return {
    torboxApiKey: options.defaults.torboxApiKey,
    moviesDir: options.defaults.moviesDir,
    tvDir: options.defaults.tvDir,
    incompleteDir: options.defaults.incompleteDir,
    extraLibraryDirs: [],
    sources: {
      torrentio: true,
      torrentioUrl: 'https://torrentio.strem.fun',
      torboxSearch: true,
      addons: []
    },
    quality: {
      preferred: '1080p',
      maxEpisodeGB: 0,
      maxMovieGB: 0,
      preferCached: true,
      allowHdr: true,
      allowUpscaled: false,
      blockedWords: []
    },
    downloads: {
      concurrentFiles: 3,
      removeFromTorbox: false,
      subtitles: true,
      episodeTitles: true,
      qualityInName: true
    },
    addon: {
      enabled: true,
      token: randomToken(18),
      name: 'Haul Library',
      publicUrl: options.defaults.publicUrl
    },
    library: { rescanMinutes: 30 },
    passwordHash: '',
    sessionSecret: randomToken(32),
    streamSecret: randomToken(32)
  };
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const clampNumber = (value: unknown, min: number, max: number, fallback: number) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

const cleanDir = (value: unknown, fallback: string) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? path.resolve(text) : fallback;
};

const cleanUrl = (value: unknown) => (typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '');

export class SettingsService {
  private readonly file: JsonFile<StoredSettings>;
  private listeners: Array<() => void> = [];

  constructor(options: ServerOptions) {
    const base = defaults(options);
    this.file = new JsonFile(path.join(options.dataDir, 'settings.json'), () => base);
    // Merge nested sections so new defaults appear after upgrades.
    const data = this.file.data;
    data.sources = { ...base.sources, ...data.sources };
    data.quality = { ...base.quality, ...data.quality };
    data.downloads = { ...base.downloads, ...data.downloads };
    data.addon = { ...base.addon, ...data.addon };
    data.library = { ...base.library, ...data.library };
    if (!data.torboxApiKey && options.defaults.torboxApiKey) data.torboxApiKey = options.defaults.torboxApiKey;
    this.file.flush();
  }

  get value(): StoredSettings {
    return this.file.data;
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  publicView(): Settings {
    const { passwordHash, sessionSecret: _session, streamSecret: _stream, ...rest } = this.file.data;
    const key = rest.torboxApiKey;
    return {
      ...rest,
      torboxApiKey: key ? `${MASK}${key.slice(-4)}` : '',
      passwordSet: Boolean(passwordHash)
    };
  }

  update(patch: SettingsPatch): Settings {
    const data = this.file.data;
    if (typeof patch.torboxApiKey === 'string' && !patch.torboxApiKey.includes('•')) data.torboxApiKey = patch.torboxApiKey.trim();
    if (patch.moviesDir !== undefined) data.moviesDir = cleanDir(patch.moviesDir, data.moviesDir);
    if (patch.tvDir !== undefined) data.tvDir = cleanDir(patch.tvDir, data.tvDir);
    if (patch.incompleteDir !== undefined) data.incompleteDir = cleanDir(patch.incompleteDir, data.incompleteDir);
    if (Array.isArray(patch.extraLibraryDirs)) {
      data.extraLibraryDirs = patch.extraLibraryDirs.map((dir) => String(dir).trim()).filter(Boolean).map((dir) => path.resolve(dir));
    }
    if (patch.sources) {
      const sources = patch.sources;
      if (typeof sources.torrentio === 'boolean') data.sources.torrentio = sources.torrentio;
      if (typeof sources.torboxSearch === 'boolean') data.sources.torboxSearch = sources.torboxSearch;
      if (sources.torrentioUrl !== undefined) data.sources.torrentioUrl = cleanUrl(sources.torrentioUrl).replace(/\/manifest\.json$/, '') || 'https://torrentio.strem.fun';
      if (Array.isArray(sources.addons)) data.sources.addons = sources.addons.map(cleanUrl).filter((url) => /^https?:\/\//.test(url));
    }
    if (patch.quality) {
      const quality = patch.quality;
      if (quality.preferred && ['2160p', '1080p', '720p', '480p', 'any'].includes(quality.preferred)) data.quality.preferred = quality.preferred;
      if (quality.maxEpisodeGB !== undefined) data.quality.maxEpisodeGB = clampNumber(quality.maxEpisodeGB, 0, 500, 0);
      if (quality.maxMovieGB !== undefined) data.quality.maxMovieGB = clampNumber(quality.maxMovieGB, 0, 1000, 0);
      if (typeof quality.preferCached === 'boolean') data.quality.preferCached = quality.preferCached;
      if (typeof quality.allowHdr === 'boolean') data.quality.allowHdr = quality.allowHdr;
      if (typeof quality.allowUpscaled === 'boolean') data.quality.allowUpscaled = quality.allowUpscaled;
      if (Array.isArray(quality.blockedWords)) data.quality.blockedWords = quality.blockedWords.map((word) => String(word).trim()).filter(Boolean);
    }
    if (patch.downloads) {
      const downloads = patch.downloads;
      if (downloads.concurrentFiles !== undefined) data.downloads.concurrentFiles = clampNumber(downloads.concurrentFiles, 1, 10, 3);
      for (const key of ['removeFromTorbox', 'subtitles', 'episodeTitles', 'qualityInName'] as const) {
        if (typeof downloads[key] === 'boolean') data.downloads[key] = downloads[key]!;
      }
    }
    if (patch.addon) {
      if (typeof patch.addon.enabled === 'boolean') data.addon.enabled = patch.addon.enabled;
      if (typeof patch.addon.name === 'string' && patch.addon.name.trim()) data.addon.name = patch.addon.name.trim().slice(0, 60);
      if (patch.addon.publicUrl !== undefined) data.addon.publicUrl = cleanUrl(patch.addon.publicUrl);
    }
    if (patch.library?.rescanMinutes !== undefined) data.library.rescanMinutes = clampNumber(patch.library.rescanMinutes, 0, 1440, 30);
    if (typeof patch.password === 'string') data.passwordHash = patch.password ? hashPassword(patch.password) : '';
    this.file.flush();
    for (const listener of this.listeners) listener();
    return this.publicView();
  }

  regenerateAddonToken(): void {
    this.file.data.addon.token = randomToken(18);
    this.file.flush();
  }

  checkPassword(password: string): boolean {
    return Boolean(this.file.data.passwordHash) && verifyPassword(password, this.file.data.passwordHash);
  }
}
