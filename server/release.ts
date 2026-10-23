import type { ReleaseInfo, Resolution } from '../shared/types.js';

// Release-name parsing. Names use dots, spaces, underscores and brackets
// interchangeably, so every token match is bounded by "not a letter or digit".
const B = '(?<![a-z0-9])';
const E = '(?![a-z0-9])';
const tok = (body: string, flags = 'i') => new RegExp(`${B}(?:${body})${E}`, flags);

const RESOLUTIONS: Array<[RegExp, Resolution]> = [
  [tok('2160p|4k|uhd|2160i'), '2160p'],
  [tok('1080p|1080i|fhd'), '1080p'],
  [tok('720p|hd720'), '720p'],
  [tok('480p|576p|360p|sd|dvdrip|dvd|xvid'), '480p']
];

const SOURCES: Array<[RegExp, string]> = [
  [tok('remux|bdremux'), 'REMUX'],
  [tok('blu-?ray|bdrip|brrip|bd25|bd50|uhd-?bluray'), 'BluRay'],
  [tok('web-?rip'), 'WEBRip'],
  [tok('web-?dl|web|amzn|nf|dsnp|hmax|atvp|pcok|pmtp|itunes'), 'WEB-DL'],
  [tok('hdtv|pdtv|dsr|tvrip'), 'HDTV'],
  [tok('dvd-?rip|dvd|dvd5|dvd9'), 'DVD'],
  [tok('cam|camrip|hdcam|ts|telesync|hdts|tc|telecine|scr|screener|hdtc|predvd'), 'CAM']
];

const LANGUAGE_TOKENS: Array<[RegExp, string]> = [
  [tok('multi'), 'MULTI'],
  [tok('dual[ .-]?audio|dual'), 'DUAL'],
  [tok('rus|russian'), 'RU'],
  [tok('ita|italian'), 'IT'],
  [tok('fre|french|vff|vf2|truefrench'), 'FR'],
  [tok('ger|german'), 'DE'],
  [tok('spa|spanish|castellano|latino'), 'ES'],
  [tok('hin|hindi'), 'HI'],
  [tok('kor|korean'), 'KO'],
  [tok('jpn|japanese'), 'JA'],
  [tok('ukr|ukrainian'), 'UK'],
  [tok('por|portuguese|dublado'), 'PT'],
  [tok('pol|polish|pldub'), 'PL'],
  [tok('tur|turkish'), 'TR']
];

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function range(start: number, end: number): number[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 60) return [start];
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function parseSeasonsAndEpisodes(raw: string): { seasons: number[]; episodes: number[]; complete: boolean } {
  const name = raw.replace(/[_]/g, ' ');
  const seasons: number[] = [];
  const episodes: number[] = [];

  // S01E01, S01E01E02, S01E01-E03, S01E01-03
  const se = new RegExp(`${B}s(\\d{1,2})[ .-]?e(\\d{1,3})(?:(?:[ .-]?-[ .-]?|[ .-]?)e?(\\d{1,3}))?${E}`, 'gi');
  for (const match of name.matchAll(se)) {
    seasons.push(Number(match[1]));
    const first = Number(match[2]);
    const second = match[3] ? Number(match[3]) : undefined;
    episodes.push(...(second && second > first ? range(first, second) : [first]));
  }
  if (!episodes.length) {
    // 1x01 style
    for (const match of name.matchAll(new RegExp(`${B}(\\d{1,2})x(\\d{2,3})${E}`, 'gi'))) {
      seasons.push(Number(match[1]));
      episodes.push(Number(match[2]));
    }
  }
  // S01-S05, S01-05, S01 to S03
  for (const match of name.matchAll(new RegExp(`${B}s(\\d{1,2})[ .]*(?:-|to|~)[ .]*s?(\\d{1,2})${E}`, 'gi'))) {
    seasons.push(...range(Number(match[1]), Number(match[2])));
  }
  // Lone S01 (not followed by E)
  for (const match of name.matchAll(new RegExp(`${B}s(\\d{1,2})${E}(?![ .-]?e\\d)`, 'gi'))) {
    seasons.push(Number(match[1]));
  }
  // Season 1, Season 01-03, Seasons 1 to 5, Seasons 1, 2 & 3
  for (const match of name.matchAll(/seasons?[ .:-]*(\d{1,2})(?!\d)((?:[ .]*(?:-|to|&|and|,)[ .]*\d{1,2}(?!\d))*)/gi)) {
    const first = Number(match[1]);
    const rest = [...(match[2] || '').matchAll(/\d{1,2}/g)].map((value) => Number(value[0]));
    if (rest.length === 1 && /-|to/i.test(match[2] || '')) seasons.push(...range(first, rest[0]!));
    else seasons.push(first, ...rest);
  }
  // Russian release conventions: "Сезон: 1", "Серии: 1-7 из 7"
  for (const match of name.matchAll(/сезон[ ы:]*(\d{1,2})(?:[ ]*-[ ]*(\d{1,2}))?/gi)) {
    seasons.push(...(match[2] ? range(Number(match[1]), Number(match[2])) : [Number(match[1])]));
  }
  for (const match of name.matchAll(/сери[ия][ :]*(\d{1,3})(?:[ ]*-[ ]*(\d{1,3}))?/gi)) {
    episodes.push(...(match[2] ? range(Number(match[1]), Number(match[2])) : [Number(match[1])]));
  }
  const complete = /complete|all[ .]seasons|full[ .]series|the[ .]complete|integrale|коллекция/i.test(name);
  return {
    seasons: unique(seasons.filter((value) => value >= 0 && value < 100)).sort((a, b) => a - b),
    episodes: unique(episodes.filter((value) => value > 0 && value < 2000)).sort((a, b) => a - b),
    complete
  };
}

export function parseRelease(raw: string): ReleaseInfo {
  const name = raw.replace(/[_]/g, ' ');
  const resolution = RESOLUTIONS.find(([pattern]) => pattern.test(name))?.[1] ?? 'unknown';
  let source = SOURCES.find(([pattern]) => pattern.test(name))?.[1];
  if (source === 'CAM' && /(?<![a-z0-9])ts(?![a-z0-9])/i.test(name) && /web|blu-?ray|hdtv/i.test(name)) source = undefined;
  if (!source && /web/i.test(name)) source = 'WEB-DL';

  const hdr: string[] = [];
  if (tok('dv|dovi|dolby[ .-]?vision').test(name)) hdr.push('DV');
  if (/hdr10(\+|plus)/i.test(name)) hdr.push('HDR10+');
  else if (tok('hdr10').test(name)) hdr.push('HDR10');
  else if (tok('hdr').test(name)) hdr.push('HDR');

  let codec: string | undefined;
  if (tok('x265|h[ .]?265|hevc').test(name)) codec = 'HEVC';
  else if (tok('x264|h[ .]?264|avc').test(name)) codec = 'H.264';
  else if (tok('av1').test(name)) codec = 'AV1';
  else if (tok('xvid|divx').test(name)) codec = 'XviD';

  const bitDepth = /10[ .-]?bit/i.test(name) ? 10 : /12[ .-]?bit/i.test(name) ? 12 : undefined;

  const audio: string[] = [];
  if (/atmos/i.test(name)) audio.push('Atmos');
  if (/truehd/i.test(name)) audio.push('TrueHD');
  if (/dts[ .-]?hd[ .-]?ma|dts[ .-]?hd/i.test(name)) audio.push('DTS-HD');
  else if (/dts[ .-]?x(?![a-z0-9])/i.test(name)) audio.push('DTS:X');
  else if (tok('dts').test(name)) audio.push('DTS');
  if (/ddp|dd\+|e-?ac-?3/i.test(name)) audio.push('DD+');
  else if (tok('dd|ac-?3|dolby[ .]digital').test(name) || /dd5|dd2/i.test(name)) audio.push('DD');
  if (tok('aac').test(name) || /aac2|aac5/i.test(name)) audio.push('AAC');
  if (tok('flac').test(name)) audio.push('FLAC');
  if (tok('opus').test(name)) audio.push('Opus');
  const channelMatch = /(?<![0-9])([257])[ .]([01])(?![0-9])/.exec(name.replace(/(ddp|dd|aac|ac3|dts|truehd|atmos)/gi, ' '));
  const channels = channelMatch ? `${channelMatch[1]}.${channelMatch[2]}` : undefined;

  const groupMatch = /-([a-z0-9]{2,20})(?:\[[^\]]*\])?(?:\.[a-z0-9]{2,4})?\s*$/i.exec(raw.trim());
  const group = groupMatch && !/^(dl|rip|hd|ma|x|\d+)$/i.test(groupMatch[1]!) ? groupMatch[1] : undefined;

  const languages = unique(LANGUAGE_TOKENS.filter(([pattern]) => pattern.test(name)).map(([, label]) => label));
  if (/[а-яё]/i.test(raw) && !languages.includes('RU')) languages.push('RU');

  const { seasons, episodes, complete } = parseSeasonsAndEpisodes(raw);
  return {
    resolution,
    source,
    hdr,
    codec,
    bitDepth,
    audio: unique(audio),
    channels,
    group,
    languages,
    seasons,
    episodes,
    complete,
    upscaled: /upscal|ai[ .-]?enhanc/i.test(name),
    threeD: tok('3d|hsbs|h-sbs|half-?sbs|half-?ou').test(name),
    lowQuality: source === 'CAM'
  };
}

export interface EpisodeRef {
  season: number;
  episode: number;
  episodeEnd?: number;
}

/** Works out the episode a file holds, using its folder names when the filename alone is ambiguous. */
export function parseEpisodeFile(filePath: string): EpisodeRef | null {
  const parts = filePath.split(/[\\/]/);
  const base = parts[parts.length - 1] ?? filePath;
  const folders = parts.slice(0, -1).reverse();
  const withEpisode = (value: string) => {
    const parsed = parseSeasonsAndEpisodes(value);
    if (parsed.episodes.length && parsed.seasons.length === 1) {
      const sorted = parsed.episodes;
      return { season: parsed.seasons[0]!, episode: sorted[0]!, episodeEnd: sorted.length > 1 ? sorted[sorted.length - 1] : undefined };
    }
    return null;
  };
  const direct = withEpisode(base);
  if (direct) return direct;
  // "Show S01 05.mkv", "Show.S01.05.mkv", "Show S1 - 05.mkv"
  const loose = new RegExp(`${B}s(\\d{1,2})[ ._-]+(?:-[ ._]*)?(\\d{1,3})(?![0-9]|p|i)`, 'i').exec(base.replace(/\.[a-z0-9]{2,4}$/i, ''));
  if (loose) return { season: Number(loose[1]), episode: Number(loose[2]) };

  // "Episode 5", "E05", "Ep05", "05 - Title" with season taken from a folder.
  let season: number | undefined;
  for (const folder of folders) {
    const parsed = parseSeasonsAndEpisodes(folder);
    if (parsed.seasons.length === 1) { season = parsed.seasons[0]; break; }
    if (/^specials?$/i.test(folder.trim())) { season = 0; break; }
  }
  const episodeMatch = /(?:^|[^a-z0-9])(?:e|ep|episode)[ .-]?(\d{1,3})(?![0-9])/i.exec(base)
    ?? /^(\d{1,3})(?:[ .-]|$)/.exec(base.replace(/\.[a-z0-9]{2,4}$/i, ''));
  if (season !== undefined && episodeMatch) return { season, episode: Number(episodeMatch[1]) };
  return null;
}

/** Extracts "Title" and year from a folder or file name like "Dune Part Two (2024)" or "Dune.Part.Two.2024.2160p...". */
export function parseTitleYear(raw: string): { title: string; year?: number } {
  let name = raw.replace(/\.[a-z0-9]{2,4}$/i, '');
  name = name.replace(/\{[^}]*\}|\[[^\]]*\]/g, ' ');
  const yearMatch = [...name.matchAll(/(?:^|[ .(_-])((?:19|20)\d{2})(?=[ .)_-]|$)/g)].filter((match) => match.index > 0).pop();
  let title = name;
  let year: number | undefined;
  if (yearMatch) {
    title = name.slice(0, yearMatch.index);
    year = Number(yearMatch[1]);
  } else {
    const cut = new RegExp(`${B}(s\\d{1,2}(e\\d{1,3})?|season|2160p|1080p|720p|480p|4k|web|bluray|hdtv|x264|x265|complete)${E}`, 'i').exec(name);
    if (cut && cut.index > 0) title = name.slice(0, cut.index);
  }
  title = title.replace(/[._]+/g, ' ').replace(/\s+-\s*$/, '').replace(/\s+/g, ' ').trim();
  return { title: title || raw, year };
}

export const VIDEO_EXTENSIONS = new Set(['mkv', 'mp4', 'm4v', 'avi', 'mov', 'ts', 'm2ts', 'wmv', 'webm', 'mpg', 'mpeg']);
export const SUBTITLE_EXTENSIONS = new Set(['srt', 'vtt', 'ass', 'ssa', 'sub']);

export function extensionOf(file: string): string {
  const match = /\.([a-z0-9]{2,5})$/i.exec(file);
  return match ? match[1]!.toLowerCase() : '';
}

const EXTRA_FOLDER = /(?:^|[\\/])(extras?|featurettes?|behind[ .]the[ .]scenes|deleted[ .]scenes|trailers?|interviews?|bonus|samples?)(?:[\\/]|$)/i;

export function isExtraFile(filePath: string, size: number): boolean {
  if (EXTRA_FOLDER.test(filePath)) return true;
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  if (/(?<![a-z0-9])sample(?![a-z0-9])/i.test(base) && size < 1_500_000_000) return true;
  if (/(?<![a-z0-9])(trailer|featurette|extra|behind the scenes)(?![a-z0-9])/i.test(base) && size < 1_500_000_000) return true;
  return false;
}

export function subtitleLanguage(filePath: string): string | null {
  const name = filePath.toLowerCase();
  if (/(?<![a-z])(eng|english|en)(?![a-z])/.test(name)) return 'en';
  if (/(?<![a-z])(spa|spanish|es)(?![a-z])/.test(name)) return 'es';
  if (/(?<![a-z])(fre|french|fr)(?![a-z])/.test(name)) return 'fr';
  if (/(?<![a-z])(ger|german|de)(?![a-z])/.test(name)) return 'de';
  return null;
}

export function resolutionRank(resolution: Resolution): number {
  return { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1, unknown: 0 }[resolution];
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function parseSize(text: string): number | undefined {
  const match = /([\d.,]+)\s*(tb|gb|mb|kb)/i.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]!.replace(',', '.'));
  const multiplier = { tb: 1024 ** 4, gb: 1024 ** 3, mb: 1024 ** 2, kb: 1024 }[match[2]!.toLowerCase() as 'tb' | 'gb' | 'mb' | 'kb'];
  return Number.isFinite(value) ? Math.round(value * multiplier) : undefined;
}
