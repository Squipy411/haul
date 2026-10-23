import type { TorboxAccount } from '../shared/types.js';
import { type CachedTorrent, type Debrid, DebridError, type DebridFile, type DebridTorrent, form, reach } from './debrid.js';

// AllDebrid (api.alldebrid.com, v4 and v4.1). A magnet is uploaded, its status read until it's ready
// (statusCode 4), then its files come as a tree whose links /link/unlock turns into direct downloads.
// AllDebrid no longer says which torrents are cached in advance.

const API = 'https://api.alldebrid.com';
const NAME = 'AllDebrid';

interface AdMagnet {
  id: number;
  filename?: string;
  hash?: string;
  size?: number;
  status?: string;
  statusCode?: number;
  downloaded?: number;
  downloadSpeed?: number;
}
type AdNode = { n: string; s?: number; l?: string; e?: AdNode[] };

/** Flattens AllDebrid's file tree into paths, numbering files in the order they appear. */
export function flattenTree(nodes: AdNode[], prefix = ''): Array<DebridFile & { link: string }> {
  const out: Array<DebridFile & { link: string }> = [];
  const walk = (list: AdNode[], at: string) => {
    for (const node of list) {
      const name = at ? `${at}/${node.n}` : node.n;
      if (node.e) walk(node.e, name);
      else if (node.l) out.push({ id: out.length, name, size: Number(node.s) || 0, link: node.l });
    }
  };
  walk(nodes, prefix);
  return out;
}

export class AllDebrid implements Debrid {
  readonly id = 'alldebrid' as const;
  readonly name = NAME;
  readonly checksCache = false;
  private refusedKey: string | null = null;
  /** Files of ready magnets: they don't change, and reading them again for each download is a waste. */
  private readonly files = new Map<string, { at: number; files: Array<DebridFile & { link: string }> }>();

  constructor(private readonly key: () => string) {}

  get configured(): boolean {
    return Boolean(this.key());
  }

  get refused(): boolean {
    return this.refusedKey !== null && this.refusedKey === this.key();
  }

  private async call<T>(pathname: string, fields?: Record<string, string | number | Array<string | number>>, keyOverride?: string): Promise<T> {
    const key = keyOverride ?? this.key();
    if (!key) throw new DebridError(`Add your ${NAME} API key in Settings first.`, 'NO_KEY');
    const response = await reach(NAME, `${API}${pathname}`, {
      method: fields ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${key}`, ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: fields ? form(fields) : undefined
    });
    if (response.status === 429) throw new DebridError(`${NAME} rate limit reached. Haul will retry shortly.`, 'RATE_LIMIT', 429, 30);
    let body: { status?: string; data?: T; error?: { code?: string; message?: string } };
    try {
      body = await response.json() as typeof body;
    } catch {
      throw new DebridError(`${NAME} returned HTTP ${response.status}.`, 'BAD_RESPONSE', response.status);
    }
    if (body.status !== 'success') {
      const code = body.error?.code ?? '';
      if (/^AUTH_(BAD|MISSING)_APIKEY$/.test(code)) {
        if (!keyOverride) this.refusedKey = key;
        throw new DebridError(`${NAME} didn't accept your API key. Copy it again from alldebrid.com/apikeys and paste it in Haul's Settings.`, 'BAD_KEY', response.status);
      }
      if (code === 'AUTH_BLOCKED') throw new DebridError(`${NAME} blocked this key from this place. Open the email ${NAME} sent you to allow it.`, 'BLOCKED', response.status);
      if (/MUST_BE_PREMIUM/.test(code)) throw new DebridError(`${NAME} needs a premium account for this.`, 'PREMIUM', response.status);
      if (code === 'MAGNET_TOO_MANY_ACTIVE') throw new DebridError(`All your ${NAME} active download slots are in use.`, 'SLOTS', response.status);
      throw new DebridError(`${NAME}: ${body.error?.message ?? code ?? `HTTP ${response.status}`}`, code || undefined, response.status);
    }
    if (this.refusedKey === key) this.refusedKey = null;
    return body.data as T;
  }

  async account(keyOverride?: string): Promise<TorboxAccount> {
    try {
      const { user } = await this.call<{ user: { email?: string; username?: string; isPremium?: boolean; premiumUntil?: number } }>('/v4/user', undefined, keyOverride);
      return { ok: true, email: user.email ?? user.username, plan: user.isPremium ? 'Premium' : 'Free', expires: user.isPremium && user.premiumUntil ? new Date(user.premiumUntil * 1000).toISOString() : null };
    } catch (error) {
      const failure = error as DebridError;
      return { ok: false, error: failure.code === 'BAD_KEY' ? `${NAME} didn't accept that API key. Copy it from alldebrid.com/apikeys and paste it here.` : failure.message };
    }
  }

  async checkCached(): Promise<Map<string, CachedTorrent>> {
    return new Map();
  }

  async create(magnet: string): Promise<{ torrentId?: number; hash?: string }> {
    const { magnets } = await this.call<{ magnets: Array<{ id?: number; hash?: string; error?: { code?: string; message?: string } }> }>('/v4/magnet/upload', { 'magnets[]': [magnet] });
    const first = magnets?.[0];
    if (!first || first.error || first.id === undefined) {
      const code = first?.error?.code ?? '';
      throw new DebridError(code === 'MAGNET_TOO_MANY_ACTIVE' ? `All your ${NAME} active download slots are in use.` : `${NAME} couldn't add the torrent: ${first?.error?.message ?? 'no answer'}`, code || 'REFUSED');
    }
    return { torrentId: first.id, hash: first.hash?.toLowerCase() };
  }

  private toTorrent(magnet: AdMagnet, files: DebridFile[] = []): DebridTorrent {
    const code = Number(magnet.statusCode);
    const ready = code === 4;
    const size = Number(magnet.size) || 0;
    const speed = Number(magnet.downloadSpeed) || 0;
    const progress = ready ? 1 : size ? Math.min(1, (Number(magnet.downloaded) || 0) / size) : 0;
    return {
      id: magnet.id,
      hash: String(magnet.hash || '').toLowerCase(),
      name: magnet.filename ?? '',
      size,
      download_state: code >= 5 ? `error (${magnet.status ?? 'failed'})` : magnet.status ?? (ready ? 'Ready' : 'Processing'),
      download_finished: ready,
      download_present: ready,
      progress,
      download_speed: speed,
      eta: speed > 0 ? Math.round((size * (1 - progress)) / speed) : 0,
      cached: ready,
      files
    };
  }

  private async filesOf(id: number | string): Promise<Array<DebridFile & { link: string }>> {
    const known = this.files.get(String(id));
    if (known && Date.now() - known.at < 30 * 60_000) return known.files;
    const { magnets } = await this.call<{ magnets: Array<{ id: number; files?: AdNode[]; error?: { message?: string } }> }>('/v4/magnet/files', { 'id[]': [String(id)] });
    const entry = magnets?.find((item) => String(item.id) === String(id)) ?? magnets?.[0];
    if (!entry || entry.error) throw new DebridError(`${NAME} couldn't list the files: ${entry?.error?.message ?? 'no answer'}`, 'NO_FILES');
    const files = flattenTree(entry.files ?? []);
    this.files.set(String(id), { at: Date.now(), files });
    return files;
  }

  async list(): Promise<DebridTorrent[]> {
    const { magnets } = await this.call<{ magnets: AdMagnet[] | Record<string, AdMagnet> }>('/v4.1/magnet/status', {});
    return Object.values(magnets ?? {}).map((magnet) => this.toTorrent(magnet));
  }

  async torrent(id: number | string): Promise<DebridTorrent | undefined> {
    let data: { magnets: AdMagnet | AdMagnet[] };
    try {
      data = await this.call('/v4.1/magnet/status', { id: String(id) });
    } catch (error) {
      if (/MAGNET_INVALID_ID|NOT_FOUND/i.test(String((error as DebridError).code))) return undefined;
      throw error;
    }
    const magnet = Array.isArray(data.magnets) ? data.magnets[0] : data.magnets;
    if (!magnet) return undefined;
    const files = Number(magnet.statusCode) === 4 ? (await this.filesOf(magnet.id)).map(({ id: fileId, name, size }) => ({ id: fileId, name, size })) : [];
    return this.toTorrent(magnet, files);
  }

  async downloadLink(torrentId: number | string, fileId: number): Promise<string> {
    const file = (await this.filesOf(torrentId)).find((item) => item.id === fileId);
    if (!file) throw new DebridError(`${NAME} has no link for that file.`, 'NO_LINK');
    let unlocked = await this.call<{ link?: string; delayed?: number }>('/v4/link/unlock', { link: file.link });
    // Some links take a moment to make: AllDebrid hands back a ticket to ask about.
    for (let waited = 0; !unlocked.link && unlocked.delayed && waited < 30_000; waited += 2000) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const delayed = await this.call<{ status?: number; link?: string }>('/v4/link/delayed', { id: unlocked.delayed });
      if (delayed.status === 2 && delayed.link) unlocked = { link: delayed.link };
      else if (delayed.status === 3) break;
    }
    if (!unlocked.link) throw new DebridError(`${NAME} did not return a download link.`, 'NO_LINK');
    return unlocked.link;
  }

  async remove(torrentId: number | string): Promise<void> {
    this.files.delete(String(torrentId));
    await this.call('/v4/magnet/delete', { id: String(torrentId) });
  }
}
