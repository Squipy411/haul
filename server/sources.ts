import { parseSize } from './release.js';

/** A torrent found by a source, before it is classified and scored. */
export interface RawResult {
  hash: string;
  name: string;
  fileName?: string;
  fileSize?: number;
  totalSize?: number;
  seeders?: number;
  provider?: string;
  origin: string;
  multiFile: boolean;
}

const HASH = /^[a-f0-9]{40}$/i;

async function getJson(url: string, headers: Record<string, string> = {}, timeout = 15_000): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'Haul/1.0', ...headers } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Parses streams from any Stremio addon that returns torrents (infoHash), e.g. Torrentio. */
export function parseStremioStreams(streams: any[], origin: string): RawResult[] {
  const results: RawResult[] = [];
  for (const stream of streams || []) {
    const hash = String(stream?.infoHash || '').toLowerCase();
    if (!HASH.test(hash)) continue;
    const text = String(stream.title || stream.description || '');
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const statsIndex = lines.findIndex((line) => /👤|💾|⚙️|🔍/.test(line));
    const nameLines = statsIndex === -1 ? lines : lines.slice(0, statsIndex);
    const stats = statsIndex === -1 ? '' : lines.slice(statsIndex).join(' ');
    const filename = stream.behaviorHints?.filename as string | undefined;
    const name = nameLines[0] || filename || stream.name || hash;
    const fileLine = nameLines.length > 1 ? nameLines[nameLines.length - 1] : undefined;
    const seeders = /👤\s*(\d+)/.exec(stats)?.[1];
    const provider = /⚙️\s*([^\s🇦-🇿]+)/u.exec(stats)?.[1] ?? /🔍\s*([^\s]+)/u.exec(stats)?.[1];
    results.push({
      hash,
      name,
      fileName: fileLine ? fileLine.split('/').pop() : filename,
      fileSize: parseSize(/💾\s*([\d.,]+\s*[KMGT]B)/i.exec(stats)?.[1] ?? '') ?? (Number(stream.behaviorHints?.videoSize) || undefined),
      seeders: seeders ? Number(seeders) : undefined,
      provider,
      origin,
      multiFile: Boolean(fileLine)
    });
  }
  return results;
}

export async function stremioSource(baseUrl: string, type: 'movie' | 'series', id: string, origin: string): Promise<RawResult[]> {
  const base = baseUrl.replace(/\/manifest\.json$/, '').replace(/\/+$/, '');
  const data = await getJson(`${base}/stream/${type}/${encodeURIComponent(id)}.json`);
  return parseStremioStreams(data?.streams || [], origin);
}

/** TorBox's own torrent search. Optional: any failure just means no extra results. */
export async function torboxSearch(apiKey: string, imdbId: string, season?: number, episode?: number): Promise<RawResult[]> {
  if (!apiKey) return [];
  const url = new URL(`https://search-api.torbox.app/torrents/imdb:${imdbId}`);
  url.searchParams.set('metadata', 'false');
  url.searchParams.set('check_cache', 'false');
  if (season !== undefined) url.searchParams.set('season', String(season));
  if (episode !== undefined) url.searchParams.set('episode', String(episode));
  const data = await getJson(url.toString(), { Authorization: `Bearer ${apiKey}` }, 10_000);
  const torrents: any[] = data?.data?.torrents || data?.torrents || [];
  return torrents
    .map((torrent) => ({
      hash: String(torrent.hash || '').toLowerCase(),
      name: String(torrent.raw_title || torrent.title || torrent.name || ''),
      totalSize: Number(torrent.size) || undefined,
      seeders: Number(torrent.last_known_seeders ?? torrent.seeders) || undefined,
      provider: torrent.tracker || undefined,
      origin: 'TorBox',
      multiFile: false
    }))
    .filter((torrent) => HASH.test(torrent.hash) && torrent.name);
}
