import { afterEach, describe, expect, it, vi } from 'vitest';
import { Torbox } from '../server/torbox';

afterEach(() => vi.unstubAllGlobals());

describe('Torbox.list', () => {
  it('reads every page of a big account, and the next time fetches them together', async () => {
    const sizes = [1000, 1000, 519];
    const offsets: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      offsets.push(offset);
      const count = sizes[offset / 1000] ?? 0;
      return new Response(JSON.stringify({ success: true, data: Array.from({ length: count }, (_, index) => ({ id: offset + index, hash: String(offset + index) })) }), { status: 200 });
    }));
    const torbox = new Torbox(() => 'key');
    expect((await torbox.list()).length).toBe(2519);
    expect(offsets).toEqual([0, 1000, 2000]);
    offsets.length = 0;
    expect((await torbox.list()).length).toBe(2519);
    expect(offsets.sort((a, b) => a - b)).toEqual([0, 1000, 2000]);
  });
});
