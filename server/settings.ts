import crypto from 'node:crypto';
import path from 'node:path';
import type { Settings, SettingsPatch } from '../shared/types.js';
import type { ServerOptions } from './config.js';
import { JsonFile } from './store.js';

interface StoredSettings extends Omit<Settings, 'passwordSet' | 'twoFactor'> {
  passwordHash: string;
  sessionSecret: string;
  streamSecret: string;
  /** Private part of the calendar feed address. */
  calendarToken: string;
  /** Moves on with "Sign out everywhere", which ends every password session. */
  sessionGeneration: number;
  /** The calendar feed: events when a wanted torrent is found (default), or at air dates. */
  calendarMode: 'found' | 'aired';
  /** Sharing over the internet with Cloudflare's tunnel; the token is never shown again. */
  remote: { mode: 'off' | 'quick' | 'token'; token: string; hostname: string };
  /** Two-step sign-in: the authenticator secret ('' when off), one being set up, and the last code step used. */
  totpSecret: string;
  totpPending: string;
  totpUsedStep: number;
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
      preferLarger: true,
      blockedWords: []
    },
    downloads: {
      concurrentFiles: 3,
      connections: 4,
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
    notifications: {
      enabled: false,
      ntfyServer: 'https://ntfy.sh',
      // A long random topic: on ntfy.sh anyone who knows the name can read it.
      ntfyTopic: `haul-${randomToken(12).replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}`,
      ntfyToken: '',
      discordWebhook: '',
      downloadFinished: true,
      downloadFailed: true,
      signIns: true
    },
    passwordHash: '',
    sessionSecret: randomToken(32),
    streamSecret: randomToken(32),
    calendarToken: randomToken(18),
    sessionGeneration: 0,
    remote: { mode: 'off', token: '', hostname: '' },
    calendarMode: 'found',
    totpSecret: '',
    totpPending: '',
    totpUsedStep: -1
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
    data.notifications = { ...base.notifications, ...data.notifications };
    if (!data.torboxApiKey && options.defaults.torboxApiKey) data.torboxApiKey = options.defaults.torboxApiKey;
    data.calendarToken ||= randomToken(18);
    data.sessionGeneration ??= 0;
    data.remote = { ...base.remote, ...data.remote };
    if (data.calendarMode !== 'aired') data.calendarMode = 'found';
    data.totpSecret ??= '';
    data.totpPending ??= '';
    data.totpUsedStep ??= -1;
    this.file.flush();
  }

  get value(): StoredSettings {
    return this.file.data;
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  publicView(): Settings {
    const { passwordHash, sessionSecret: _session, streamSecret: _stream, calendarToken: _calendar, sessionGeneration: _generation, remote: _remote, calendarMode: _calendarMode, totpSecret, totpPending: _pending, totpUsedStep: _used, ...rest } = this.file.data;
    const key = rest.torboxApiKey;
    return {
      ...rest,
      notifications: { ...rest.notifications, ntfyToken: rest.notifications.ntfyToken ? `${MASK}${rest.notifications.ntfyToken.slice(-4)}` : '' },
      torboxApiKey: key ? `${MASK}${key.slice(-4)}` : '',
      passwordSet: Boolean(passwordHash),
      twoFactor: Boolean(totpSecret)
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
      if (typeof quality.preferLarger === 'boolean') data.quality.preferLarger = quality.preferLarger;
      if (Array.isArray(quality.blockedWords)) data.quality.blockedWords = quality.blockedWords.map((word) => String(word).trim()).filter(Boolean);
    }
    if (patch.downloads) {
      const downloads = patch.downloads;
      if (downloads.concurrentFiles !== undefined) data.downloads.concurrentFiles = clampNumber(downloads.concurrentFiles, 1, 10, 3);
      if (downloads.connections !== undefined) data.downloads.connections = clampNumber(downloads.connections, 1, 8, 4);
      for (const key of ['removeFromTorbox', 'subtitles', 'episodeTitles', 'qualityInName'] as const) {
        if (typeof downloads[key] === 'boolean') data.downloads[key] = downloads[key]!;
      }
    }
    if (patch.addon) {
      if (typeof patch.addon.enabled === 'boolean') data.addon.enabled = patch.addon.enabled;
      if (typeof patch.addon.name === 'string' && patch.addon.name.trim()) data.addon.name = patch.addon.name.trim().slice(0, 60);
      if (patch.addon.publicUrl !== undefined) data.addon.publicUrl = cleanUrl(patch.addon.publicUrl);
    }
    if (patch.notifications) {
      const notifications = patch.notifications;
      if (typeof notifications.enabled === 'boolean') data.notifications.enabled = notifications.enabled;
      if (notifications.ntfyServer !== undefined) data.notifications.ntfyServer = cleanUrl(notifications.ntfyServer) || 'https://ntfy.sh';
      if (typeof notifications.ntfyTopic === 'string') data.notifications.ntfyTopic = notifications.ntfyTopic.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
      if (typeof notifications.ntfyToken === 'string' && !notifications.ntfyToken.includes('•')) data.notifications.ntfyToken = notifications.ntfyToken.trim();
      if (notifications.discordWebhook !== undefined) {
        const hook = cleanUrl(notifications.discordWebhook);
        data.notifications.discordWebhook = /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(hook) ? hook : '';
      }
      if (typeof notifications.downloadFinished === 'boolean') data.notifications.downloadFinished = notifications.downloadFinished;
      if (typeof notifications.downloadFailed === 'boolean') data.notifications.downloadFailed = notifications.downloadFailed;
      if (typeof notifications.signIns === 'boolean') data.notifications.signIns = notifications.signIns;
    }
    if (patch.library?.rescanMinutes !== undefined) data.library.rescanMinutes = clampNumber(patch.library.rescanMinutes, 0, 1440, 30);
    this.file.flush();
    for (const listener of this.listeners) listener();
    return this.publicView();
  }

  setPassword(password: string | null): void {
    this.file.data.passwordHash = password ? hashPassword(password) : '';
    this.file.flush();
  }

  regenerateAddonToken(): void {
    this.file.data.addon.token = randomToken(18);
    this.file.flush();
  }

  regenerateCalendarToken(): void {
    this.file.data.calendarToken = randomToken(18);
    this.file.flush();
  }

  setCalendarMode(mode: 'found' | 'aired'): void {
    this.file.data.calendarMode = mode;
    this.file.flush();
  }

  setRemote(remote: { mode: 'off' | 'quick' | 'token'; token?: string; hostname?: string }): void {
    this.file.data.remote = { mode: remote.mode, token: remote.token ?? this.file.data.remote.token, hostname: remote.hostname ?? this.file.data.remote.hostname };
    this.file.flush();
  }

  /** Ends every password session (the next sign-in starts a new generation). */
  newSessionGeneration(): void {
    this.file.data.sessionGeneration += 1;
    this.file.flush();
  }

  /** Two-step sign-in: a secret being set up, turning it on with the first good code, and off. */
  setTotp(change: { pending?: string; secret?: string; usedStep?: number }): void {
    if (change.pending !== undefined) this.file.data.totpPending = change.pending;
    if (change.secret !== undefined) this.file.data.totpSecret = change.secret;
    if (change.usedStep !== undefined) this.file.data.totpUsedStep = change.usedStep;
    this.file.flush();
  }

  checkPassword(password: string): boolean {
    return Boolean(this.file.data.passwordHash) && verifyPassword(password, this.file.data.passwordHash);
  }
}
