import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Job } from '../shared/types';
import { planFiles, safeName } from '../server/organize';
import { parseRelease } from '../server/release';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-organize-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const naming = { moviesDir: path.join(root, 'Movies'), tvDir: path.join(root, 'TV Shows'), episodeTitles: true, qualityInName: true, subtitles: true };

function job(partial: Partial<Job>): Job {
  return {
    id: 'job', type: 'series', imdbId: 'tt0903747', title: 'Breaking Bad', year: 2008, label: '', status: 'torbox', torbox: {}, files: [], speed: 0,
    createdAt: 0, updatedAt: 0,
    release: { hash: 'x'.repeat(40), name: 'Breaking.Bad.S01.1080p', kind: 'season', cached: true, info: parseRelease('Breaking.Bad.S01.1080p'), origin: 'test' },
    ...partial
  };
}

// File listings below are shaped like real TorBox season packs.
const joyPack = [
  { id: 12, name: 'Breaking Bad Season 1 (2160p x265 10bit Joy)/Extras/Breaking Bad - S01 Extra - Inside Breaking Bad.m4v', size: 51_048_063 },
  ...[1, 2, 3, 4, 5, 6, 7].map((episode) => ({ id: episode, name: `Breaking Bad Season 1 (2160p x265 10bit Joy)/Breaking Bad S01E0${episode} (2160p x265 10bit Joy).mkv`, size: 900_000_000 + episode })),
  { id: 20, name: 'Breaking Bad Season 1 (2160p x265 10bit Joy)/Subs/Breaking Bad S01E02 English.srt', size: 40_000 },
  { id: 21, name: 'Breaking Bad Season 1 (2160p x265 10bit Joy)/Subs/Breaking Bad S01E02 French.srt', size: 41_000 }
];

describe('planFiles', () => {
  it('takes only the requested episodes from a season pack and skips extras', () => {
    const files = planFiles(job({ season: 1, episodes: [2, 3], episodeTitles: { '1:2': "Cat's in the Bag...", '1:3': '...And the Bag\'s in the River' } }), joyPack, naming);
    const videos = files.filter((file) => file.kind === 'video');
    expect(videos.map((file) => file.episode)).toEqual([2, 3]);
    expect(videos[0]!.target).toBe(path.join(naming.tvDir, 'Breaking Bad (2008)', 'Season 01', "Breaking Bad (2008) - S01E02 - Cat's in the Bag... - 1080p.mkv"));
    const subtitles = files.filter((file) => file.kind === 'subtitle');
    expect(subtitles).toHaveLength(1);
    expect(subtitles[0]!.target.endsWith('S01E02 - Cat\'s in the Bag... - 1080p.en.srt')).toBe(true);
  });

  it('takes one season out of a complete-series pack', () => {
    const pack = [1, 2].flatMap((season) => [1, 2].map((episode) => ({ id: season * 10 + episode, name: `BB.S01-S02/Season ${season}/BB.S0${season}E0${episode}.mkv`, size: 1_000_000_000 })));
    const files = planFiles(job({ season: 2, episodes: [1, 2] }), pack, naming);
    expect(files.map((file) => [file.season, file.episode])).toEqual([[2, 1], [2, 2]]);
  });

  it('reuses an existing show and season folder', () => {
    fs.mkdirSync(path.join(naming.tvDir, 'Black Mirror', 'Season 1'), { recursive: true });
    const files = planFiles(job({ title: 'Black Mirror', year: 2011, season: 1, episodes: [1] }), [{ id: 1, name: 'Black.Mirror.S01E01.mkv', size: 1 }], naming);
    expect(path.dirname(files[0]!.target)).toBe(path.join(naming.tvDir, 'Black Mirror', 'Season 1'));
  });

  it('assigns a single-episode torrent without numbers to the requested episode', () => {
    const files = planFiles(job({ season: 4, episodes: [6] }), [{ id: 0, name: 'random-name.mkv', size: 1 }], naming);
    expect(files[0]).toMatchObject({ season: 4, episode: 6 });
  });

  it('picks the main movie file', () => {
    const files = planFiles(job({ type: 'movie', title: 'Sintel', year: 2010, release: { ...job({}).release, info: parseRelease('Sintel 2010 720p') } }), [
      { id: 0, name: 'Sintel/sample.mkv', size: 10_000_000 },
      { id: 1, name: 'Sintel/Sintel.2010.720p.mkv', size: 140_000_000 },
      { id: 2, name: 'Sintel/Sintel.2010.720p.en.srt', size: 2_000 }
    ], naming);
    expect(files.map((file) => path.basename(file.target))).toEqual(['Sintel (2010) - 720p.mkv', 'Sintel (2010) - 720p.en.srt']);
  });
});

describe('safeName', () => {
  it('removes characters Windows and Linux cannot store', () => {
    expect(safeName('What If...? : "Part" 1/2 ')).toBe('What If... Part 1 2');
  });
});
