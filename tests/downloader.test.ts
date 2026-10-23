import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { downloadToFile, planChunks, tuning } from '../server/downloader';

// Small sizes keep this quick on emulated (arm64) builders; the logic is the same at 70 GB.
const MB = 1024 * 1024;
const KB = 1024;
Object.assign(tuning, { minSplit: 1 * MB, minChunk: 256 * KB });
const data = crypto.randomBytes(6 * MB);
const digest = (buffer: Buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const expected = digest(data);

type Mode = 'ranges' | 'no-ranges' | 'stall';
let mode: Mode = 'ranges';
const ranges: string[] = [];
let inFlight = 0;
let maxInFlight = 0;
let server: http.Server;
let url = '';
const dirs: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    res.on('close', () => { inFlight -= 1; });
    if (mode === 'stall') {
      res.writeHead(206, { 'Content-Range': `bytes 0-${data.length - 1}/${data.length}` });
      res.write(data.subarray(0, 1024));
      return; // never finishes
    }
    if (!range || mode === 'no-ranges') {
      res.writeHead(200, { 'Content-Length': data.length });
      res.end(data);
      return;
    }
    ranges.push(req.headers.range!);
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : data.length - 1;
    // A short delay, like a real server's, so parallel requests overlap.
    setTimeout(() => {
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
      res.end(data.subarray(start, end + 1));
    }, 25);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file.mkv`;
});

afterAll(() => { server.closeAllConnections(); server.close(); });
afterEach(() => {
  mode = 'ranges';
  ranges.length = 0;
  maxInFlight = 0;
  tuning.stallMs = 60_000;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function part(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-dl-'));
  dirs.push(dir);
  return path.join(dir, 'file.mkv.part');
}

const run = (file: string, connections: number) => downloadToFile(url, file, { expectedSize: data.length, connections, signal: new AbortController().signal, onProgress: () => undefined });

describe('planChunks', () => {
  it('covers the whole range with no gaps or overlaps', () => {
    const chunks = planChunks(1 * MB, 6 * MB, 4);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks[0]!.start).toBe(1 * MB);
    expect(chunks.at(-1)!.end).toBe(6 * MB);
    chunks.slice(1).forEach((chunk, index) => expect(chunk.start).toBe(chunks[index]!.end));
  });
});

describe('downloadToFile', () => {
  it('downloads over several connections and gets every byte right', async () => {
    const file = part();
    await run(file, 4);
    expect(digest(fs.readFileSync(file))).toBe(expected);
    expect(fs.existsSync(`${file}.chunks`)).toBe(false);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('resumes a chunked download from its record, fetching only what is missing', async () => {
    const file = part();
    const chunks = planChunks(0, data.length, 4);
    fs.writeFileSync(file, Buffer.alloc(0));
    const fd = fs.openSync(file, 'r+');
    for (const chunk of chunks.slice(0, 2)) fs.writeSync(fd, data, chunk.start, chunk.end - chunk.start, chunk.start);
    chunks[0]!.done = chunks[0]!.end - chunks[0]!.start;
    chunks[1]!.done = chunks[1]!.end - chunks[1]!.start;
    fs.writeSync(fd, data, chunks[2]!.start, 100 * KB, chunks[2]!.start);
    chunks[2]!.done = 100 * KB;
    fs.closeSync(fd);
    fs.writeFileSync(`${file}.chunks`, JSON.stringify({ size: data.length, chunks }));

    await run(file, 4);
    expect(digest(fs.readFileSync(file))).toBe(expected);
    const starts = ranges.map((range) => Number(/bytes=(\d+)/.exec(range)![1]));
    expect(starts).not.toContain(0);
    expect(starts).toContain(chunks[2]!.start + 100 * KB);
  });

  it('carries on from a part file left by a single connection', async () => {
    const file = part();
    fs.writeFileSync(file, data.subarray(0, 2 * MB));
    await run(file, 4);
    expect(digest(fs.readFileSync(file))).toBe(expected);
    expect(Math.min(...ranges.map((range) => Number(/bytes=(\d+)/.exec(range)![1])))).toBe(2 * MB);
  });

  it('falls back to one connection when the server ignores ranges', async () => {
    mode = 'no-ranges';
    const file = part();
    await run(file, 4);
    expect(digest(fs.readFileSync(file))).toBe(expected);
    expect(fs.existsSync(`${file}.chunks`)).toBe(false);
  });

  it('gives up on a stalled connection so the job can retry', async () => {
    mode = 'stall';
    tuning.stallMs = 300;
    await expect(run(part(), 1)).rejects.toThrow(/stalled/);
  });
});
