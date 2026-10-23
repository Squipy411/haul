import { describe, expect, it } from 'vitest';
import { parseEpisodeFile, parseRelease, parseSeasonsAndEpisodes, parseTitleYear } from '../server/release';

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
