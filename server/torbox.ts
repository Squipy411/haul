import type { PackFile, TorboxAccount } from '../shared/types.js';
import { type CachedTorrent, type Debrid, DebridError, type DebridTorrent, type ServiceStream } from './debrid.js';

const API = 'https://api.torbox.app/v1/api';

export interface TorboxFile {
  id: number;
  name: string;
  short_name?: string;
  size: number;
  mimetype?: string;
}

interface Envelope<T> {
  success: boolean;
  error?: string | null;
  detail?: string;
  data: T;
}

const PLANS: Record<number, string> = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Standard' };

export class Torbox implements Debrid {
  readonly id = 'torbox' as const;
  readonly name = 'TorBox';
  readonly checksCache = true;

  constructor(private readonly key: () => string) {}

  get configured(): boolean {
    return Boolean(this.key());
  }

  /** The key TorBox last refused, until a call with it works again (or it's replaced). */
  private refusedKey: string | null = null;
  get refused(): boolean {
    return this.refusedKey !== null && this.refusedKey === this.key();
  }

  private async call<T>(pathname: string, init: RequestInit & { query?: Record<string, string | number | boolean | undefined> } = {}, keyOverride?: string): Promise<T> {
    const key = keyOverride ?? this.key();
    if (!key) throw new DebridError('Add your TorBox API key in Settings first.', 'NO_KEY');
    const url = new URL(`${API}${pathname}`);
    for (const [name, value] of Object.entries(init.query || {})) if (value !== undefined) url.searchParams.set(name, String(value));
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'Haul/1.0', ...(init.headers || {}) },
        signal: AbortSignal.timeout(30_000)
      });
    } catch (error) {
      throw new DebridError(`Could not reach TorBox: ${(error as Error).message}`, 'NETWORK');
    }
    if (response.status === 429) {
      const retry = Number(response.headers.get('retry-after')) || 60;
      throw new DebridError('TorBox rate limit reached. Haul will retry shortly.', 'RATE_LIMIT', 429, retry);
    }
    let body: Envelope<T>;
    try {
      body = await response.json() as Envelope<T>;
    } catch {
      throw new DebridError(`TorBox returned HTTP ${response.status}.`, 'BAD_RESPONSE', response.status);
    }
    if (!response.ok || !body.success) {
      // TorBox's own wording ("log in again or reset your token") is about its website, not Haul.
      if (response.status === 401 || /token|auth/i.test(`${body.error ?? ''} ${body.detail ?? ''}`)) {
        if (!keyOverride) this.refusedKey = key;
        throw new DebridError("TorBox didn't accept your API key. It may have been reset: copy it again from torbox.app/settings and paste it in Haul's Settings.", 'BAD_KEY', response.status);
      }
      throw new DebridError(body.detail || body.error || `TorBox returned HTTP ${response.status}.`, body.error || undefined, response.status);
    }
    if (this.refusedKey === key) this.refusedKey = null;
    return body.data;
  }

  async account(keyOverride?: string): Promise<TorboxAccount> {
    try {
      const user = await this.call<{ email?: string; plan?: number; premium_expires_at?: string | null }>('/user/me', {}, keyOverride);
      return { ok: true, email: user.email, plan: PLANS[user.plan ?? -1] ?? `Plan ${user.plan}`, expires: user.premium_expires_at ?? null };
    } catch (error) {
      const failure = error as DebridError;
      return { ok: false, error: failure.code === 'BAD_KEY' ? "TorBox didn't accept that API key. Copy it again from torbox.app/settings, under API key, and paste it here." : failure.message };
    }
  }

  /** Returns cached torrents keyed by lowercase hash. Hashes not in the map are not cached. */
  async checkCached(hashes: string[]): Promise<Map<string, CachedTorrent>> {
    const result = new Map<string, CachedTorrent>();
    const unique = [...new Set(hashes.map((hash) => hash.toLowerCase()))];
    const chunks: string[][] = [];
    for (let index = 0; index < unique.length; index += 60) chunks.push(unique.slice(index, index + 60));
    // All batches at once: a search waits for one round trip, not one per 60 results.
    const answers = await Promise.allSettled(chunks.map((chunk) => this.call<Record<string, CachedTorrent> | CachedTorrent[] | null>('/torrents/checkcached', {
      query: { hash: chunk.join(','), format: 'object', list_files: true }
    })));
    if (answers.length && answers.every((answer) => answer.status === 'rejected')) throw (answers[0] as PromiseRejectedResult).reason;
    for (const answer of answers) {
      if (answer.status !== 'fulfilled') continue;
      const data = answer.value;
      const entries = Array.isArray(data) ? data.map((item) => [item.hash, item] as const) : Object.entries(data || {});
      for (const [hash, torrent] of entries) {
        result.set(hash.toLowerCase(), {
          name: torrent.name,
          size: torrent.size,
          hash: hash.toLowerCase(),
          files: (torrent.files || []).map((file, position) => ({ id: (file as PackFile).id ?? position, name: file.name, size: file.size }))
        });
      }
    }
    return result;
  }

  async create(magnet: string, name?: string): Promise<{ torrentId?: number; queuedId?: number; hash?: string }> {
    const form = new FormData();
    form.set('magnet', magnet);
    form.set('seed', '3');
    form.set('allow_zip', 'false');
    if (name) form.set('name', name);
    const data = await this.call<{ torrent_id?: number; queued_id?: number; hash?: string }>('/torrents/createtorrent', { method: 'POST', body: form });
    return { torrentId: data?.torrent_id, queuedId: data?.queued_id, hash: data?.hash };
  }

  /** How many pages the list had last time, so the next read fetches them all at once. */
  private listPages = 1;

  /** Every torrent in the account. TorBox pages at 1000; big accounts take a few requests, made together. */
  async list(): Promise<DebridTorrent[]> {
    const page = async (index: number) => {
      const data = await this.call<DebridTorrent[] | null>('/torrents/mylist', { query: { bypass_cache: true, limit: 1000, offset: index * 1000 } });
      return Array.isArray(data) ? data : [];
    };
    const pages = await Promise.all(Array.from({ length: this.listPages }, (_, index) => page(index)));
    // The account grew past what we fetched: keep going.
    while (pages.length < 20 && pages[pages.length - 1]!.length === 1000) pages.push(await page(pages.length));
    while (pages.length > 1 && pages[pages.length - 1]!.length === 0) pages.pop();
    this.listPages = pages.length;
    return pages.flat();
  }

  /** One torrent by id: much quicker than the whole list when waiting for a new one to be ready. */
  async torrent(id: number | string): Promise<DebridTorrent | undefined> {
    const data = await this.call<DebridTorrent | DebridTorrent[] | null>('/torrents/mylist', { query: { bypass_cache: true, id } });
    return Array.isArray(data) ? data[0] : data ?? undefined;
  }

  async downloadLink(torrentId: number | string, fileId: number): Promise<string> {
    const key = this.key();
    const url = await this.call<string>('/torrents/requestdl', {
      query: { token: key, torrent_id: torrentId, file_id: fileId, zip_link: false, redirect: false }
    });
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new DebridError('TorBox did not return a download link.', 'NO_LINK');
    return url;
  }

  /**
   * A browser-ready HLS stream of one file. TorBox converts it on its servers and burns in the chosen
   * subtitle. The returned hls_url carries the API key, so it must never reach the browser.
   */
  async createStream(torrentId: number | string, fileId: number, choice: { audio?: number; subtitle?: number | null } = {}): Promise<ServiceStream> {
    return this.call<ServiceStream>('/stream/createstream', {
      query: {
        id: torrentId,
        file_id: fileId,
        type: 'torrent',
        chosen_audio_index: choice.audio ?? 0,
        ...(choice.subtitle !== undefined && choice.subtitle !== null ? { chosen_subtitle_index: choice.subtitle } : {}),
        scrobbling_enabled: false
      }
    });
  }

  async remove(torrentId: number | string): Promise<void> {
    await this.call('/torrents/controltorrent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ torrent_id: torrentId, operation: 'delete' })
    });
  }
}

export function magnetFor(hash: string, name?: string): string {
  const trackers = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://exodus.desync.com:6969/announce'
  ];
  const params = [`xt=urn:btih:${hash}`];
  if (name) params.push(`dn=${encodeURIComponent(name)}`);
  for (const tracker of trackers) params.push(`tr=${encodeURIComponent(tracker)}`);
  return `magnet:?${params.join('&')}`;
}
