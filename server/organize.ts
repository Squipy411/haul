import fs from 'node:fs';
import path from 'node:path';
import type { Job, JobFile, Resolution } from '../shared/types.js';
import { SUBTITLE_EXTENSIONS, VIDEO_EXTENSIONS, extensionOf, isExtraFile, parseEpisodeFile, subtitleLanguage } from './release.js';
import type { TorboxFile } from './torbox.js';

export interface NamingOptions {
  moviesDir: string;
  tvDir: string;
  episodeTitles: boolean;
  qualityInName: boolean;
  subtitles: boolean;
}

/** Makes a string safe as a single path segment on Linux, macOS and Windows. */
export function safeName(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (cleaned || 'Untitled').slice(0, 180);
}

const pad = (value: number) => String(value).padStart(2, '0');

const normalise = (value: string) => value.toLowerCase().replace(/\(\d{4}\)/g, '').replace(/[^a-z0-9]+/g, '');

function existingChild(parent: string, matches: (name: string) => boolean): string | undefined {
  try {
    return fs.readdirSync(parent, { withFileTypes: true }).find((entry) => entry.isDirectory() && matches(entry.name))?.name;
  } catch {
    return undefined;
  }
}

/** Reuses a show folder that already exists (e.g. "Black Mirror"), otherwise "Title (Year)". */
export function showFolder(tvDir: string, title: string, year?: number): string {
  const wanted = normalise(title);
  const withYear = year ? `${title} (${year})` : title;
  const existing = existingChild(tvDir, (name) => name === safeName(withYear))
    ?? existingChild(tvDir, (name) => normalise(name) === wanted && (!year || !/\((19|20)\d{2}\)/.test(name) || name.includes(String(year))));
  return path.join(tvDir, existing ?? safeName(withYear));
}

export function seasonFolder(showDir: string, season: number): string {
  if (season === 0) return path.join(showDir, existingChild(showDir, (name) => /^specials?$/i.test(name)) ?? 'Specials');
  const existing = existingChild(showDir, (name) => {
    const match = /^(?:season|series|s)[ ._-]*0*(\d{1,3})$/i.exec(name.trim());
    return Boolean(match && Number(match[1]) === season);
  });
  return path.join(showDir, existing ?? `Season ${pad(season)}`);
}

function qualityTag(resolution: Resolution): string {
  return resolution === 'unknown' ? '' : ` - ${resolution}`;
}

function movieBase(job: Job, naming: NamingOptions): { dir: string; base: string } {
  const title = job.year ? `${job.title} (${job.year})` : job.title;
  const dir = path.join(naming.moviesDir, safeName(title));
  return { dir, base: safeName(`${title}${naming.qualityInName ? qualityTag(job.release.info.resolution) : ''}`) };
}

function episodeBase(job: Job, naming: NamingOptions, season: number, episode: number, episodeEnd?: number): { dir: string; base: string } {
  const showTitle = job.year ? `${job.title} (${job.year})` : job.title;
  const dir = seasonFolder(showFolder(naming.tvDir, job.title, job.year), season);
  const code = `S${pad(season)}E${pad(episode)}${episodeEnd && episodeEnd > episode ? `-E${pad(episodeEnd)}` : ''}`;
  const episodeTitle = naming.episodeTitles && !episodeEnd ? job.episodeTitles?.[`${season}:${episode}`] : undefined;
  const titlePart = episodeTitle && !/^episode \d+$/i.test(episodeTitle) ? ` - ${episodeTitle}` : '';
  const quality = naming.qualityInName ? qualityTag(job.release.info.resolution) : '';
  return { dir, base: safeName(`${showTitle} - ${code}${titlePart}${quality}`) };
}

const isVideo = (file: TorboxFile) => VIDEO_EXTENSIONS.has(extensionOf(file.name));

function makeFile(file: TorboxFile, target: string, kind: JobFile['kind'], extra: Partial<JobFile> = {}): JobFile {
  return {
    key: `${file.id}`,
    torboxFileId: file.id,
    name: file.short_name || file.name.split('/').pop() || file.name,
    size: file.size,
    target,
    kind,
    downloaded: 0,
    status: 'pending',
    attempts: 0,
    ...extra
  };
}

function subtitleFor(video: TorboxFile, files: TorboxFile[], episodeCode?: string): Array<{ file: TorboxFile; lang: string }> {
  const stem = (video.short_name || video.name.split('/').pop() || '').replace(/\.[a-z0-9]{2,4}$/i, '').toLowerCase();
  const subtitles = files.filter((file) => SUBTITLE_EXTENSIONS.has(extensionOf(file.name)) && extensionOf(file.name) === 'srt');
  const related = subtitles.filter((file) => {
    const lower = file.name.toLowerCase();
    if (stem && lower.includes(stem)) return true;
    if (episodeCode && lower.includes(episodeCode.toLowerCase())) return true;
    return !episodeCode && subtitles.length <= 6;
  });
  const picked = new Map<string, { file: TorboxFile; lang: string }>();
  for (const file of related) {
    const lang = subtitleLanguage(file.name) ?? (related.length === 1 ? 'en' : null);
    if (!lang || lang !== 'en') continue;
    const existing = picked.get(lang);
    // Prefer the full English track over "forced"/"SDH" variants by taking the largest file.
    if (!existing || file.size > existing.file.size) picked.set(lang, { file, lang });
  }
  return [...picked.values()];
}

/** Chooses which TorBox files a job needs and where each one goes. */
export function planFiles(job: Job, files: TorboxFile[], naming: NamingOptions): JobFile[] {
  const videos = files.filter((file) => isVideo(file) && !isExtraFile(file.name, file.size));
  const result: JobFile[] = [];
  const used = new Set<string>();
  const unique = (dir: string, base: string, ext: string) => {
    let candidate = path.join(dir, `${base}.${ext}`);
    for (let index = 2; used.has(candidate); index += 1) candidate = path.join(dir, `${base} (${index}).${ext}`);
    used.add(candidate);
    return candidate;
  };
  const addSubtitles = (video: TorboxFile, dir: string, base: string, code?: string) => {
    if (!naming.subtitles) return;
    for (const { file, lang } of subtitleFor(video, files, code)) {
      result.push(makeFile(file, unique(dir, `${base}.${lang}`, 'srt'), 'subtitle'));
    }
  };

  if (job.type === 'movie') {
    const main = videos.sort((a, b) => b.size - a.size)[0];
    if (!main) return [];
    const { dir, base } = movieBase(job, naming);
    result.push(makeFile(main, unique(dir, base, extensionOf(main.name)), 'video'));
    addSubtitles(main, dir, base);
    return result;
  }

  const wanted = new Set(job.episodes ?? []);
  const chosen = new Map<string, { file: TorboxFile; season: number; episode: number; episodeEnd?: number }>();
  for (const file of videos) {
    const parsed = parseEpisodeFile(file.name);
    if (!parsed) continue;
    if (job.season !== undefined && parsed.season !== job.season) continue;
    if (wanted.size) {
      const span = Array.from({ length: (parsed.episodeEnd ?? parsed.episode) - parsed.episode + 1 }, (_, index) => parsed.episode + index);
      if (!span.some((episode) => wanted.has(episode))) continue;
    }
    const key = `${parsed.season}:${parsed.episode}`;
    const existing = chosen.get(key);
    if (!existing || file.size > existing.file.size) chosen.set(key, { file, ...parsed });
  }
  // A single-episode torrent whose file name has no episode number.
  if (!chosen.size && job.season !== undefined && wanted.size === 1 && videos.length) {
    const main = videos.sort((a, b) => b.size - a.size)[0]!;
    chosen.set('single', { file: main, season: job.season, episode: [...wanted][0]! });
  }
  for (const entry of [...chosen.values()].sort((a, b) => a.season - b.season || a.episode - b.episode)) {
    const { dir, base } = episodeBase(job, naming, entry.season, entry.episode, entry.episodeEnd);
    result.push(makeFile(entry.file, unique(dir, base, extensionOf(entry.file.name)), 'video', {
      season: entry.season,
      episode: entry.episode,
      episodeEnd: entry.episodeEnd
    }));
    addSubtitles(entry.file, dir, base, `S${pad(entry.season)}E${pad(entry.episode)}`);
  }
  return result;
}
