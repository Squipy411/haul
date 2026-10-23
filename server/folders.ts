import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FolderListing, FolderStatus } from '../shared/types.js';
import { HttpError } from './http.js';

// Picking folders without typing container paths: Haul lists the folders it can see, starting from the
// places media usually lives. In Docker those are the mounted ones (/media, and /drives for network
// shares and USB drives on ZimaOS); in the Windows app, the drive letters.

const PLACES = ['/media', '/drives', '/mnt', '/data/media', '/srv', '/share', '/volume1'];

function windowsDrives(): string[] {
  return 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `${letter}:\\`).filter((drive) => {
    try { return fs.statSync(drive).isDirectory(); } catch { return false; }
  });
}

/** Where the folder picker starts: the usual media places that exist here, and your current folders' parents. */
export function folderRoots(current: string[]): string[] {
  const roots = process.platform === 'win32' ? windowsDrives() : PLACES.filter((place) => { try { return fs.statSync(place).isDirectory(); } catch { return false; } });
  for (const folder of current) {
    const parent = path.dirname(folder);
    if (folder && parent !== folder && !roots.some((root) => parent === root || parent.startsWith(root + path.sep))) roots.push(parent);
  }
  return [...new Set(roots)];
}

export async function listFolder(target: string, current: string[]): Promise<FolderListing> {
  const roots = folderRoots(current);
  if (!target) return { path: '', parent: null, folders: roots.map((root) => ({ name: root, path: root })), roots };
  const resolved = path.resolve(target);
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(resolved, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new HttpError(400, code === 'ENOENT' ? `${resolved} doesn't exist here.` : code === 'EACCES' || code === 'EPERM' ? `Haul isn't allowed to open ${resolved}.` : `Haul can't open ${resolved}.`);
  }
  const folders: FolderListing['folders'] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('@') || entry.name.startsWith('$')) continue;
    const full = path.join(resolved, entry.name);
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) { try { isDir = (await fsp.stat(full)).isDirectory(); } catch { isDir = false; } }
    if (isDir) folders.push({ name: entry.name, path: full });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const parent = path.dirname(resolved);
  return { path: resolved, parent: parent === resolved ? '' : parent, folders, roots };
}

/** Whether each folder is there and how much room it has: a network drive that's offline shows up here. */
export async function folderStatus(folders: Array<{ path: string; role: FolderStatus['role'] }>): Promise<FolderStatus[]> {
  return Promise.all(folders.filter((folder) => folder.path).map(async (folder) => {
    try {
      await fsp.readdir(folder.path);
      const stats = await fsp.statfs(folder.path).catch(() => null);
      let writable = true;
      try { await fsp.access(folder.path, fs.constants.W_OK); } catch { writable = false; }
      return { ...folder, reachable: true, writable, free: stats ? stats.bavail * stats.bsize : undefined, total: stats ? stats.blocks * stats.bsize : undefined };
    } catch {
      // Movies, Shows and downloads are made the first time they're needed, if the drive they're on is there.
      if (folder.role !== 'extra') {
        // The nearest folder above it that exists, a few levels up at most (not "/" for a missing drive).
        let parent = path.dirname(folder.path);
        for (let level = 0; level < 3 && parent !== path.dirname(parent); level += 1) {
          if (await fsp.stat(parent).then((stat) => stat.isDirectory(), () => false)) {
            const stats = await fsp.statfs(parent).catch(() => null);
            return { ...folder, reachable: true, writable: true, notYet: true, free: stats ? stats.bavail * stats.bsize : undefined, total: stats ? stats.blocks * stats.bsize : undefined };
          }
          parent = path.dirname(parent);
        }
      }
      return { ...folder, reachable: false, writable: false };
    }
  }));
}
