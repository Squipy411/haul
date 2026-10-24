import { describe, expect, it } from 'vitest';
import { isForeignOnly, parseEpisodeFile, parseRelease, parseSeasonsAndEpisodes, parseTitleYear } from '../server/release';

describe('parseRelease', () => {
  it('reads quality, HDR, codec and audio', () => {
    const info = parseRelease('Dune - Part Two 2024 1080p BluRay DoVi HDR10 TrueHD Atmos 7 1 x265-GROUP');
    expect(info.resolution).toBe('1080p');
    expect(info.source).toBe('BluRay');
    expect(info.hdr).toEqual(['DV', 'HDR10']);
    expect(info.codec).toBe('HEVC');
    expect(info.audio).toEqual(expect.arrayContaining(['Atmos', 'TrueHD']));
  });

  it('treats 4K and UHD as 2160p and spots remuxes', () => {
    expect(parseRelease('Movie.2023.UHD.BluRay.REMUX.HDR10+.HEVC').resolution).toBe('2160p');
    expect(parseRelease('Movie.2023.UHD.BluRay.REMUX.HDR10+.HEVC').source).toBe('REMUX');
    expect(parseRelease('Movie.2023.UHD.BluRay.REMUX.HDR10+.HEVC').hdr).toEqual(['HDR10+']);
  });

  it('flags cam rips but not DTS audio', () => {
    expect(parseRelease('Movie 2025 HDCAM x264').lowQuality).toBe(true);
    expect(parseRelease('Movie 2025 1080p WEB-DL DTS x264').lowQuality).toBe(false);
  });

  it('treats a dub with an English track as watchable', () => {
    expect(isForeignOnly(parseRelease('Breaking Bad COMPLETE S01-S05 2160p WEB-DL Rus Ukr Eng DTS-HD MA5.1'))).toBe(false);
    expect(isForeignOnly(parseRelease('Во все тяжкие / Breaking Bad [S01-05] (2008-2013) BDRemux 1080p'))).toBe(true);
    expect(isForeignOnly(parseRelease('Breaking.Bad.S01.1080p.BluRay.x264'))).toBe(false);
  });

  it('keeps a telesync a telesync even when it claims to be WEB-DL', () => {
    expect(parseRelease('The-Odyssey-2026-1080p-TS-V2-WEB.DL-GP-M-NLsubs').lowQuality).toBe(true);
    expect(parseRelease('Movie.2026.1080p.HDTS.WEBRip.x264').source).toBe('CAM');
    expect(parseRelease('Movie.2026.2160p.AMZN.WEB-DL.DDP5.1.Atmos.DV.H.265-FLUX').lowQuality).toBe(false);
    expect(parseRelease('Movie.2026.1080p.WEB-DL.x264.ts').source).toBe('WEB-DL');
  });

  it('notices upscales and foreign-only releases', () => {
    expect(parseRelease('Breaking Bad. S01. 2008 2160P.Ai Upscaled.BluRay').upscaled).toBe(true);
    expect(parseRelease('Во все тяжкие / Breaking Bad / Сезон: 1 / Серии: 1-7 из 7').languages).toContain('RU');
  });
});

describe('seasons and episodes', () => {
  it.each([
    ['Show.S02E05.1080p.WEB', [2], [5]],
    ['Show S01E01-E03 720p', [1], [1, 2, 3]],
    ['Show.S01E01E02.mkv', [1], [1, 2]],
    ['Show 3x07 HDTV', [3], [7]],
    ['Breaking.Bad.S01.1080p.BluRay.x265-RARBG', [1], []],
    ['Breaking Bad (2008) Season 1-5 S01-S05 (1080p BluRay x265)', [1, 2, 3, 4, 5], []],
    ['Show Seasons 1, 2 & 3 Complete', [1, 2, 3], []],
    ['Show Season 1 2160p', [1], []],
    ['Во все тяжкие / Сезон: 1 / Серии: 1-7 из 7', [1], [1, 2, 3, 4, 5, 6, 7]]
  ])('%s', (name, seasons, episodes) => {
    const parsed = parseSeasonsAndEpisodes(name);
    expect(parsed.seasons).toEqual(seasons);
    expect(parsed.episodes).toEqual(episodes);
  });

  it('marks complete-series packs', () => {
    expect(parseSeasonsAndEpisodes('Breaking Bad Complete Series 1080p').complete).toBe(true);
  });
});

describe('parseEpisodeFile', () => {
  it.each([
    ['Pack/Breaking Bad S01E02 Cat in the Bag.mkv', { season: 1, episode: 2 }],
    ['Breaking Bad S01 1080p BluRay AV1 Opus [AV1D]/Breaking Bad S01 05.mkv', { season: 1, episode: 5 }],
    ['Show/Season 2/05 - The Title.mkv', { season: 2, episode: 5 }],
    ['Show/Season 03/Episode 7.mkv', { season: 3, episode: 7 }],
    ['Show/S01/Show.S01E09E10.mkv', { season: 1, episode: 9, episodeEnd: 10 }]
  ])('%s', (file, expected) => {
    expect(parseEpisodeFile(file)).toMatchObject(expected);
  });

  it('does not mistake a resolution for an episode', () => {
    expect(parseEpisodeFile('Movie S01 1080p.mkv')).toBeNull();
  });
});

describe('parseTitleYear', () => {
  it.each([
    ['Oppenheimer (2023)', 'Oppenheimer', 2023],
    ['Dune.Part.Two.2024.2160p.WEB-DL', 'Dune Part Two', 2024],
    ['Blade Runner 2049 (2017)', 'Blade Runner 2049', 2017],
    ['2001 A Space Odyssey (1968)', '2001 A Space Odyssey', 1968],
    ['Breaking.Bad.S01E01.720p', 'Breaking Bad', undefined]
  ])('%s', (raw, title, year) => {
    expect(parseTitleYear(raw)).toEqual({ title, year });
  });
});

describe('foreign-only releases', () => {
  it('spots Czech, Chinese and other single-language uploads', () => {
    expect(parseRelease('Hra o trůny / Game of Thrones (2011–2019)[WebRip][1080p](HEVC)(CZ)').languages).toContain('CS');
    expect(parseRelease('权力的游戏 Game.of.Thrones.S01E01.1080p').languages).toContain('ZH');
    expect(parseRelease('Game.of.Thrones.S01E01.1080p.HUN.WEB-DL').languages).toEqual(['HU']);
    expect(parseRelease('Game.of.Thrones.S01E01.1080p.BluRay.x264-DEMAND').languages).toEqual([]);
  });
});

describe('ranking languages', () => {
  it('puts an English release ahead of a bigger one that leads with a dub', async () => {
    const { scoreRelease } = await import('../server/search');
    const quality = { preferred: '1080p' as const, maxEpisodeGB: 0, maxMovieGB: 0, preferCached: true, allowHdr: true, allowUpscaled: false, preferLarger: true, blockedWords: [] };
    const release = (name: string, totalSize: number, seeders: number) => ({ hash: name, name, info: parseRelease(name), kind: 'season' as const, cached: true, origin: 'test', totalSize, seeders, packEpisodes: Array.from({ length: 10 }, (_, index) => index + 1) });
    const dubbed = release('Разделение / Severance / Сезон: 2 [2025 WEB-DL 1080p] Dub + 6 x MVO + Original + Sub (Rus Eng)', 52.4 * 1024 ** 3, 219);
    const english = release('Severance (2021) S02 (1080p ATVP WEB-DL x265 10bit EAC3 5.1 Silence) [QxR]', 16.8 * 1024 ** 3, 369);
    expect(scoreRelease(english, quality, 10)).toBeGreaterThan(scoreRelease(dubbed, quality, 10));
  });
});
