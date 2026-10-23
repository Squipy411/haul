import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Meta } from '../shared/types';
import { type Probe, chooseMode, ffmpegArgs, languageName, parseProbe, srtToVtt, trackLabel } from '../server/media';
import { clockSeconds, languageTier, nextEpisode, rewritePlaylist, trackFor } from '../server/play';
import { parseRelease } from '../server/release';
import { ProgressStore, progressKey } from '../server/progress';

const caps = { hevc: false, av1: false, ac3: false };
const probe = (video: string, audio: string, extra: Partial<Probe> = {}): Probe => ({
  duration: 1342, container: 'matroska,webm',
  video: { codec: video, pixFmt: 'yuv420p', width: 1920, height: 1080 },
  audios: [{ index: 0, codec: audio, channels: 6, language: 'eng', default: true }],
  subtitles: [],
  ...extra
});

describe('chooseMode', () => {
  it('plays browser-ready MP4 as it is', () => {
    expect(chooseMode('/m/Film.mp4', probe('h264', 'aac'), caps, 0, true)).toBe('direct');
  });
  it('rewraps MKV and Dolby audio without touching the picture', () => {
    expect(chooseMode('/m/Show.mkv', probe('h264', 'aac'), caps, 0, true)).toBe('remux');
    expect(chooseMode('/m/Film.mp4', probe('h264', 'eac3'), caps, 0, true)).toBe('remux');
  });
  it('converts video the browser cannot decode', () => {
    expect(chooseMode('/m/Film.mkv', probe('hevc', 'aac'), caps, 0, true)).toBe('transcode');
    expect(chooseMode('/m/Film.mkv', probe('hevc', 'aac'), { ...caps, hevc: true }, 0, true)).toBe('remux');
    expect(chooseMode('/m/Anime.mkv', probe('h264', 'aac', { video: { codec: 'h264', pixFmt: 'yuv420p10le', width: 1920, height: 1080 } }), caps, 0, true)).toBe('transcode');
  });
  it('tries the file as it is when ffmpeg is missing', () => {
    expect(chooseMode('/m/Show.mkv', null, caps, 0, false)).toBe('direct');
  });
});

describe('ffmpegArgs', () => {
  it('copies the picture and converts Dolby audio when rewrapping', () => {
    const args = ffmpegArgs('/m/a.mkv', { start: 95, audio: 0, mode: 'remux', probe: probe('hevc', 'eac3'), caps: { ...caps, hevc: true } }, '/tmp/x').join(' ');
    expect(args).toContain('-ss 95.000 -i /m/a.mkv');
    expect(args).toContain('-c:v copy -tag:v hvc1');
    expect(args).toContain('-c:a aac');
    expect(args).toContain('-f hls');
    expect(args).toContain('/tmp/x/playlist.m3u8');
  });
  it('scales 4K down when it has to convert', () => {
    const args = ffmpegArgs('/m/a.mkv', { start: 0, audio: 1, mode: 'transcode', probe: probe('hevc', 'aac', { video: { codec: 'hevc', width: 3840, height: 2160 } }), caps }, '/tmp/x').join(' ');
    expect(args).toContain('-c:v libx264');
    expect(args).toContain('scale=-2:1080');
    expect(args).toContain('-map 0:a:1?');
    expect(args).not.toContain('-ss');
  });
});

describe('parseProbe', () => {
  it('counts audio and subtitle tracks from zero and spots text subtitles', () => {
    const parsed = parseProbe({
      format: { duration: '1342.07', format_name: 'matroska,webm' },
      streams: [
        { codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, pix_fmt: 'yuv420p10le' },
        { codec_type: 'audio', codec_name: 'eac3', channels: 6, tags: { language: 'eng' }, disposition: { default: 1 } },
        { codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'jpn', title: 'Commentary' } },
        { codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
        { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' } }
      ]
    });
    expect(parsed.duration).toBeCloseTo(1342.07);
    expect(parsed.audios.map((audio) => audio.index)).toEqual([0, 1]);
    expect(parsed.subtitles.map((subtitle) => subtitle.text)).toEqual([true, false]);
    expect(trackLabel(parsed.audios[0]!, 'audio')).toBe('English 5.1');
    expect(trackLabel(parsed.audios[1]!, 'audio')).toBe('Japanese (Commentary)');
  });
});

describe('srtToVtt', () => {
  it('adds the header and swaps decimal commas', () => {
    expect(srtToVtt('﻿1\r\n00:00:01,500 --> 00:00:03,000\r\nHello\r\n')).toBe('WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.000\nHello\n');
  });
});

describe('rewritePlaylist', () => {
  const upstream = 'https://flux-005.wnam.tb-cdn.io/stream/abc/null/null/0/playlist.m3u8?token=SECRETKEY&scrobbling_enabled=false';
  it('sends segments to the CDN without the API key and nested playlists back through Haul', () => {
    const out = rewritePlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5.0,\nvideo1.ts\naudio/index.m3u8\nhttps://flux-005.wnam.tb-cdn.io/x/video2.ts?token=SECRETKEY', upstream, 'SECRETKEY', (absolute) => `/proxy?u=${encodeURIComponent(absolute)}`);
    expect(out).not.toContain('SECRETKEY');
    expect(out).toContain('https://flux-005.wnam.tb-cdn.io/stream/abc/null/null/0/video1.ts');
    expect(out).toContain('URI="https://flux-005.wnam.tb-cdn.io/stream/abc/null/null/0/init.mp4"');
    expect(out).toContain('/proxy?u=https%3A%2F%2Fflux-005.wnam.tb-cdn.io%2Fstream%2Fabc%2Fnull%2Fnull%2F0%2Faudio%2Findex.m3u8');
  });
});

describe('episodes and times', () => {
  const meta = { id: 'tt1', type: 'series', name: 'Show', seasons: [1, 2], episodes: [
    { id: 'a', season: 1, episode: 1, title: 'One', released: '2020-01-01' },
    { id: 'b', season: 1, episode: 2, title: 'Two', released: '2020-01-08' },
    { id: 'c', season: 2, episode: 1, title: 'Three', released: '2021-01-01' },
    { id: 'd', season: 2, episode: 2, title: 'Four', released: '2999-01-01' }
  ] } as Meta;
  it('finds the next aired episode, across seasons', () => {
    expect(nextEpisode(meta, 1, 1)).toEqual({ season: 1, episode: 2, title: 'Two' });
    expect(nextEpisode(meta, 1, 2)).toEqual({ season: 2, episode: 1, title: 'Three' });
    expect(nextEpisode(meta, 2, 1)).toBeUndefined();
  });
  it('reads TorBox durations', () => {
    expect(clockSeconds('0:22:22.078000')).toBeCloseTo(1342.078);
    expect(clockSeconds(undefined)).toBeUndefined();
  });
});

describe('ProgressStore', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
  it('resumes only started, unfinished titles and keeps one entry per show', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-progress-'));
    dirs.push(dir);
    const store = new ProgressStore(dir);
    const base = { type: 'series' as const, imdbId: 'tt1', title: 'Show', duration: 1000 };
    store.save({ ...base, key: progressKey('series', 'tt1', 1, 1), season: 1, episode: 1, position: 950 });
    store.save({ ...base, key: progressKey('series', 'tt1', 1, 2), season: 1, episode: 2, position: 400 });
    store.save({ ...base, key: progressKey('movie', 'tt2'), type: 'movie', imdbId: 'tt2', position: 20 });
    expect(store.resumeAt(progressKey('series', 'tt1', 1, 2))).toBe(397);
    expect(store.resumeAt(progressKey('series', 'tt1', 1, 1))).toBeUndefined();
    expect(store.resumeAt(progressKey('movie', 'tt2'))).toBeUndefined();
    expect(store.recent().map((entry) => entry.key)).toEqual([progressKey('series', 'tt1', 1, 2)]);
  });
});

describe('languageTier', () => {
  it('plays English releases before multi-language ones, and dubs last', () => {
    expect(languageTier(parseRelease('Interstellar.2014.1080p.BluRay.x264-SPARKS'))).toBe(0);
    expect(languageTier(parseRelease('Interstellar.2014.1080p.BluRay.ENG.x264'))).toBe(0);
    expect(languageTier(parseRelease('Интерстеллар / Interstellar [2014 BDRip 1080p] Dub + MVO + Original Eng'))).toBe(1);
    expect(languageTier(parseRelease('Интерстеллар (2014) BDRip 1080p Dub'))).toBe(2);
  });
});

describe('language choices', () => {
  it('reads codes and names the same way', () => {
    expect(languageName('eng')).toBe('English');
    expect(languageName('en')).toBe('English');
    expect(languageName('english')).toBe('English');
    expect(languageName('und')).toBeUndefined();
    expect(languageName('tha')).toBe('Thai');
    expect(languageName('xyz')).toBe('XYZ');
    expect(trackLabel({ index: 0, language: 'eng', title: 'English (SDH)' }, 'subtitle')).toBe('English (SDH)');
    expect(trackLabel({ index: 3, language: 'spa', title: 'Español (Latinoamérica)' }, 'subtitle')).toBe('Spanish · Español (Latinoamérica)');
  });
  it('picks a full subtitle track in your language before a forced one', () => {
    const tracks = [
      { language: 'spa', title: null },
      { language: 'eng', title: 'Forced' },
      { language: 'eng', title: 'SDH' }
    ];
    expect(trackFor(tracks, 'English')).toBe(2);
    expect(trackFor([{ language: 'eng', forced: true }], 'English')).toBe(0);
    expect(trackFor(tracks, 'Japanese')).toBe(-1);
    expect(trackFor(tracks, undefined)).toBe(-1);
  });
});
