import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface DownloadOptions {
  expectedSize?: number;
  signal: AbortSignal;
  onProgress: (bytesOnDisk: number) => void;
}

/** Downloads a URL to `partPath`, resuming from whatever is already on disk. */
export async function downloadToFile(url: string, partPath: string, options: DownloadOptions): Promise<void> {
  await fsp.mkdir(path.dirname(partPath), { recursive: true });
  let start = 0;
  try { start = (await fsp.stat(partPath)).size; } catch { /* fresh download */ }
  if (options.expectedSize && start === options.expectedSize) { options.onProgress(start); return; }
  if (options.expectedSize && start > options.expectedSize) { await fsp.rm(partPath, { force: true }); start = 0; }

  const response = await fetch(url, {
    headers: start > 0 ? { Range: `bytes=${start}-` } : {},
    signal: options.signal,
    redirect: 'follow'
  });
  if (response.status === 416 && options.expectedSize && start >= options.expectedSize) { options.onProgress(start); return; }
  if (!response.ok || !response.body) throw new Error(`Download server returned HTTP ${response.status}`);
  const append = start > 0 && response.status === 206;
  let written = append ? start : 0;
  options.onProgress(written);

  let lastReport = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      const now = Date.now();
      if (now - lastReport > 400) { lastReport = now; options.onProgress(written); }
      callback(null, chunk);
    }
  });
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    counter,
    fs.createWriteStream(partPath, { flags: append ? 'a' : 'w' }),
    { signal: options.signal }
  );
  options.onProgress(written);
  if (options.expectedSize && written !== options.expectedSize) {
    throw new Error(`Download ended early (${written} of ${options.expectedSize} bytes)`);
  }
}

/** Moves a finished file into the library, copying when source and target are on different disks. */
export async function moveFile(source: string, target: string, owner?: { uid: number; gid: number }): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await fsp.copyFile(source, `${target}.haul-copy`);
    await fsp.rename(`${target}.haul-copy`, target);
    await fsp.rm(source, { force: true });
  }
  await fsp.chmod(target, 0o644).catch(() => undefined);
  if (owner) {
    await fsp.chown(target, owner.uid, owner.gid).catch(() => undefined);
    await fsp.chown(path.dirname(target), owner.uid, owner.gid).catch(() => undefined);
    await fsp.chown(path.dirname(path.dirname(target)), owner.uid, owner.gid).catch(() => undefined);
  }
}
