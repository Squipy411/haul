import { afterEach, describe, expect, it, vi } from 'vitest';
import { magnetHash, parseStremioStreams, parseTorznab, pirateBaySource, torznabSource } from '../server/sources';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
<channel>
  <item>
    <title>Interstellar.2014.1080p.BluRay.x264-SPARKS &amp; friends</title>
    <jackettindexer id="1337x">1337x</jackettindexer>
    <size>14812000000</size>
    <link>https://jackett.local/dl/1337x/?jackett_apikey=abc&amp;path=xyz</link>
    <torznab:attr name="seeders" value="812" />
    <torznab:attr name="infohash" value="6E88B3F25BA49D483D740A652BF013C341BC5373" />
  </item>
  <item>
    <title><![CDATA[Interstellar 2014 2160p REMUX]]></title>
    <size>80000000000</size>
    <torznab:attr name="magneturl" value="magnet:?xt=urn:btih:N2ELH4S3URFEIPLUBJFCX4ATYNA3YU3T&amp;dn=Interstellar" />
    <torznab:attr name="files" value="3" />
  </item>
  <item>
    <title>Only a .torrent link, no hash</title>
    <link>https://jackett.local/dl/x.torrent</link>
  </item>
</channel>
</rss>`;

describe('sources', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads hashes from Torznab feeds, from the infohash attribute or a magnet (hex or base32)', () => {
    const results = parseTorznab(XML, 'Jackett');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ hash: '6e88b3f25ba49d483d740a652bf013c341bc5373', name: 'Interstellar.2014.1080p.BluRay.x264-SPARKS & friends', totalSize: 14812000000, seeders: 812, provider: '1337x', origin: 'Jackett', multiFile: false });
    expect(results[1]).toMatchObject({ hash: magnetHash('magnet:?xt=urn:btih:N2ELH4S3URFEIPLUBJFCX4ATYNA3YU3T'), name: 'Interstellar 2014 2160p REMUX', multiFile: true });
    expect(results[1]!.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(magnetHash('magnet:?xt=urn:btih:6E88B3F25BA49D483D740A652BF013C341BC5373')).toBe('6e88b3f25ba49d483d740a652bf013c341bc5373');
  });

  it('asks a Torznab feed by IMDb id, season and episode, keeping its apikey', async () => {
    const fetchMock = vi.fn(async () => new Response(XML));
    vi.stubGlobal('fetch', fetchMock);
    await torznabSource('http://prowlarr:9696/3/api?apikey=secret', 'series', 'tt0944947', 1, 2);
    const asked = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(asked.pathname).toBe('/3/api');
    expect(Object.fromEntries(asked.searchParams)).toEqual({ apikey: 'secret', t: 'tvsearch', imdbid: 'tt0944947', cat: '5000', season: '1', ep: '2' });
  });

  it('keeps Pirate Bay uploads for the right title and drops the empty answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { name: 'Interstellar (2014) 1080p', info_hash: '6E88B3F25BA49D483D740A652BF013C341BC5373', seeders: '176', size: '1097045030', num_files: '2', imdb: 'tt0816692' },
      { name: 'Another film', info_hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', seeders: '5', size: '1', num_files: '1', imdb: 'tt0000001' },
      { name: 'Untagged upload', info_hash: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', seeders: '9', size: '1', num_files: '1', imdb: '' },
      { name: 'No results returned', info_hash: '0000000000000000000000000000000000000000', seeders: '0', size: '0', num_files: '0', imdb: '' }
    ]))));
    const results = await pirateBaySource('tt0816692');
    expect(results).toEqual([{ hash: '6e88b3f25ba49d483d740a652bf013c341bc5373', name: 'Interstellar (2014) 1080p', totalSize: 1097045030, seeders: 176, provider: 'ThePirateBay', origin: 'The Pirate Bay', multiFile: true }]);
  });

  it('reads TorrentsDB streams like Torrentio’s', () => {
    const [result] = parseStremioStreams([{ name: 'TorrentsDB\n2160p', title: 'Game of Thrones S01E01 2160p UHD BluRay x265-SCOTLUHD\n📅 S01E01 👤 13 💾 11.74 GB ⚙️ EZTV', infoHash: 'E4AAE367B822794D37D8CAFD5A628DB985D65FB4', behaviorHints: { filename: 'Game.of.Thrones.S01E01.2160p.mkv' } }], 'TorrentsDB');
    expect(result).toMatchObject({ hash: 'e4aae367b822794d37d8cafd5a628db985d65fb4', name: 'Game of Thrones S01E01 2160p UHD BluRay x265-SCOTLUHD', seeders: 13, provider: 'EZTV', origin: 'TorrentsDB' });
    expect(result!.fileSize).toBeGreaterThan(11 * 1024 ** 3);
  });
});
