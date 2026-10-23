import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Job, LibraryFile, LibraryItem, LibrarySummary, MediaType } from '../shared/types.js';
import { backgroundFor, catalog, meta as fetchMeta, posterFor } from './catalog.js';
import type { ServerOptions } from './config.js';
import {
  SUBTITLE_EXTENSIONS, VIDEO_EXTENSIONS, extensionOf, isExtraFile, parseEpisodeFile, parseRelease, parseTitleYear, subtitleLanguage
} from './release.js';
import type { SettingsService } from './settings.js';
import { JsonFile } from './store.js';

interface MatchRecord {
  imdbId: string | null;
  source: 'haul' | 'folder' | 'search' | 'manual';
  title?: string;
  year?: number;
  checkedAt: number;
}

interface LibraryData {
  items: LibraryItem[];
  matches: Record<string, MatchRecord>;
  scannedAt?: number;
}

interface FoundVideo {
  path: string;
  size: number;
  mtime: number;
  subtitles: { lang: string; path: string }[];
}

const MIN_VIDEO_BYTES = 20 * 1024 * 1024;
/** The same folder, or one inside it. */
const within = (child: string, parent: string) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const hashId = (value: string, length = 20) => crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
const normalise = (value: string) => value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

async function listVideos(dir: string, depth = 4): Promise<FoundVideo[]> {
  const found: FoundVideo[] = [];
  async function visit(current: string, level: number): Promise<void> {
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
    const names = entries.map((entry) => entry.name);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('@')) continue;
      const full = path.join(current, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try { const stat = await fsp.stat(full); isDir = stat.isDirectory(); isFile = stat.isFile(); } catch { continue; }
      }
      if (isDir && level < depth) { await visit(full, level + 1); continue; }
      if (!isFile || !VIDEO_EXTENSIONS.has(extensionOf(entry.name))) continue;
      let stat;
      try { stat = await fsp.stat(full); } catch { continue; }
      if (stat.size < MIN_VIDEO_BYTES || isExtraFile(full, stat.size)) continue;
      const stem = entry.name.replace(/\.[^.]+$/, '');
      const subtitles = names
        .filter((name) => name !== entry.name && name.startsWith(stem) && SUBTITLE_EXTENSIONS.has(extensionOf(name)) && ['srt', 'vtt'].includes(extensionOf(name)))
        .map((name) => ({ lang: subtitleLanguage(name.slice(stem.length)) ?? 'und', path: path.join(current, name) }));
      found.push({ path: full, size: stat.size, mtime: stat.mtimeMs, subtitles });
    }
  }
  await visit(dir, 0);
  return found;
}

export class Library {
  private readonly file: JsonFile<LibraryData>;
  private scanning: Promise<void> | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private fileIndex = new Map<string, { item: LibraryItem; file: LibraryFile }>();

  constructor(private readonly options: ServerOptions, private readonly settings: SettingsService) {
    this.file = new JsonFile(path.join(options.dataDir, 'library.json'), () => ({ items: [], matches: {} }));
    this.reindex();
  }

  start(): void {
    void this.scan();
    const schedule = () => {
      if (this.intervalTimer) clearInterval(this.intervalTimer);
      const minutes = this.settings.value.library.rescanMinutes;
      if (minutes > 0) this.intervalTimer = setInterval(() => void this.scan(), minutes * 60_000);
    };
    schedule();
    this.settings.onChange(schedule);
  }

  stop(): void {
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.file.flush();
  }

  get items(): LibraryItem[] {
    return this.file.data.items;
  }

  get isScanning(): boolean {
    return Boolean(this.scanning);
  }

  get scannedAt(): number | undefined {
    return this.file.data.scannedAt;
  }

  private reindex(): void {
    this.fileIndex.clear();
    for (const item of this.items) for (const file of item.files) this.fileIndex.set(file.id, { item, file });
  }

  scheduleScan(delayMs = 3000): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => { this.rescanTimer = null; void this.scan(); }, delayMs);
  }

  scan(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.performScan()
      .catch((error) => console.error('[library] scan failed', error))
      .finally(() => { this.scanning = null; });
    return this.scanning;
  }

  private async performScan(): Promise<void> {
    const settings = this.settings.value;
    const previous = new Map<string, LibraryFile>();
    for (const item of this.items) for (const file of item.files) previous.set(file.path, file);
    const items: LibraryItem[] = [];

    const addItem = (type: MediaType, key: string, folder: string, title: string, year: number | undefined, videos: FoundVideo[]) => {
      const files: LibraryFile[] = [];
      for (const video of videos) {
        const relative = path.relative(folder, video.path) || path.basename(video.path);
        const release = parseRelease(path.basename(video.path));
        const episode = type === 'series' ? parseEpisodeFile(relative) : null;
        if (type === 'series' && !episode) continue;
        const before = previous.get(video.path);
        files.push({
          id: hashId(video.path),
          path: video.path,
          relative,
          size: video.size,
          mtime: video.mtime,
          addedAt: before?.addedAt ?? Math.min(Date.now(), video.mtime || Date.now()),
          season: episode?.season,
          episode: episode?.episode,
          episodeEnd: episode?.episodeEnd,
          resolution: release.resolution,
          tags: [...release.hdr, release.codec, release.source].filter((tag): tag is string => Boolean(tag)),
          subtitles: video.subtitles
        });
      }
      if (!files.length) return;
      files.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || b.size - a.size);
      items.push({
        id: hashId(key, 16),
        key,
        type,
        title,
        year,
        folderTitle: title,
        folderYear: year,
        folder,
        addedAt: Math.max(...files.map((file) => file.addedAt)),
        files
      });
    };

    const scanRoot = async (root: string, kind: MediaType | 'auto') => {
      let entries;
      try {
        entries = await fsp.readdir(root, { withFileTypes: true });
      } catch {
        // A network drive that's offline (or a USB drive unplugged) keeps its titles until it's back.
        const inside = (folder: string) => folder === root || folder.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
        for (const item of this.items) if (inside(item.folder) && !items.some((kept) => kept.key === item.key)) items.push(item);
        return;
      }
      const looseSeries = new Map<string, FoundVideo[]>();
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name.startsWith('@')) continue;
        const full = path.join(root, entry.name);
        let isDir = entry.isDirectory();
        if (entry.isSymbolicLink()) { try { isDir = (await fsp.stat(full)).isDirectory(); } catch { continue; } }
        // A folder to play from that holds Movies, Shows, downloads or another folder to play from:
        // that one is read on its own terms, not taken for a title.
        if (kind === 'auto' && isDir && separateFolders.some((other) => path.resolve(other) !== path.resolve(root) && within(other, full))) continue;
        if (isDir) {
          const videos = await listVideos(full);
          if (!videos.length) continue;
          const type: MediaType = kind === 'auto'
            ? (videos.filter((video) => parseEpisodeFile(path.relative(full, video.path))).length > videos.length / 2 ? 'series' : 'movie')
            : kind;
          const parsed = parseTitleYear(entry.name);
          addItem(type, `${type}:${full}`, full, parsed.title, parsed.year, videos);
        } else if (VIDEO_EXTENSIONS.has(extensionOf(entry.name))) {
          const videos = (await listVideos(root, 0)).filter((video) => video.path === full);
          if (!videos.length) continue;
          const episode = parseEpisodeFile(entry.name);
          const parsed = parseTitleYear(entry.name);
          if ((kind === 'series' || kind === 'auto') && episode) {
            const group = looseSeries.get(parsed.title) ?? [];
            group.push(...videos);
            looseSeries.set(parsed.title, group);
          } else if (kind !== 'series') {
            addItem('movie', `movie:${full}`, root, parsed.title, parsed.year, videos);
          }
        }
      }
      for (const [title, videos] of looseSeries) addItem('series', `series:${root}#${title}`, root, title, undefined, videos);
    };

    const ownFolders = [settings.moviesDir, settings.tvDir, settings.incompleteDir];
    const separateFolders = [...ownFolders, ...settings.extraLibraryDirs];
    await scanRoot(settings.moviesDir, 'movie');
    await scanRoot(settings.tvDir, 'series');
    // Skipped when it's inside Movies or Shows (already read) or listed twice.
    for (const [index, dir] of settings.extraLibraryDirs.entries()) {
      if (ownFolders.some((own) => within(dir, own)) || settings.extraLibraryDirs.slice(0, index).some((other) => path.resolve(other) === path.resolve(dir))) continue;
      await scanRoot(dir, 'auto');
    }

    this.file.data.items = items;
    this.file.data.scannedAt = Date.now();
    this.applyMatches();
    this.reindex();
    this.file.save();
    await this.matchUnknown();
  }

  private applyMatches(): void {
    for (const item of this.items) {
      // Items saved by older versions don't have the folder's own name until the next scan.
      item.folderTitle ??= item.title;
      item.folderYear ??= item.year;
      const fromFolder = /(?:imdb[-=]?|\[|\{)?(tt\d{6,10})/i.exec(path.basename(item.key.replace(/^[a-z]+:/, '')))?.[1];
      const record = this.file.data.matches[item.key];
      const imdbId = fromFolder ?? record?.imdbId ?? undefined;
      item.imdbId = imdbId || undefined;
      item.matchSource = fromFolder ? 'folder' : record?.imdbId ? record.source : undefined;
      item.title = record?.imdbId && record.title ? record.title : item.folderTitle;
      item.year = record?.imdbId && record.year ? record.year : item.folderYear;
      item.poster = item.imdbId ? posterFor(item.imdbId) : undefined;
      item.background = item.imdbId ? backgroundFor(item.imdbId) : undefined;
    }
  }

  /** Looks up IMDb ids for folders Haul did not download itself, a few at a time. */
  private async matchUnknown(): Promise<void> {
    const pending = this.items.filter((item) => !item.imdbId && !this.file.data.matches[item.key]);
    for (const item of pending.slice(0, 60)) {
      let record: MatchRecord = { imdbId: null, source: 'search', checkedAt: Date.now() };
      try {
        const results = await catalog(item.type, 'top', { search: item.title });
        const wanted = normalise(item.title);
        const candidates = results.filter((result) => normalise(result.name) === wanted);
        const byYear = candidates.find((result) => item.year && result.releaseInfo?.includes(String(item.year)))
          ?? candidates.find((result) => item.year && [item.year - 1, item.year + 1].some((year) => result.releaseInfo?.includes(String(year))));
        const best = byYear ?? (!item.year ? candidates[0] : undefined) ?? (candidates.length === 1 ? candidates[0] : undefined);
        if (best) record = { imdbId: best.id, source: 'search', title: best.name, year: Number(best.releaseInfo?.slice(0, 4)) || item.year, checkedAt: Date.now() };
      } catch {
        continue; // network trouble: try again on the next scan
      }
      this.file.data.matches[item.key] = record;
    }
    this.applyMatches();
    this.file.save();
  }

  /** Remembers what Haul downloaded so those folders never need a guess. */
  recordDownload(job: Job): void {
    const settings = this.settings.value;
    for (const file of job.files) {
      if (file.kind !== 'video' || (file.status !== 'done' && file.status !== 'skipped')) continue;
      let folder = path.dirname(file.target);
      if (job.type === 'series') {
        const root = path.resolve(settings.tvDir);
        while (path.dirname(folder) !== root && path.dirname(folder) !== folder) folder = path.dirname(folder);
      }
      this.file.data.matches[`${job.type}:${folder}`] = { imdbId: job.imdbId, source: 'haul', title: job.title, year: job.year, checkedAt: Date.now() };
    }
    this.file.save();
    this.scheduleScan(1500);
  }

  /** A video added from the browser: when it was dropped on a title, that title is the match. */
  recordUpload(added: { type: MediaType; folder: string; imdbId?: string; title: string; year?: number }): void {
    if (added.imdbId) this.file.data.matches[`${added.type}:${added.folder}`] = { imdbId: added.imdbId, source: 'haul', title: added.title, year: added.year, checkedAt: Date.now() };
    this.file.save();
    this.scheduleScan(500);
  }

  async setMatch(itemId: string, imdbId: string | null): Promise<LibraryItem | undefined> {
    const item = this.items.find((candidate) => candidate.id === itemId);
    if (!item) return undefined;
    if (imdbId) {
      const info = await fetchMeta(item.type, imdbId);
      this.file.data.matches[item.key] = { imdbId, source: 'manual', title: info.name, year: info.year, checkedAt: Date.now() };
    } else {
      this.file.data.matches[item.key] = { imdbId: null, source: 'manual', checkedAt: Date.now() };
    }
    this.applyMatches();
    this.file.save();
    return item;
  }

  summaries(): LibrarySummary[] {
    return this.items
      .map((item) => ({
        id: item.id,
        type: item.type,
        imdbId: item.imdbId,
        title: item.title,
        year: item.year,
        poster: item.poster,
        background: item.background,
        folder: item.folder,
        addedAt: item.addedAt,
        fileCount: item.files.length,
        size: item.files.reduce((sum, file) => sum + file.size, 0),
        seasons: [...new Set(item.files.map((file) => file.season).filter((season): season is number => season !== undefined))].sort((a, b) => a - b),
        matched: Boolean(item.imdbId)
      }))
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  get(itemId: string): LibraryItem | undefined {
    return this.items.find((item) => item.id === itemId);
  }

  lookupFile(fileId: string): { item: LibraryItem; file: LibraryFile } | undefined {
    return this.fileIndex.get(fileId);
  }

  byImdb(type: MediaType, imdbId: string): LibraryItem[] {
    return this.items.filter((item) => item.type === type && item.imdbId === imdbId);
  }

  ownedEpisodes(imdbId: string): Set<string> {
    const owned = new Set<string>();
    for (const item of this.byImdb('series', imdbId)) {
      for (const file of item.files) {
        if (file.season === undefined || file.episode === undefined) continue;
        for (let episode = file.episode; episode <= (file.episodeEnd ?? file.episode); episode += 1) owned.add(`${file.season}:${episode}`);
      }
    }
    return owned;
  }

  ownsMovie(imdbId: string): boolean {
    return this.byImdb('movie', imdbId).length > 0;
  }

  ownedImdbIds(): Set<string> {
    return new Set(this.items.map((item) => item.imdbId).filter((id): id is string => Boolean(id)));
  }

  counts(): { movies: number; series: number; episodes: number } {
    let movies = 0;
    let series = 0;
    let episodes = 0;
    for (const item of this.items) {
      if (item.type === 'movie') movies += 1;
      else { series += 1; episodes += item.files.length; }
    }
    return { movies, series, episodes };
  }
}
