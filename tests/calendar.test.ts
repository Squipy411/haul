import { describe, expect, it } from 'vitest';
import { scheduleCalendar } from '../server/calendar';

describe('scheduleCalendar', () => {
  const ics = scheduleCalendar([
    { imdbId: 'tt5875444', type: 'series', title: 'Slow Horses', season: 6, episode: 6, episodeTitle: 'Judgement Day; Part One, Again', released: '2026-10-21T00:00:00.000Z', followed: true, state: 'available', release: 'Slow.Horses.S06E06.1080p.ATVP.WEB-DL' },
    { imdbId: 'tt33764258', type: 'movie', title: 'The Odyssey', released: '2026-07-17T00:00:00.000Z', followed: true, state: 'searching' },
    { imdbId: 'tt0000001', type: 'series', title: 'Broken date', season: 1, episode: 1, released: 'not a date', followed: false, state: 'upcoming' }
  ], 'http://10.0.0.5:60700', new Date('2026-10-22T12:00:00Z'));

  it('is CRLF-separated with one event per dated item', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });

  it('times episodes and makes movies all-day', () => {
    expect(ics).toContain('DTSTART:20261021T000000Z');
    expect(ics).toContain('DTSTART;VALUE=DATE:20260717');
    expect(ics).toContain('UID:tt5875444-6-6@haul');
  });

  it('escapes text and folds long lines', () => {
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain('SUMMARY:Slow Horses S06E06 · Judgement Day\\; Part One\\, Again');
    expect(unfolded).toContain('URL:http://10.0.0.5:60700/title/series/tt5875444?season=6');
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });
});
