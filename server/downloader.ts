import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface DownloadOptions {
  expectedSize?: number;
  /** Parallel connections for one file. Files under tuning.minSplit always use one. */
  connections?: number;
  signal: AbortSignal;
  onProgress: (bytesOnDisk: number) => void;
}

const MB = 1024 * 1024;

/** Sizes and timeouts; tests shrink them so they run quickly on slow, emulated builders. */
export const tuning = {
  /** Below this, extra connections cost more in setup than they win in speed. */
  minSplit: 64 * MB,
  /** Smallest piece one connection fetches. */
  minChunk: 16 * MB,
  /** How long a connection may go without sending anything before it's dropped and retried. */
  stallMs: 60_000
};

/** A byte range of the file: `start` inclusive, `end` exclusive, `done` bytes written from `start`. */
export interface Chunk { start: number; end: number; done: number }
interface ChunkState { size: number; chunks: Chunk[] }

/** Splits [from, size) into chunks small enough that connections finishing early pick up more work. */
export function planChunks(from: number, size: number, connections: number): Chunk[] {
  const remaining = size - from;
  if (remaining <= 0) return [];
  const length = Math.max(tuning.minChunk, Math.ceil(remaining / (connections * 8)));
  const chunks: Chunk[] = [];
  for (let start = from; start < size; start += length) chunks.push({ start, end: Math.min(size, start + length), done: 0 });
  return chunks;
}

class RangesUnsupported extends Error {}

/** Aborts when no data has arrived for tuning.stallMs, so a stalled connection is retried instead of hanging forever. */
function watchdog() {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), tuning.stallMs);
  return {
    signal: controller.signal,
    poke() { clearTimeout(timer); timer = setTimeout(() => controller.abort(), tuning.stallMs); },
    done() { clearTimeout(timer); }
  };
}
const stalled = () => new Error('The download stalled. Trying again.');

async function readState(file: string, size: number): Promise<ChunkState | null> {
  try {
    const state = JSON.parse(await fsp.readFile(file, 'utf8')) as ChunkState;
    const valid = state.size === size && Array.isArray(state.chunks)
      && state.chunks.every((chunk) => chunk.start >= 0 && chunk.end <= size && chunk.done >= 0 && chunk.done <= chunk.end - chunk.start);
    return valid ? state : null;
  } catch {
    return null;
  }
}

async function writeState(file: string, state: ChunkState): Promise<void> {
  await fsp.writeFile(`${file}.tmp`, JSON.stringify(state));
  await fsp.rename(`${file}.tmp`, file);
}

const exists = (file: string) => fsp.stat(file).then(() => true, () => false);

/** Downloads a URL to `partPath`, resuming from whatever is already on disk. */
export async function downloadToFile(url: string, partPath: string, options: DownloadOptions): Promise<void> {
  await fsp.mkdir(path.dirname(partPath), { recursive: true });
  const size = options.expectedSize;
  const connections = Math.max(1, Math.min(16, Math.round(options.connections ?? 1)));
  const statePath = `${partPath}.chunks`;
  if (size && connections > 1 && size >= tuning.minSplit) {
    try {
      await downloadInChunks(url, partPath, statePath, size, connections, options);
      return;
    } catch (error) {
      if (!(error instanceof RangesUnsupported)) throw error;
    }
  }
  // A chunked attempt leaves holes in the file, so a single connection has to start over.
  if (await exists(statePath)) {
    await fsp.rm(partPath, { force: true });
    await fsp.rm(statePath, { force: true });
  }
  await downloadSingle(url, partPath, options);
}

async function downloadInChunks(url: string, partPath: string, statePath: string, size: number, connections: number, options: DownloadOptions): Promise<void> {
  let state = await readState(statePath, size);
  if (!state) {
    // A part file without a chunk record came from a single connection: its bytes run unbroken from 0.
    let have = 0;
    try { have = (await fsp.stat(partPath)).size; } catch { /* fresh download */ }
    if (have > size) { await fsp.rm(partPath, { force: true }); have = 0; }
    if (have === size) { options.onProgress(size); return; }
    state = { size, chunks: [...(have ? [{ start: 0, end: have, done: have }] : []), ...planChunks(have, size, connections)] };
    await writeState(statePath, state);
  }
  const chunks = state.chunks;
  const written = () => chunks.reduce((sum, chunk) => sum + chunk.done, 0);
  options.onProgress(written());

  await (await fsp.open(partPath, 'a')).close();
  const handle = await fsp.open(partPath, 'r+');
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  const queue = chunks.filter((chunk) => chunk.done < chunk.end - chunk.start);
  let lastReport = 0;
  const saver = setInterval(() => { void writeState(statePath, state!).catch(() => undefined); }, 2000);

  const worker = async (): Promise<void> => {
    for (let chunk = queue.shift(); chunk; chunk = queue.shift()) {
      const from = chunk.start + chunk.done;
      const dog = watchdog();
      try {
        const response = await fetch(url, { headers: { Range: `bytes=${from}-${chunk.end - 1}` }, signal: AbortSignal.any([signal, dog.signal]), redirect: 'follow' });
        if (response.status === 200) { await response.body?.cancel(); throw new RangesUnsupported(); }
        if (response.status !== 206 || !response.body) throw new Error(`Download server returned HTTP ${response.status}`);
        const total = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1];
        if (total && Number(total) !== size) { await response.body.cancel(); throw new Error('The file on TorBox is a different size than expected'); }
        for await (const piece of response.body as unknown as AsyncIterable<Uint8Array>) {
          dog.poke();
          const room = chunk.end - chunk.start - chunk.done;
          const data = piece.length > room ? piece.subarray(0, room) : piece;
          await handle.write(data, 0, data.length, chunk.start + chunk.done);
          chunk.done += data.length;
          const now = Date.now();
          if (now - lastReport > 400) { lastReport = now; options.onProgress(written()); }
          if (chunk.done >= chunk.end - chunk.start) break;
        }
      } catch (error) {
        if (dog.signal.aborted && !signal.aborted) throw stalled();
        throw error;
      } finally {
        dog.done();
      }
      if (chunk.done < chunk.end - chunk.start) throw new Error(`Download ended early (${written()} of ${size} bytes)`);
    }
  };

  try {
    const results = await Promise.allSettled(Array.from({ length: Math.min(connections, queue.length) }, () => worker().catch((error) => { stop.abort(); throw error; })));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) {
      // The first real error explains the rest, which were only stopped because of it.
      const reasons = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason as Error);
      throw reasons.find((reason) => reason instanceof RangesUnsupported) ?? reasons.find((reason) => reason.name !== 'AbortError') ?? failure.reason;
    }
  } finally {
    clearInterval(saver);
    await handle.close().catch(() => undefined);
    await writeState(statePath, state).catch(() => undefined);
    options.onProgress(written());
  }

  if (written() !== size || (await fsp.stat(partPath)).size !== size) throw new Error(`Download ended early (${written()} of ${size} bytes)`);
  await fsp.rm(statePath, { force: true });
}

async function downloadSingle(url: string, partPath: string, options: DownloadOptions): Promise<void> {
  let start = 0;
  try { start = (await fsp.stat(partPath)).size; } catch { /* fresh download */ }
  if (options.expectedSize && start === options.expectedSize) { options.onProgress(start); return; }
  if (options.expectedSize && start > options.expectedSize) { await fsp.rm(partPath, { force: true }); start = 0; }

  const dog = watchdog();
  const signal = AbortSignal.any([options.signal, dog.signal]);
  try {
    await streamSingle(url, partPath, start, signal, dog.poke, options);
  } catch (error) {
    if (dog.signal.aborted && !options.signal.aborted) throw stalled();
    throw error;
  } finally {
    dog.done();
  }
}

async function streamSingle(url: string, partPath: string, start: number, signal: AbortSignal, poke: () => void, options: DownloadOptions): Promise<void> {
  const response = await fetch(url, {
    headers: start > 0 ? { Range: `bytes=${start}-` } : {},
    signal,
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
      poke();
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
    { signal }
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
