import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MediaType, Meta, UploadAdded } from '../shared/types.js';
import { HttpError } from './http.js';
import { safeName, seasonFolder, showFolder } from './organize.js';
import { VIDEO_EXTENSIONS, extensionOf, parseEpisodeFile, parseTitleYear } from './release.js';

// Drag a video onto Haul and it lands in the library, named like Haul's own downloads. Files arrive in
// pieces of up to 96 MB, so a big film gets past proxies that cap a request (Cloudflare allows 100 MB)
// and a dropped connection only resends the piece it was on.

const MAX_PIECE = 96 * 1024 * 1024;
/** The library skips smaller videos (samples, extras), so they're refused up front. */
const MIN_VIDEO = 20 * 1024 * 1024;
/** Room left on the disk after the file, so the system and downloads aren't squeezed out. */
const HEADROOM = 512 * 1024 * 1024;
const FORGET_AFTER_MS = 24 * 60 * 60_000;

interface Upload {
  id: string;
  name: string;
  size: number;
  received: number;
  type: MediaType;
  imdbId?: string;
  part: string;
  touchedAt: number;
  writing: boolean;
}

export interface UploadDeps {
  settings: () => { moviesDir: string; tvDir: string; incompleteDir: string };
  meta: (type: MediaType, imdbId: string) => Promise<Meta>;
  /** A file is in place: remember what it is and rescan. */
  onAdded: (added: { type: MediaType; folder: string; imdbId?: string; title: string; year?: number }) => void;
}

const pad = (value: number) => String(value).padStart(2, '0');
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

async function freePath(target: string): Promise<string> {
  const { dir, name, ext } = path.parse(target);
  for (let copy = 1; ; copy += 1) {
    const candidate = copy === 1 ? target : path.join(dir, `${name} (${copy})${ext}`);
    try { await fsp.access(candidate); } catch { return candidate; }
  }
}

async function move(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to);
  } catch (error) {
    // Uploads wait on the downloads disk; the library may be on another one.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await fsp.copyFile(from, to);
    await fsp.unlink(from);
  }
}

export class Uploads {
  private readonly uploads = new Map<string, Upload>();

  constructor(private readonly deps: UploadDeps) {}

  private get dir(): string {
    return path.join(this.deps.settings().incompleteDir, '.uploads');
  }

  private get(id: string): Upload {
    const upload = this.uploads.get(id);
    if (!upload) throw new HttpError(404, 'That upload has expired. Add the file again.');
    return upload;
  }

  /** Forgets uploads nobody has touched for a day, and their half-sent files. */
  private sweep(): void {
    for (const upload of this.uploads.values()) {
      if (Date.now() - upload.touchedAt > FORGET_AFTER_MS && !upload.writing) void this.cancel(upload.id);
    }
  }

  async start(input: { name?: unknown; size?: unknown; type?: unknown; imdbId?: unknown }): Promise<{ id: string; received: number }> {
    this.sweep();
    const name = typeof input.name === 'string' ? path.basename(input.name.replace(/\\/g, '/')).trim() : '';
    const size = Number(input.size);
    if (!name || !VIDEO_EXTENSIONS.has(extensionOf(name))) throw new HttpError(400, `${name || 'That file'} isn't a video Haul can add. It takes MKV, MP4, AVI, MOV and other video files.`);
    if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, `${name}: the size is missing.`);
    if (size < MIN_VIDEO) throw new HttpError(400, `${name} is too small to be a film or an episode.`);
    const episode = parseEpisodeFile(name);
    const type: MediaType = input.type === 'movie' || input.type === 'series' ? input.type : episode ? 'series' : 'movie';
    // Checked now rather than after a long upload: an episode has to say which one it is.
    if (type === 'series' && !episode) throw new HttpError(400, `Haul can't tell which episode ${name} is. Rename it with the season and episode, like S01E04, and add it again.`);
    const imdbId = typeof input.imdbId === 'string' && /^tt\d{5,10}$/.test(input.imdbId) ? input.imdbId : undefined;

    await fsp.mkdir(this.dir, { recursive: true });
    const stats = await fsp.statfs(this.dir).catch(() => null);
    const free = stats ? stats.bavail * stats.bsize : Infinity;
    if (size + HEADROOM > free) throw new HttpError(507, `Not enough room for ${name}: it needs ${gb(size)} and the disk has ${gb(free)} free.`);

    const id = crypto.randomBytes(9).toString('base64url');
    const upload: Upload = { id, name, size, received: 0, type, imdbId, part: path.join(this.dir, `${id}.part`), touchedAt: Date.now(), writing: false };
    await fsp.writeFile(upload.part, '');
    this.uploads.set(id, upload);
    return { id, received: 0 };
  }

  /** Writes one piece at `offset`. A piece that doesn't follow on gets 409 with where to carry on from. */
  async write(id: string, offset: number, req: IncomingMessage): Promise<{ received: number; resumeFrom?: number }> {
    const upload = this.get(id);
    if (upload.writing) throw new HttpError(409, 'Haul is already receiving a piece of this file.');
    if (offset !== upload.received) return { received: upload.received, resumeFrom: upload.received };
    const length = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(length) || length <= 0) throw new HttpError(411, 'Each piece needs its length.');
    if (length > MAX_PIECE) throw new HttpError(413, 'That piece is too big.');
    if (offset + length > upload.size) throw new HttpError(400, 'That piece goes past the end of the file.');

    upload.writing = true;
    upload.touchedAt = Date.now();
    let written = 0;
    try {
      const count = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          written += chunk.length;
          done(written > length ? new HttpError(400, 'More arrived than the piece announced.') : null, chunk);
        }
      });
      await pipeline(req, count, fs.createWriteStream(upload.part, { flags: 'r+', start: offset }));
      if (written !== length) throw new HttpError(400, 'Part of the piece went missing. Sending it again.');
      upload.received = offset + length;
    } catch (error) {
      // A cut connection leaves half a piece behind: cut the file back so the next try lines up.
      await fsp.truncate(upload.part, upload.received).catch(() => undefined);
      throw error instanceof HttpError ? error : new HttpError(400, 'The connection dropped during a piece. Sending it again.');
    } finally {
      upload.writing = false;
      upload.touchedAt = Date.now();
    }
    return { received: upload.received };
  }

  /** Every byte is in: name the file and move it into Movies or TV Shows. */
  async finish(id: string): Promise<UploadAdded> {
    const upload = this.get(id);
    if (upload.writing || upload.received !== upload.size) throw new HttpError(409, 'Not all of the file has arrived yet.');
    const { moviesDir, tvDir } = this.deps.settings();
    const meta = upload.imdbId ? await this.deps.meta(upload.type, upload.imdbId).catch(() => undefined) : undefined;
    const parsed = parseTitleYear(upload.name);
    // "severance.s01e04.mkv" files as "Severance", like the show's own name.
    const title = meta?.name ?? (parsed.title === parsed.title.toLowerCase() ? parsed.title.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase()) : parsed.title);
    const year = meta?.year ?? parsed.year;
    const named = year ? `${title} (${year})` : title;
    const extension = extensionOf(upload.name);

    let folder: string;
    let target: string;
    if (upload.type === 'series') {
      const episode = parseEpisodeFile(upload.name)!;
      folder = showFolder(tvDir, title, year);
      const code = `S${pad(episode.season)}E${pad(episode.episode)}${episode.episodeEnd ? `-E${pad(episode.episodeEnd)}` : ''}`;
      const episodeTitle = episode.episodeEnd ? undefined : meta?.episodes.find((item) => item.season === episode.season && item.episode === episode.episode)?.title;
      const titlePart = episodeTitle && !/^episode \d+$/i.test(episodeTitle) ? ` - ${episodeTitle}` : '';
      target = path.join(seasonFolder(folder, episode.season), `${safeName(`${named} - ${code}${titlePart}`)}.${extension}`);
    } else {
      folder = path.join(moviesDir, safeName(named));
      target = path.join(folder, `${safeName(named)}.${extension}`);
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    target = await freePath(target);
    await move(upload.part, target);
    this.uploads.delete(id);
    this.deps.onAdded({ type: upload.type, folder, imdbId: meta ? upload.imdbId : undefined, title, year });
    return { type: upload.type, title: named, imdbId: meta ? upload.imdbId : undefined, file: path.basename(target) };
  }

  async cancel(id: string): Promise<void> {
    const upload = this.uploads.get(id);
    if (!upload) return;
    this.uploads.delete(id);
    await fsp.unlink(upload.part).catch(() => undefined);
  }

  /** Half-sent files from before a restart can't be picked up again: clear them out. */
  async clearLeftovers(): Promise<void> {
    let names: string[];
    try { names = await fsp.readdir(this.dir); } catch { return; }
    await Promise.all(names.filter((name) => name.endsWith('.part')).map((name) => fsp.unlink(path.join(this.dir, name)).catch(() => undefined)));
  }
}
