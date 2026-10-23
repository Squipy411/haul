import type { DebridService, PackFile, TorboxAccount } from '../shared/types.js';
import { SERVICE_NAMES } from '../shared/services.js';

// A debrid service fetches torrents on its own servers and hands back HTTPS links. TorBox, Real-Debrid,
// AllDebrid and Premiumize each have their own API; Haul talks to all of them through this one shape,
// modelled on TorBox's (the first one Haul supported).

export class DebridError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number, readonly retryAfter?: number) {
    super(message);
  }
}

export interface DebridFile {
  id: number;
  /** Path inside the torrent, e.g. "Show.S01.1080p/Show.S01E02.mkv". */
  name: string;
  /** The file name alone, when the service gives it. */
  short_name?: string;
  size: number;
}

/** A torrent in the account, in TorBox's terms. */
export interface DebridTorrent {
  id: number | string;
  hash: string;
  name: string;
  size: number;
  /** The service's own words for where it's at; "error"/"failed" in it means it won't finish. */
  download_state: string;
  download_finished: boolean;
  /** Ready to download from the service. */
  download_present: boolean;
  /** 0–1 */
  progress: number;
  download_speed: number;
  eta: number;
  cached: boolean;
  /** Can be empty in a list; asking for the one torrent gives its files. */
  files: DebridFile[];
  alternative_hashes?: string[];
}

export interface CachedTorrent {
  name: string;
  size: number;
  hash: string;
  files: PackFile[];
}

/** A browser-ready HLS stream (TorBox converts files on its servers). */
export interface ServiceStream {
  hls_url: string;
  needs_transcoding?: boolean;
  audio_index?: number;
  subtitle_index?: number | string | null;
  intro_information?: { start_time?: number; end_time?: number } | null;
  metadata?: {
    video?: { codec?: string; width?: number; height?: number; duration?: string };
    audios?: Array<{ index: number; codec?: string; language?: string; language_full?: string; title?: string | null; channels?: number }>;
    subtitles?: Array<{ index: number; codec?: string; language?: string; language_full?: string; title?: string | null }>;
  };
}

export interface Debrid {
  readonly id: DebridService;
  readonly name: string;
  readonly configured: boolean;
  /** The service refused the saved key the last time Haul used it. */
  readonly refused: boolean;
  /** Can say which torrents it already has before they're added. */
  readonly checksCache: boolean;
  account(keyOverride?: string): Promise<TorboxAccount>;
  /** Cached torrents keyed by lowercase hash. Hashes not in the map aren't cached (or the service can't say). */
  checkCached(hashes: string[]): Promise<Map<string, CachedTorrent>>;
  create(magnet: string, name?: string): Promise<{ torrentId?: number | string; queuedId?: number; hash?: string }>;
  list(): Promise<DebridTorrent[]>;
  torrent(id: number | string): Promise<DebridTorrent | undefined>;
  /** An HTTPS link to one file, good for a few hours. */
  downloadLink(torrentId: number | string, fileId: number): Promise<string>;
  /** Only services that convert files themselves (TorBox). */
  createStream?(torrentId: number | string, fileId: number, choice?: { audio?: number; subtitle?: number | null }): Promise<ServiceStream>;
  remove(torrentId: number | string): Promise<void>;
}

/** The service picked in Settings, plus the others for downloads that were started on them. */
export class Services implements Debrid {
  constructor(private readonly pick: () => DebridService, private readonly all: Record<DebridService, Debrid>) {}

  get active(): Debrid {
    return this.all[this.pick()] ?? this.all.torbox;
  }

  /** The service a download was started on (older downloads were all TorBox). */
  get(id: DebridService | undefined): Debrid {
    return this.all[id ?? 'torbox'] ?? this.all.torbox;
  }

  get id(): DebridService { return this.active.id; }
  get name(): string { return this.active.name; }
  get configured(): boolean { return this.active.configured; }
  get refused(): boolean { return this.active.refused; }
  get checksCache(): boolean { return this.active.checksCache; }
  account(keyOverride?: string): Promise<TorboxAccount> { return this.active.account(keyOverride); }
  checkCached(hashes: string[]): Promise<Map<string, CachedTorrent>> { return this.active.checkCached(hashes); }
  create(magnet: string, name?: string) { return this.active.create(magnet, name); }
  list(): Promise<DebridTorrent[]> { return this.active.list(); }
  torrent(id: number | string): Promise<DebridTorrent | undefined> { return this.active.torrent(id); }
  downloadLink(torrentId: number | string, fileId: number): Promise<string> { return this.active.downloadLink(torrentId, fileId); }
  get createStream(): Debrid['createStream'] { return this.active.createStream?.bind(this.active); }
  remove(torrentId: number | string): Promise<void> { return this.active.remove(torrentId); }
}

export const serviceName = (id: DebridService) => SERVICE_NAMES[id];

/** fetch with a timeout, turning network trouble into a DebridError that names the service. */
export async function reach(service: string, url: string | URL, init: RequestInit = {}, timeout = 30_000): Promise<Response> {
  try {
    return await fetch(url, { ...init, headers: { 'User-Agent': 'Haul/1.0', ...(init.headers || {}) }, signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    throw new DebridError(`Could not reach ${service}: ${(error as Error).message}`, 'NETWORK');
  }
}

/** Joins a request's form fields, repeating keys for arrays (magnets[]=…&magnets[]=…). */
export function form(fields: Record<string, string | number | Array<string | number> | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) body.append(name, String(item));
  }
  return body;
}
