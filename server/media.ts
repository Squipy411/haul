import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** What ffprobe found in a file. Audio and subtitle `index` count within their own kind (0, 1, 2…), as ffmpeg's -map 0:a:N expects. */
export interface Probe {
  duration: number;
  container: string;
  video?: { codec: string; profile?: string; pixFmt?: string; width: number; height: number };
  audios: Array<{ index: number; codec: string; channels: number; language?: string; title?: string; default: boolean }>;
  subtitles: Array<{ index: number; codec: string; language?: string; title?: string; text: boolean; forced: boolean }>;
}

/** What the viewer's browser said it can decode. */
export interface Caps { hevc: boolean; av1: boolean; ac3: boolean }

/** direct: the browser reads the file as is. remux: new wrapper, same video. transcode: new video too. */
export type PlayMode = 'direct' | 'remux' | 'transcode';

const TEXT_SUBTITLES = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

export class MediaTools {
  private available: Promise<boolean> | null = null;
  private probes = new Map<string, Promise<Probe>>();

  constructor(private readonly ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', private readonly ffprobe = process.env.FFPROBE_PATH || 'ffprobe') {}

  /** Whether ffmpeg and ffprobe run here. Checked once. */
  hasFfmpeg(): Promise<boolean> {
    this.available ??= Promise.all([this.ffmpeg, this.ffprobe].map((binary) => new Promise<boolean>((resolve) => {
      const child = spawn(binary, ['-version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    }))).then((results) => results.every(Boolean));
    return this.available;
  }

  /** ffprobe, cached per file and modification time (a link from a debrid service, per link). */
  async probe(file: string): Promise<Probe> {
    const key = isRemote(file) ? file : `${file}:${(await fsp.stat(file)).mtimeMs}`;
    let entry = this.probes.get(key);
    if (!entry) {
      if (this.probes.size > 500) this.probes.clear();
      entry = this.runProbe(file).then(parseProbe);
      entry.catch(() => this.probes.delete(key));
      this.probes.set(key, entry);
    }
    return entry;
  }

  private runProbe(file: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffprobe, ['-v', 'error', ...remoteInput(file), '-print_format', 'json', '-show_format', '-show_streams', file], { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let errors = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), isRemote(file) ? 45_000 : 30_000);
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(errors.trim() || `ffprobe exited with ${code}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
      });
    });
  }

  /** Starts ffmpeg writing an HLS playlist and its segments into `dir`. */
  spawnHls(file: string, options: StreamOptions, dir: string): ChildProcess {
    return spawn(this.ffmpeg, ffmpegArgs(file, options, dir), { stdio: ['ignore', 'ignore', 'pipe'] });
  }

  /** One embedded text subtitle track as WebVTT. */
  extractSubtitle(file: string, index: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...remoteInput(file), '-i', file, '-map', `0:s:${index}`, '-f', 'webvtt', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let errors = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(errors.trim() || 'Could not read that subtitle track'));
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
  }
}

const seconds = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

export function parseProbe(raw: any): Probe {
  const streams: any[] = Array.isArray(raw?.streams) ? raw.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const tag = (stream: any, name: string) => stream?.tags?.[name] ?? stream?.tags?.[name.toUpperCase()];
  return {
    duration: seconds(raw?.format?.duration) || seconds(video?.duration),
    container: String(raw?.format?.format_name ?? ''),
    video: video ? { codec: String(video.codec_name ?? ''), profile: video.profile, pixFmt: video.pix_fmt, width: Number(video.width) || 0, height: Number(video.height) || 0 } : undefined,
    audios: streams.filter((stream) => stream.codec_type === 'audio').map((stream, index) => ({
      index,
      codec: String(stream.codec_name ?? ''),
      channels: Number(stream.channels) || 2,
      language: tag(stream, 'language'),
      title: tag(stream, 'title'),
      default: Boolean(stream.disposition?.default)
    })),
    subtitles: streams.filter((stream) => stream.codec_type === 'subtitle').map((stream, index) => ({
      index,
      codec: String(stream.codec_name ?? ''),
      language: tag(stream, 'language'),
      title: tag(stream, 'title'),
      text: TEXT_SUBTITLES.has(String(stream.codec_name ?? '')),
      forced: Boolean(stream.disposition?.forced)
    }))
  };
}

const tenBit = (pixFmt?: string) => /10|12/.test(pixFmt ?? '');

export function videoPlays(probe: Probe, caps: Caps): boolean {
  const video = probe.video;
  if (!video) return true;
  if (video.codec === 'h264') return !tenBit(video.pixFmt);
  if (video.codec === 'hevc') return caps.hevc;
  if (video.codec === 'av1') return caps.av1;
  return video.codec === 'vp9' || video.codec === 'vp8';
}

export function audioPlays(codec: string, caps: Caps): boolean {
  return BROWSER_AUDIO.has(codec) || ((codec === 'ac3' || codec === 'eac3') && caps.ac3);
}

/** The audio track to start on: the file's default, else the first. */
export function defaultAudio(probe: Probe): number {
  return probe.audios.find((audio) => audio.default)?.index ?? 0;
}

/**
 * How to get this file into a browser. MP4 and WebM with browser codecs play as they are (when the
 * first audio track is the one wanted); anything else is rewrapped, and video the browser can't
 * decode is converted.
 */
/** A file on a debrid service, read over HTTPS, rather than one on this machine. */
export const isRemote = (file: string) => /^https?:\/\//i.test(file);

/** Reading over the network: carry on through a dropped connection instead of ending the video. */
export function remoteInput(file: string): string[] {
  return isRemote(file) ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '10'] : [];
}

/** `name` is the file's name (for a link, the name it had in the torrent): its extension says the container. */
export function chooseMode(name: string, probe: Probe | null, caps: Caps, audio: number, canConvert: boolean): PlayMode {
  const ext = path.extname(name).toLowerCase();
  const nativeContainer = ['.mp4', '.m4v', '.webm', '.mov'].includes(ext);
  if (!probe) return nativeContainer || !canConvert ? 'direct' : 'remux';
  if (!canConvert) return 'direct';
  if (!videoPlays(probe, caps)) return 'transcode';
  const track = probe.audios.find((entry) => entry.index === audio) ?? probe.audios[0];
  const firstTrack = !track || track.index === (probe.audios[0]?.index ?? 0);
  if (nativeContainer && firstTrack && (!track || audioPlays(track.codec, caps))) return 'direct';
  return 'remux';
}

export interface StreamOptions {
  start: number;
  audio: number;
  mode: Exclude<PlayMode, 'direct'>;
  probe: Probe | null;
  caps: Caps;
}

/** Length of each HLS segment, in seconds. */
export const SEGMENT_SECONDS = 6;

/**
 * ffmpeg arguments for an HLS stream (fMP4 segments) of `file` from `start` seconds, written into
 * `dir`. HLS rather than one long MP4 because Safari only plays piped video that it can range over.
 */
export function ffmpegArgs(file: string, { start, audio, mode, probe, caps }: StreamOptions, dir: string): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (start > 0) args.push('-ss', start.toFixed(3));
  args.push(...remoteInput(file), '-i', file, '-map', '0:v:0', '-map', `0:a:${audio}?`);
  const video = probe?.video;
  if (mode === 'remux') {
    args.push('-c:v', 'copy');
    // Safari and Chrome only play HEVC in MP4 when it's tagged hvc1.
    if (video?.codec === 'hevc') args.push('-tag:v', 'hvc1');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      '-force_key_frames', 'expr:gte(t,n_forced*2)', '-sc_threshold', '0');
    // Converting 4K in real time is too much for most home servers; 1080p looks fine on a phone or laptop.
    if ((video?.height ?? 0) > 1080) args.push('-vf', 'scale=-2:1080');
  }
  const track = probe?.audios.find((entry) => entry.index === audio);
  if (track && (track.codec === 'aac' || track.codec === 'mp3' || (audioPlays(track.codec, caps) && track.codec !== 'flac' && track.codec !== 'vorbis'))) args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  args.push('-sn', '-dn', '-map_metadata', '-1',
    // Short first segments, so playback can begin after two seconds of video rather than six.
    '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_init_time', '2', '-hls_list_size', '0', '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(dir, 'seg%d.m4s'), path.join(dir, 'playlist.m3u8'));
  return args;
}

interface HlsJob { key: string; dir: string; child: ChildProcess; lastUsed: number; exited: boolean; error?: string }

/**
 * Local files the browser can't play as they are. One ffmpeg per playback position: a seek past what's
 * been made starts a new job there and ends the old one. Idle jobs are stopped and their files removed.
 */
export class HlsJobs {
  private readonly root = path.join(os.tmpdir(), 'haul-play');
  private readonly jobs = new Map<string, HlsJob>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly tools: MediaTools, private readonly maxJobs = 3) {
    fs.rmSync(this.root, { recursive: true, force: true });
    this.timer = setInterval(() => this.sweep(), 15_000);
    this.timer.unref();
  }

  /** Starts (or reuses) the job for this session and start time; resolves once the playlist exists. */
  async open(session: string, start: number, file: string, options: Omit<StreamOptions, 'start'>): Promise<HlsJob> {
    const key = `${session}:${start}`;
    let job = this.jobs.get(key);
    if (!job) {
      // Seeking within a session replaces its earlier job.
      for (const other of [...this.jobs.values()]) if (other.key.startsWith(`${session}:`)) this.stop(other);
      if (this.jobs.size >= this.maxJobs) {
        const oldest = [...this.jobs.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (oldest) this.stop(oldest);
      }
      const dir = path.join(this.root, `${session}-${start}`);
      await fsp.mkdir(dir, { recursive: true });
      const child = this.tools.spawnHls(file, { ...options, start }, dir);
      const created: HlsJob = { key, dir, child, lastUsed: Date.now(), exited: false };
      let errors = '';
      child.stderr?.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-2000); });
      child.on('error', (error) => { created.exited = true; created.error = error.message; });
      child.on('exit', (code) => {
        created.exited = true;
        if (code && code !== 255 && !child.killed) created.error = errors.trim().split('\n').pop() || `ffmpeg exited with ${code}`;
      });
      this.jobs.set(key, created);
      job = created;
    }
    job.lastUsed = Date.now();
    const playlist = path.join(job.dir, 'playlist.m3u8');
    for (let waited = 0; waited < 30_000; waited += 250) {
      if (fs.existsSync(playlist) && fs.readFileSync(playlist, 'utf8').includes('#EXTINF')) return job;
      if (job.exited) throw new Error(job.error ?? 'ffmpeg stopped before the video was ready');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('The video took too long to start. Try again.');
  }

  /** A file from a job's folder, or null. */
  file(session: string, start: number, name: string): string | null {
    const job = this.jobs.get(`${session}:${start}`);
    if (!job || !/^(playlist\.m3u8|init\.mp4|seg\d+\.m4s)$/.test(name)) return null;
    job.lastUsed = Date.now();
    const full = path.join(job.dir, name);
    return fs.existsSync(full) ? full : null;
  }

  /** The playlist so far. While ffmpeg is still working it has no end tag, and players keep asking. */
  playlist(session: string, start: number): string | null {
    const file = this.file(session, start, 'playlist.m3u8');
    return file ? fs.readFileSync(file, 'utf8') : null;
  }

  private stop(job: HlsJob): void {
    this.jobs.delete(job.key);
    if (!job.exited) job.child.kill('SIGKILL');
    void fsp.rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  private sweep(): void {
    for (const job of [...this.jobs.values()]) if (Date.now() - job.lastUsed > 90_000) this.stop(job);
  }

  close(): void {
    clearInterval(this.timer);
    for (const job of [...this.jobs.values()]) this.stop(job);
  }
}

/** SRT to WebVTT: a header, dots for decimal commas, and nothing else changed. */
export function srtToVtt(srt: string): string {
  const body = srt.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (body.startsWith('WEBVTT')) return `${body}\n`;
  return `WEBVTT\n\n${body.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}\n`;
}

/** "English", "English (SDH)", "Track 3". */
const LANGUAGE_NAMES: Record<string, string> = Object.fromEntries(Object.entries({
  English: ['eng', 'en'],
  Spanish: ['spa', 'es'],
  French: ['fre', 'fra', 'fr'],
  German: ['ger', 'deu', 'de'],
  Italian: ['ita', 'it'],
  Japanese: ['jpn', 'ja'],
  Korean: ['kor', 'ko'],
  Portuguese: ['por', 'pt'],
  Russian: ['rus', 'ru'],
  Chinese: ['chi', 'zho', 'zh'],
  Hindi: ['hin', 'hi'],
  Dutch: ['dut', 'nld', 'nl'],
  Swedish: ['swe', 'sv'],
  Polish: ['pol', 'pl'],
  Turkish: ['tur', 'tr'],
  Arabic: ['ara', 'ar'],
  Danish: ['dan', 'da'],
  Norwegian: ['nor', 'nob', 'nno', 'no', 'nb'],
  Finnish: ['fin', 'fi'],
  Czech: ['cze', 'ces', 'cs'],
  Hungarian: ['hun', 'hu'],
  Greek: ['gre', 'ell', 'el'],
  Hebrew: ['heb', 'he'],
  Thai: ['tha', 'th'],
  Vietnamese: ['vie', 'vi'],
  Indonesian: ['ind', 'id'],
  Malay: ['may', 'msa', 'ms'],
  Romanian: ['rum', 'ron', 'ro'],
  Ukrainian: ['ukr', 'uk'],
  Bulgarian: ['bul', 'bg'],
  Croatian: ['hrv', 'hr'],
  Serbian: ['srp', 'sr'],
  Slovenian: ['slv', 'sl'],
  Slovak: ['slo', 'slk', 'sk'],
  Estonian: ['est', 'et'],
  Latvian: ['lav', 'lv'],
  Lithuanian: ['lit', 'lt'],
  Icelandic: ['ice', 'isl', 'is'],
  Catalan: ['cat', 'ca'],
  Basque: ['baq', 'eus', 'eu'],
  Galician: ['glg', 'gl'],
  Filipino: ['fil', 'tgl', 'tl'],
  Persian: ['per', 'fas', 'fa'],
  Urdu: ['urd', 'ur'],
  Bengali: ['ben', 'bn'],
  Tamil: ['tam', 'ta'],
  Telugu: ['tel', 'te'],
}).flatMap(([name, codes]) => codes.map((code) => [code, name])));

/** "eng", "en" and "English" all become "English", so a choice carries over between files and TorBox. */
export function languageName(code?: string | null): string | undefined {
  const value = code?.trim();
  if (!value || /^(und|unknown|n\/a)$/i.test(value)) return undefined;
  const lower = value.toLowerCase();
  return LANGUAGE_NAMES[lower] ?? (lower.length > 3 ? lower[0]!.toUpperCase() + lower.slice(1) : value.toUpperCase());
}

export function trackLabel(entry: { language?: string; title?: string; index: number; codec?: string; channels?: number }, kind: 'audio' | 'subtitle'): string {
  const language = languageName(entry.language) ?? '';
  let title = entry.title && entry.title.trim().toLowerCase() !== language.toLowerCase() ? entry.title.trim() : '';
  // "English (SDH)" on an English track is just "SDH".
  if (title && language && title.toLowerCase().startsWith(language.toLowerCase())) title = title.slice(language.length).trim().replace(/^\((.*)\)$/, '$1').trim();
  const channels = kind === 'audio' && entry.channels ? (entry.channels >= 6 ? `${entry.channels === 8 ? '7.1' : '5.1'}` : entry.channels === 1 ? 'mono' : '') : '';
  const label = [language, title && (title.includes('(') ? `· ${title}` : `(${title})`), channels].filter(Boolean).join(' ');
  return label || `Track ${entry.index + 1}`;
}
