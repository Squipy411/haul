import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderStatus, listFolder } from '../server/folders';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('Folder picker', () => {
  it('lists subfolders only, in natural order, with the way back up', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-folders-'));
    dirs.push(dir);
    for (const name of ['Season 10', 'Season 2', '.hidden', '@eaDir']) fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, 'film.mkv'), '');
    const listing = await listFolder(dir, [path.join(dir, 'Season 2')]);
    expect(listing.path).toBe(dir);
    expect(listing.parent).toBe(path.dirname(dir));
    expect(listing.folders.map((folder) => folder.name)).toEqual(['Season 2', 'Season 10']);
    expect(listing.roots).toContain(dir);
    await expect(listFolder(path.join(dir, 'missing'), [])).rejects.toThrow(/doesn't exist/);
  });

  it('says which folders are reachable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-folders-'));
    dirs.push(dir);
    const [here, gone, later] = await folderStatus([{ path: dir, role: 'movies' }, { path: path.join(dir, 'offline-nas'), role: 'extra' }, { path: path.join(dir, 'incomplete'), role: 'downloads' }]);
    expect(later).toMatchObject({ reachable: true, notYet: true });
    expect(here).toMatchObject({ reachable: true, writable: true });
    expect(here!.free).toBeGreaterThan(0);
    expect(gone).toMatchObject({ reachable: false, role: 'extra' });
  });
});
