import type { TorboxAccount } from '../shared/types.js';
import { type CachedTorrent, type Debrid, DebridError, type DebridFile, type DebridTorrent, form, reach } from './debrid.js';
import { magnetHash } from './sources.js';

// Premiumize (www.premiumize.me/api). It says which torrents are cached (/cache/check). A magnet becomes
// a transfer; once finished its files sit in the cloud, in the transfer's folder (or as one file), each
// with a direct link.

const API = 'https://www.premiumize.me/api';
const NAME = 'Premiumize';

interface PmTransfer {
  id: string;
  name?: string;
  status?: string;
  progress?: number;
  message?: string;
  folder_id?: string | null;
  file_id?: string | null;
  src?: string;
}
interface PmItem { id: string; name: string; type: 'file' | 'folder'; size?: number; link?: string }

export class Premiumize implements Debrid {
  readonly id = 'premiumize' as const;
  readonly name = NAME;
  readonly checksCache = true;
  private refusedKey: string | null = null;
  /** Hashes of transfers Haul added (the list doesn't carry them). */
  private readonly hashes = new Map<string, string>();
  private readonly files = new Map<string, { at: number; files: Array<DebridFile & { link: string }> }>();
  private transfers: { at: number; value: Promise<PmTransfer[]> } | null = null;

  constructor(private readonly key: () => string) {}

  get configured(): boolean {
    return Boolean(this.key());
  }

  get refused(): boolean {
    return this.refusedKey !== null && this.refusedKey === this.key();
  }

  private async call<T>(pathname: string, fields?: Record<string, string | Array<string>>, keyOverride?: string): Promise<T> {
    const key = keyOverride ?? this.key();
    if (!key) throw new DebridError(`Add your ${NAME} API key in Settings first.`, 'NO_KEY');
    const response = await reach(NAME, `${API}${pathname}`, {
      method: fields ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${key}`, ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: fields ? form(fields) : undefined
    });
    if (response.status === 429) throw new DebridError(`${NAME} rate limit reached. Haul will retry shortly.`, 'RATE_LIMIT', 429, 30);
    let body: { status?: string; message?: string; code?: string } & T;
    try {
      body = await response.json() as typeof body;
    } catch {
      throw new DebridError(`${NAME} returned HTTP ${response.status}.`, 'BAD_RESPONSE', response.status);
    }
    if (body.status !== 'success') {
      if (body.code === 'authentication_failed' || response.status === 401 || /api ?key|not logged in|auth/i.test(body.message ?? '')) {
        if (!keyOverride) this.refusedKey = key;
        throw new DebridError(`${NAME} didn't accept your API key. Copy it again from premiumize.me/account and paste it in Haul's Settings.`, 'BAD_KEY', response.status);
      }
      if (/premium/i.test(body.message ?? '')) throw new DebridError(`${NAME} needs a premium account for this.`, 'PREMIUM', response.status);
      throw new DebridError(`${NAME}: ${body.message ?? `HTTP ${response.status}`}`, body.code, response.status);
    }
    if (this.refusedKey === key) this.refusedKey = null;
    return body;
  }

  async account(keyOverride?: string): Promise<TorboxAccount> {
    try {
      const info = await this.call<{ customer_id?: string; premium_until?: number | null }>('/account/info', undefined, keyOverride);
      const premium = Boolean(info.premium_until && info.premium_until * 1000 > Date.now());
      return { ok: true, email: info.customer_id ? `Customer ${info.customer_id}` : undefined, plan: premium ? 'Premium' : 'Free', expires: premium ? new Date(info.premium_until! * 1000).toISOString() : null };
    } catch (error) {
      const failure = error as DebridError;
      return { ok: false, error: failure.code === 'BAD_KEY' ? `${NAME} didn't accept that API key. Copy it from premiumize.me/account and paste it here.` : failure.message };
    }
  }

  async checkCached(hashes: string[]): Promise<Map<string, CachedTorrent>> {
    const result = new Map<string, CachedTorrent>();
    const unique = [...new Set(hashes.map((hash) => hash.toLowerCase()))];
    const chunks: string[][] = [];
    for (let index = 0; index < unique.length; index += 100) chunks.push(unique.slice(index, index + 100));
    const answers = await Promise.allSettled(chunks.map((chunk) => this.call<{ response: boolean[]; filename: Array<string | null>; filesize: Array<string | number | null> }>('/cache/check', { 'items[]': chunk })));
    if (answers.length && answers.every((answer) => answer.status === 'rejected')) throw (answers[0] as PromiseRejectedResult).reason;
    answers.forEach((answer, chunkIndex) => {
      if (answer.status !== 'fulfilled') return;
      chunks[chunkIndex]!.forEach((hash, position) => {
        if (!answer.value.response?.[position]) return;
        result.set(hash, { hash, name: answer.value.filename?.[position] ?? hash, size: Number(answer.value.filesize?.[position]) || 0, files: [] });
      });
    });
    return result;
  }

  async create(magnet: string): Promise<{ torrentId?: string; hash?: string }> {
    const created = await this.call<{ id: string }>('/transfer/create', { src: magnet });
    const hash = magnetHash(magnet);
    if (hash) this.hashes.set(String(created.id), hash);
    this.transfers = null;
    return { torrentId: created.id, hash };
  }

  private listTransfers(fresh = false): Promise<PmTransfer[]> {
    if (!fresh && this.transfers && Date.now() - this.transfers.at < 3000) return this.transfers.value;
    const value = this.call<{ transfers: PmTransfer[] }>('/transfer/list').then((data) => data.transfers ?? []);
    this.transfers = { at: Date.now(), value };
    value.catch(() => { this.transfers = null; });
    return value;
  }

  private toTorrent(transfer: PmTransfer, files: DebridFile[] = []): DebridTorrent {
    const ready = transfer.status === 'finished' || transfer.status === 'seeding';
    const id = String(transfer.id);
    return {
      id,
      hash: this.hashes.get(id) ?? (transfer.src ? magnetHash(transfer.src) ?? '' : ''),
      name: transfer.name ?? '',
      size: files.reduce((sum, file) => sum + file.size, 0),
      download_state: transfer.status === 'error' ? `error (${transfer.message || 'failed'})` : ready ? 'Ready' : transfer.message || transfer.status || 'Queued',
      download_finished: ready,
      download_present: ready,
      progress: ready ? 1 : Number(transfer.progress) || 0,
      download_speed: 0,
      eta: 0,
      cached: ready,
      files
    };
  }

  /** The files a finished transfer left in the cloud: its folder (a few levels down), or its one file. */
  private async filesOf(transfer: PmTransfer): Promise<Array<DebridFile & { link: string }>> {
    const key = String(transfer.id);
    const known = this.files.get(key);
    if (known && Date.now() - known.at < 30 * 60_000) return known.files;
    const files: Array<DebridFile & { link: string }> = [];
    const visit = async (folderId: string, at: string, depth: number) => {
      const { content } = await this.call<{ content: PmItem[] }>(`/folder/list?id=${encodeURIComponent(folderId)}`);
      for (const item of content ?? []) {
        const name = at ? `${at}/${item.name}` : item.name;
        if (item.type === 'folder' && depth < 3) await visit(item.id, name, depth + 1);
        else if (item.type === 'file' && item.link && (!transfer.file_id || item.id === transfer.file_id)) files.push({ id: files.length, name, size: Number(item.size) || 0, link: item.link });
      }
    };
    if (transfer.folder_id) await visit(transfer.folder_id, transfer.file_id ? '' : transfer.name ?? '', 0);
    this.files.set(key, { at: Date.now(), files });
    return files;
  }

  async list(): Promise<DebridTorrent[]> {
    return (await this.listTransfers(true)).map((transfer) => this.toTorrent(transfer));
  }

  async torrent(id: number | string): Promise<DebridTorrent | undefined> {
    const transfer = (await this.listTransfers()).find((item) => String(item.id) === String(id));
    if (!transfer) return undefined;
    const ready = transfer.status === 'finished' || transfer.status === 'seeding';
    const files = ready ? (await this.filesOf(transfer)).map(({ id: fileId, name, size }) => ({ id: fileId, name, size })) : [];
    return this.toTorrent(transfer, files);
  }

  async downloadLink(torrentId: number | string, fileId: number): Promise<string> {
    const transfer = (await this.listTransfers()).find((item) => String(item.id) === String(torrentId));
    if (!transfer) throw new DebridError(`${NAME} doesn't have that transfer any more.`, 'NO_LINK');
    const file = (await this.filesOf(transfer)).find((item) => item.id === fileId);
    if (!file) throw new DebridError(`${NAME} has no link for that file.`, 'NO_LINK');
    return file.link;
  }

  async remove(torrentId: number | string): Promise<void> {
    this.files.delete(String(torrentId));
    this.transfers = null;
    await this.call('/transfer/delete', { id: String(torrentId) });
  }
}
