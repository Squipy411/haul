import type { ScheduleItem } from '../shared/types.js';

const pad = (value: number) => String(value).padStart(2, '0');

/** iCalendar text: backslashes, semicolons, commas and newlines escaped. */
const text = (value: string) => value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

const stamp = (date: Date) => `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
const day = (date: Date) => `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;

/** Lines longer than 75 bytes continue on the next line after a space, as RFC 5545 asks. */
function fold(line: string): string {
  const bytes = Buffer.from(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + (start === 0 ? 75 : 74));
    // Don't split a UTF-8 character.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    parts.push(bytes.subarray(start, end).toString());
    start = end;
  }
  return parts.join('\r\n ');
}

const STATE: Record<ScheduleItem['state'], string> = {
  upcoming: 'Not out yet.',
  aired: 'Out now.',
  searching: 'Out now. Haul is looking for a torrent.',
  available: 'A torrent is out.',
  downloading: 'Downloading.',
  owned: 'In your library.'
};

/**
 * The Upcoming schedule as a calendar a phone can subscribe to. 'found' (the default) has an event only once
 * a torrent in the format you follow it in has turned up, at that moment; 'aired' has every episode and
 * followed film at its release date.
 */
export function scheduleCalendar(items: ScheduleItem[], baseUrl: string, now = new Date(), mode: 'found' | 'aired' = 'found'): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Haul//Upcoming//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${mode === 'found' ? 'Haul · out in your format' : 'Haul'}`,
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H'
  ];
  for (const item of items) {
    if (mode === 'found' && !item.foundAt) continue;
    const at = new Date(mode === 'found' ? item.foundAt! : item.released);
    if (Number.isNaN(at.getTime())) continue;
    const isMovie = item.type === 'movie';
    const code = isMovie ? '' : `S${pad(item.season!)}E${pad(item.episode!)}`;
    const name = isMovie ? `${item.title} (movie)` : `${item.title} ${code}${item.episodeTitle ? ` · ${item.episodeTitle}` : ''}`;
    const summary = mode === 'found' ? `${isMovie ? item.title : `${item.title} ${code}`}: out in your format` : name;
    const path = `/title/${item.type}/${item.imdbId}${item.season !== undefined ? `?season=${item.season}` : ''}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${item.imdbId}${isMovie ? '' : `-${item.season}-${item.episode}`}@haul`,
      `DTSTAMP:${stamp(now)}`,
      ...(isMovie && mode === 'aired'
        ? [`DTSTART;VALUE=DATE:${day(at)}`]
        : [`DTSTART:${stamp(at)}`, 'DURATION:PT30M']),
      `SUMMARY:${text(summary)}`,
      `DESCRIPTION:${text(`${STATE[item.state]}${item.release ? `\n${item.release}` : ''}`)}`,
      ...(baseUrl ? [`URL:${baseUrl}${path}`] : []),
      'TRANSP:TRANSPARENT',
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
