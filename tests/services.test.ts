import { afterEach, describe, expect, it, vi } from 'vitest';
import { AllDebrid, flattenTree } from '../server/alldebrid';
import { Premiumize } from '../server/premiumize';
import { RealDebrid } from '../server/realdebrid';

type Call = { method: string; url: URL; body: URLSearchParams; auth: string | null };

/** A fetch that answers from a table of handlers and records each request. */
function fakeApi(routes: Record<string, (call: Call) => { status?: number; json?: unknown } | undefined>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call: Call = { method: init.method ?? 'GET', url, body: new URLSearchParams(init.body ? String(init.body) : ''), auth: new Headers(init.headers).get('authorization') };
    calls.push(call);
    const key = Object.keys(routes).find((route) => `${call.method} ${url.pathname}`.startsWith(route));
    const answer = key ? routes[key]!(call) : undefined;
    if (!answer) return new Response(JSON.stringify({ error: 'unknown' }), { status: 404 });
    return new Response(answer.json === undefined ? null : JSON.stringify(answer.json), { status: answer.status ?? 200 });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('Real-Debrid', () => {
  const info = (status: string) => ({
    id: 'ABC', filename: 'Show.S01.1080p', hash: 'AAAA', bytes: 3000, progress: status === 'downloaded' ? 100 : 40, status, speed: 100,
    files: [{ id: 1, path: '/Show.S01.1080p/Show.S01E01.mkv', bytes: 1000, selected: 1 }, { id: 2, path: '/Show.S01.1080p/sample.txt', bytes: 5, selected: 0 }, { id: 3, path: '/Show.S01.1080p/Show.S01E02.mkv', bytes: 2000, selected: 1 }],
    links: status === 'downloaded' ? ['https://real-debrid.com/d/one', 'https://real-debrid.com/d/two'] : []
  });

  it('adds a magnet, chooses only its videos, and maps the torrent', async () => {
    let status = 'waiting_files_selection';
    const calls = fakeApi({
      'POST /rest/1.0/torrents/addMagnet': () => ({ status: 201, json: { id: 'ABC' } }),
      'GET /rest/1.0/torrents/info/ABC': () => ({ json: info(status) }),
      'POST /rest/1.0/torrents/selectFiles/ABC': () => { status = 'downloading'; return { status: 204 }; }
    });
    const service = new RealDebrid(() => 'key');
    expect(await service.create('magnet:?xt=urn:btih:aaaa')).toEqual({ torrentId: 'ABC' });
    expect(calls.find((call) => call.url.pathname.includes('selectFiles'))!.body.get('files')).toBe('1,3');
    expect(calls.every((call) => call.auth === 'Bearer key')).toBe(true);
    const torrent = await service.torrent('ABC');
    expect(torrent).toMatchObject({ id: 'ABC', hash: 'aaaa', download_present: false, progress: 0.4, download_state: 'Downloading' });
    expect(torrent!.files.map((file) => file.name)).toEqual(['Show.S01.1080p/Show.S01E01.mkv', 'Show.S01.1080p/Show.S01E02.mkv']);
  });

  it('turns the link for a chosen file into a download', async () => {
    const calls = fakeApi({
      'GET /rest/1.0/torrents/info/ABC': () => ({ json: info('downloaded') }),
      'POST /rest/1.0/unrestrict/link': (call) => ({ json: { download: `https://cdn.example/${call.body.get('link')!.split('/').pop()}.mkv`, filename: 'x.mkv' } })
    });
    const service = new RealDebrid(() => 'key');
    expect(await service.downloadLink('ABC', 3)).toBe('https://cdn.example/two.mkv');
    expect(calls.at(-1)!.body.get('link')).toBe('https://real-debrid.com/d/two');
  });

  it('says plainly when the key is refused, and remembers it', async () => {
    fakeApi({ 'GET /rest/1.0/': () => ({ status: 401, json: { error: 'bad_token', error_code: 8 } }) });
    const service = new RealDebrid(() => 'old');
    await expect(service.list()).rejects.toMatchObject({ code: 'BAD_KEY' });
    expect((await service.account()).error).toMatch(/real-debrid.com\/apitoken/);
  });
});

describe('AllDebrid', () => {
  it('flattens its file tree into paths', () => {
    expect(flattenTree([{ n: 'Pack', e: [{ n: 'A.mkv', s: 10, l: 'https://alldebrid.com/f/a' }, { n: 'Subs', e: [{ n: 'A.srt', s: 1, l: 'https://alldebrid.com/f/s' }] }] }]))
      .toEqual([{ id: 0, name: 'Pack/A.mkv', size: 10, link: 'https://alldebrid.com/f/a' }, { id: 1, name: 'Pack/Subs/A.srt', size: 1, link: 'https://alldebrid.com/f/s' }]);
  });

  it('uploads, reads status and files, and unlocks a link (waiting for a delayed one)', async () => {
    let delayedAsks = 0;
    fakeApi({
      'POST /v4/magnet/upload': (call) => ({ json: { status: 'success', data: { magnets: [{ id: 77, hash: 'BBBB', ready: true, magnet: call.body.get('magnets[]') }] } } }),
      'POST /v4.1/magnet/status': () => ({ json: { status: 'success', data: { magnets: { id: 77, filename: 'Film.2020.1080p', hash: 'bbbb', size: 100, status: 'Ready', statusCode: 4, downloaded: 100, downloadSpeed: 0 } } } }),
      'POST /v4/magnet/files': () => ({ json: { status: 'success', data: { magnets: [{ id: 77, files: [{ n: 'Film.2020.1080p.mkv', s: 100, l: 'https://alldebrid.com/f/film' }] }] } } }),
      'POST /v4/link/unlock': () => ({ json: { status: 'success', data: { delayed: 5 } } }),
      'POST /v4/link/delayed': () => ({ json: { status: 'success', data: delayedAsks++ ? { status: 2, link: 'https://cdn.alldebrid.com/film.mkv' } : { status: 1 } } })
    });
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 500 });
    try {
      const service = new AllDebrid(() => 'key');
      expect(await service.create('magnet:?xt=urn:btih:bbbb')).toEqual({ torrentId: 77, hash: 'bbbb' });
      expect(await service.torrent(77)).toMatchObject({ id: 77, download_present: true, progress: 1, files: [{ id: 0, name: 'Film.2020.1080p.mkv', size: 100 }] });
      expect(await service.downloadLink(77, 0)).toBe('https://cdn.alldebrid.com/film.mkv');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a refused key and full slots in words', async () => {
    fakeApi({ 'POST /v4/magnet/upload': () => ({ json: { status: 'error', error: { code: 'AUTH_BAD_APIKEY', message: 'bad' } } }) });
    await expect(new AllDebrid(() => 'x').create('magnet:?xt=urn:btih:cc')).rejects.toMatchObject({ code: 'BAD_KEY' });
    fakeApi({ 'POST /v4/magnet/upload': () => ({ json: { status: 'success', data: { magnets: [{ error: { code: 'MAGNET_TOO_MANY_ACTIVE', message: 'too many' } }] } } }) });
    await expect(new AllDebrid(() => 'x').create('magnet:?xt=urn:btih:cc')).rejects.toThrow(/slots/);
  });
});

describe('Premiumize', () => {
  it('checks what is cached, in order', async () => {
    fakeApi({ 'POST /api/cache/check': (call) => ({ json: { status: 'success', response: call.body.getAll('items[]').map((hash) => hash === 'aa'), filename: ['Film.mkv', null], filesize: ['1234', null] } }) });
    const cached = await new Premiumize(() => 'key').checkCached(['AA', 'bb']);
    expect([...cached.keys()]).toEqual(['aa']);
    expect(cached.get('aa')).toMatchObject({ name: 'Film.mkv', size: 1234 });
  });

  it('finds a finished transfer’s files in its folder, with their links', async () => {
    fakeApi({
      'POST /api/transfer/create': () => ({ json: { status: 'success', id: 'T1', name: 'Show.S01' } }),
      'GET /api/transfer/list': () => ({ json: { status: 'success', transfers: [{ id: 'T1', name: 'Show.S01', status: 'finished', progress: 1, folder_id: 'F1', file_id: null }] } }),
      'GET /api/folder/list': (call) => ({ json: call.url.searchParams.get('id') === 'F1'
        ? { status: 'success', content: [{ id: 'f1', name: 'Show.S01E01.mkv', type: 'file', size: 10, link: 'https://pm/1' }, { id: 'F2', name: 'Extras', type: 'folder' }] }
        : { status: 'success', content: [{ id: 'f2', name: 'Show.S01E02.mkv', type: 'file', size: 20, link: 'https://pm/2' }] } })
    });
    const service = new Premiumize(() => 'key');
    const { torrentId } = await service.create('magnet:?xt=urn:btih:6E88B3F25BA49D483D740A652BF013C341BC5373');
    const torrent = await service.torrent(torrentId!);
    expect(torrent).toMatchObject({ id: 'T1', hash: '6e88b3f25ba49d483d740a652bf013c341bc5373', download_present: true });
    expect(torrent!.files.map((file) => file.name)).toEqual(['Show.S01/Show.S01E01.mkv', 'Show.S01/Extras/Show.S01E02.mkv']);
    expect(await service.downloadLink('T1', 1)).toBe('https://pm/2');
  });

  it('knows a refused key', async () => {
    fakeApi({ 'GET /api/account/info': () => ({ json: { status: 'error', code: 'authentication_failed', message: 'Not logged in.' } }) });
    expect(await new Premiumize(() => 'x').account()).toMatchObject({ ok: false, error: expect.stringMatching(/premiumize.me\/account/) });
  });
});
