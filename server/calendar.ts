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

/** The Upcoming schedule as a calendar a phone can subscribe to. */
export function scheduleCalendar(items: ScheduleItem[], baseUrl: string, now = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Haul//Upcoming//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Haul',
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H'
  ];
  for (const item of items) {
    const at = new Date(item.released);
    if (Number.isNaN(at.getTime())) continue;
    const isMovie = item.type === 'movie';
    const code = isMovie ? '' : `S${pad(item.season!)}E${pad(item.episode!)}`;
    const summary = isMovie ? `${item.title} (movie)` : `${item.title} ${code}${item.episodeTitle ? ` · ${item.episodeTitle}` : ''}`;
    const path = `/title/${item.type}/${item.imdbId}${item.season !== undefined ? `?season=${item.season}` : ''}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${item.imdbId}${isMovie ? '' : `-${item.season}-${item.episode}`}@haul`,
      `DTSTAMP:${stamp(now)}`,
      ...(isMovie
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
