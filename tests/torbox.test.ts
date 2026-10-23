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

describe('Torbox.account', () => {
  it("explains a refused key in Haul's words, and an empty one as missing", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, error: 'BAD_TOKEN', detail: 'Your token is invalid or has expired. Please log in again or reset your token.' }), { status: 403 })));
    const refused = await new Torbox(() => 'key').account();
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("didn't accept that API key");
    const missing = await new Torbox(() => '').account();
    expect(missing.error).toContain('Add your TorBox API key');
  });
});

describe('Torbox.refused', () => {
  it('remembers a refused key until a call with it works', async () => {
    let refuse = true;
    vi.stubGlobal('fetch', vi.fn(async () => (refuse
      ? new Response(JSON.stringify({ success: false, error: 'BAD_TOKEN', detail: 'Your token is invalid.' }), { status: 403 })
      : new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }))));
    const torbox = new Torbox(() => 'key');
    await expect(torbox.list()).rejects.toThrow("didn't accept your API key");
    expect(torbox.refused).toBe(true);
    refuse = false;
    await torbox.list();
    expect(torbox.refused).toBe(false);
  });
});
