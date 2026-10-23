import type { TorboxAccount } from '../shared/types.js';
import { type CachedTorrent, type Debrid, DebridError, type DebridTorrent, form, reach } from './debrid.js';
import { SUBTITLE_EXTENSIONS, VIDEO_EXTENSIONS, extensionOf } from './release.js';

// Real-Debrid (api.real-debrid.com/rest/1.0). A magnet is added, its files are chosen, and once it's
// "downloaded" each chosen file has a hoster link that /unrestrict/link turns into a direct download.
// Real-Debrid stopped saying which torrents are cached, so checkCached has nothing to offer.

const API = 'https://api.real-debrid.com/rest/1.0';
const NAME = 'Real-Debrid';

interface RdFile { id: number; path: string; bytes: number; selected: number }
interface RdTorrent {
  id: string;
  filename: string;
  hash: string;
  bytes: number;
  progress: number;
  status: string;
  speed?: number;
  links?: string[];
  files?: RdFile[];
}

const FAILED = new Set(['magnet_error', 'error', 'virus', 'dead']);
const STATES: Record<string, string> = {
  magnet_conversion: 'Reading the magnet',
  waiting_files_selection: 'Choosing files',
  queued: 'Queued on Real-Debrid',
  downloading: 'Downloading',
  compressing: 'Packing',
  uploading: 'Uploading',
  downloaded: 'Ready'
};

export class RealDebrid implements Debrid {
  readonly id = 'realdebrid' as const;
  readonly name = NAME;
  readonly checksCache = false;
  private refusedKey: string | null = null;

  constructor(private readonly key: () => string) {}

  get configured(): boolean {
    return Boolean(this.key());
  }

  get refused(): boolean {
    return this.refusedKey !== null && this.refusedKey === this.key();
  }

  private async call<T>(method: string, pathname: string, fields?: Record<string, string>, keyOverride?: string): Promise<T> {
    const key = keyOverride ?? this.key();
    if (!key) throw new DebridError(`Add your ${NAME} API key in Settings first.`, 'NO_KEY');
    const response = await reach(NAME, `${API}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: fields ? form(fields) : undefined
    });
    if (response.status === 429) throw new DebridError(`${NAME} rate limit reached. Haul will retry shortly.`, 'RATE_LIMIT', 429, 60);
    const text = await response.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* empty or not JSON */ }
    if (!response.ok) {
      const code = Number(data?.error_code);
      const error = String(data?.error ?? '');
      if (response.status === 401 || code === 8 || error === 'bad_token') {
        if (!keyOverride) this.refusedKey = key;
        throw new DebridError(`${NAME} didn't accept your API key. It may have been reset: copy it again from real-debrid.com/apitoken and paste it in Haul's Settings.`, 'BAD_KEY', response.status);
      }
      if (code === 20 || /premium/i.test(error)) throw new DebridError(`${NAME} needs a premium account for this.`, 'PREMIUM', response.status);
      if (code === 21 || /too_many_active/i.test(error)) throw new DebridError(`All your ${NAME} active download slots are in use.`, 'SLOTS', response.status);
      if (response.status === 404 || code === 7) throw new DebridError(`${NAME} doesn't know that torrent.`, 'NOT_FOUND', 404);
      throw new DebridError(`${NAME}: ${error.replace(/_/g, ' ') || `HTTP ${response.status}`}.`, error || undefined, response.status);
    }
    if (this.refusedKey === key) this.refusedKey = null;
    return data as T;
  }

  async account(keyOverride?: string): Promise<TorboxAccount> {
    try {
      const user = await this.call<{ email?: string; username?: string; type?: string; expiration?: string }>('GET', '/user', undefined, keyOverride);
      const premium = user.type === 'premium';
      return { ok: true, email: user.email ?? user.username, plan: premium ? 'Premium' : 'Free', expires: premium ? user.expiration ?? null : null };
    } catch (error) {
      const failure = error as DebridError;
      return { ok: false, error: failure.code === 'BAD_KEY' ? `${NAME} didn't accept that API key. Copy it from real-debrid.com/apitoken and paste it here.` : failure.message };
    }
  }

  async checkCached(): Promise<Map<string, CachedTorrent>> {
    return new Map();
  }

  /** Picks the videos and subtitles (everything, if it can't tell), so the links are one per useful file. */
  private async chooseFiles(info: RdTorrent): Promise<void> {
    const wanted = (info.files ?? []).filter((file) => {
      const extension = extensionOf(file.path);
      return VIDEO_EXTENSIONS.has(extension) || SUBTITLE_EXTENSIONS.has(extension);
    });
    await this.call('POST', `/torrents/selectFiles/${encodeURIComponent(info.id)}`, { files: wanted.length ? wanted.map((file) => file.id).join(',') : 'all' });
  }

  async create(magnet: string): Promise<{ torrentId?: string; hash?: string }> {
    const added = await this.call<{ id: string }>('POST', '/torrents/addMagnet', { magnet });
    // The magnet takes a moment to read; files can only be chosen once it has been.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const info = await this.call<RdTorrent>('GET', `/torrents/info/${encodeURIComponent(added.id)}`).catch(() => null);
      if (info?.status === 'waiting_files_selection') { await this.chooseFiles(info).catch(() => undefined); break; }
      if (info && info.status !== 'magnet_conversion') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { torrentId: added.id };
  }

  private toTorrent(info: RdTorrent): DebridTorrent {
    const ready = info.status === 'downloaded';
    const progress = (Number(info.progress) || 0) / 100;
    const speed = Number(info.speed) || 0;
    return {
      id: info.id,
      hash: String(info.hash || '').toLowerCase(),
      name: info.filename,
      size: Number(info.bytes) || 0,
      download_state: FAILED.has(info.status) ? `error (${info.status.replace(/_/g, ' ')})` : STATES[info.status] ?? info.status,
      download_finished: ready,
      download_present: ready,
      progress,
      download_speed: speed,
      eta: speed > 0 ? Math.round(((Number(info.bytes) || 0) * (1 - progress)) / speed) : 0,
      cached: ready,
      files: (info.files ?? []).filter((file) => file.selected === 1).map((file) => ({ id: file.id, name: file.path.replace(/^\/+/, ''), size: file.bytes }))
    };
  }

  async list(): Promise<DebridTorrent[]> {
    const all: RdTorrent[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const items = await this.call<RdTorrent[] | null>('GET', `/torrents?limit=1000&page=${page}`);
      if (!Array.isArray(items) || !items.length) break;
      all.push(...items);
      if (items.length < 1000) break;
    }
    return all.map((item) => this.toTorrent(item));
  }

  async torrent(id: number | string): Promise<DebridTorrent | undefined> {
    let info: RdTorrent;
    try {
      info = await this.call<RdTorrent>('GET', `/torrents/info/${encodeURIComponent(String(id))}`);
    } catch (error) {
      if ((error as DebridError).code === 'NOT_FOUND') return undefined;
      throw error;
    }
    // Added elsewhere, or the magnet was slow to read when Haul added it.
    if (info.status === 'waiting_files_selection') await this.chooseFiles(info).catch(() => undefined);
    return this.toTorrent(info);
  }

  async downloadLink(torrentId: number | string, fileId: number): Promise<string> {
    const info = await this.call<RdTorrent>('GET', `/torrents/info/${encodeURIComponent(String(torrentId))}`);
    // One hoster link per chosen file, in file order.
    const chosen = (info.files ?? []).filter((file) => file.selected === 1).sort((a, b) => a.id - b.id);
    const links = info.links ?? [];
    const link = links.length === chosen.length ? links[chosen.findIndex((file) => file.id === fileId)] : links.length === 1 && chosen.length === 1 ? links[0] : undefined;
    if (!link) throw new DebridError(links.length === 1 && chosen.length > 1 ? `${NAME} packed this torrent into one archive. Pick another version.` : `${NAME} hasn't made a link for that file yet.`, 'NO_LINK');
    const unrestricted = await this.call<{ download?: string; filename?: string }>('POST', '/unrestrict/link', { link });
    if (!unrestricted.download) throw new DebridError(`${NAME} did not return a download link.`, 'NO_LINK');
    if (/\.(rar|zip|7z)$/i.test(unrestricted.filename ?? '')) throw new DebridError(`${NAME} packed this torrent into an archive. Pick another version.`, 'NO_LINK');
    return unrestricted.download;
  }

  async remove(torrentId: number | string): Promise<void> {
    await this.call('DELETE', `/torrents/delete/${encodeURIComponent(String(torrentId))}`);
  }
}
