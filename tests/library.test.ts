import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/catalog', () => ({
  catalog: vi.fn(async () => []),
  meta: vi.fn(async (_type: string, id: string) => ({ id, name: 'Interstellar', year: 2014 })),
  posterFor: (id: string) => `poster/${id}`,
  backgroundFor: (id: string) => `background/${id}`
}));

const { Library } = await import('../server/library');
const { SettingsService } = await import('../server/settings');
const { optionsFromEnv } = await import('../server/config');

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('Library matches', () => {
  it('puts the folder name back when a match is removed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-library-'));
    dirs.push(dir);
    const movies = path.join(dir, 'Movies');
    fs.mkdirSync(path.join(movies, 'Big Buck Bunny (2008)'), { recursive: true });
    // Sparse, so it's big enough to count as a film without writing 20 MB.
    const file = path.join(movies, 'Big Buck Bunny (2008)', 'Big Buck Bunny (2008).mp4');
    fs.writeFileSync(file, '');
    fs.truncateSync(file, 25 * 1024 * 1024);
    const options = optionsFromEnv({ dataDir: path.join(dir, 'data'), defaults: { torboxApiKey: '', moviesDir: movies, tvDir: path.join(dir, 'TV'), incompleteDir: path.join(dir, 'tmp'), publicUrl: '' } });
    fs.mkdirSync(options.dataDir, { recursive: true });
    const library = new Library(options, new SettingsService(options));
    await library.scan();
    const item = library.summaries()[0]!;
    expect(item.title).toBe('Big Buck Bunny');

    await library.setMatch(item.id, 'tt0816692');
    expect(library.summaries()[0]).toMatchObject({ title: 'Interstellar', year: 2014, imdbId: 'tt0816692' });

    await library.setMatch(item.id, null);
    expect(library.summaries()[0]).toMatchObject({ title: 'Big Buck Bunny', year: 2008, imdbId: undefined });
  });
});

describe('Folders to play from', () => {
  it('keeps a drive’s titles while it’s offline, and drops them once it’s taken out of Settings', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-library-'));
    dirs.push(dir);
    const nas = path.join(dir, 'nas');
    fs.mkdirSync(path.join(nas, 'Sintel (2010)'), { recursive: true });
    const file = path.join(nas, 'Sintel (2010)', 'Sintel.2010.1080p.mkv');
    fs.writeFileSync(file, '');
    fs.truncateSync(file, 25 * 1024 * 1024);
    const options = optionsFromEnv({ dataDir: path.join(dir, 'data'), defaults: { torboxApiKey: '', moviesDir: path.join(dir, 'Movies'), tvDir: path.join(dir, 'TV'), incompleteDir: path.join(dir, 'tmp'), publicUrl: '' } });
    fs.mkdirSync(options.dataDir, { recursive: true });
    const settings = new SettingsService(options);
    settings.update({ extraLibraryDirs: [nas] });
    const library = new Library(options, settings);
    await library.scan();
    expect(library.summaries().map((item) => item.title)).toEqual(['Sintel']);

    // The share drops off the network: its folder can't be read.
    fs.renameSync(nas, `${nas}-away`);
    await library.scan();
    expect(library.summaries().map((item) => item.title)).toEqual(['Sintel']);

    settings.update({ extraLibraryDirs: [] });
    await library.scan();
    expect(library.summaries()).toEqual([]);
  });
});

describe('Overlapping folders', () => {
  it('reads Movies once when a folder to play from holds it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-library-'));
    dirs.push(dir);
    const media = path.join(dir, 'media');
    for (const [folder, name] of [['Movies/Up (2009)', 'Up.2009.mkv'], ['Anime/Akira (1988)', 'Akira.1988.mkv']] as const) {
      fs.mkdirSync(path.join(media, folder), { recursive: true });
      fs.writeFileSync(path.join(media, folder, name), '');
      fs.truncateSync(path.join(media, folder, name), 25 * 1024 * 1024);
    }
    const options = optionsFromEnv({ dataDir: path.join(dir, 'data'), defaults: { torboxApiKey: '', moviesDir: path.join(media, 'Movies'), tvDir: path.join(media, 'TV'), incompleteDir: path.join(dir, 'tmp'), publicUrl: '' } });
    fs.mkdirSync(options.dataDir, { recursive: true });
    const settings = new SettingsService(options);
    settings.update({ extraLibraryDirs: [media, path.join(media, 'Movies'), path.join(media, 'Anime')] });
    const library = new Library(options, settings);
    await library.scan();
    expect(library.summaries().map((item) => item.title).sort()).toEqual(['Akira', 'Up']);
  });
});
