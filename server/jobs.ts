import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Job, JobFile, Meta, Release } from '../shared/types.js';
import type { ServerOptions } from './config.js';
import { downloadToFile, moveFile } from './downloader.js';
import { planFiles } from './organize.js';
import type { SettingsService } from './settings.js';
import { JsonFile } from './store.js';
import { type Torbox, TorboxError, type TorboxTorrent, magnetFor } from './torbox.js';

export interface NewJob {
  meta: Meta;
  release: Release;
  season?: number;
  episodes?: number[];
  groupId?: string;
}

interface Deps {
  options: ServerOptions;
  settings: SettingsService;
  torbox: Torbox;
  onCompleted: (job: Job) => void;
}

const MAX_ATTEMPTS = 5;
const ACTIVE = new Set(['queued', 'torbox', 'downloading']);

function episodeLabel(season: number, episodes: number[], seasonEpisodeCount: number): string {
  const s = `S${String(season).padStart(2, '0')}`;
  if (!episodes.length || episodes.length >= seasonEpisodeCount) return `Season ${season}`;
  if (episodes.length === 1) return `${s}E${String(episodes[0]).padStart(2, '0')}`;
  const sorted = [...episodes].sort((a, b) => a - b);
  const contiguous = sorted.every((value, index) => index === 0 || value === sorted[index - 1]! + 1);
  return contiguous ? `${s} · E${sorted[0]}–E${sorted[sorted.length - 1]}` : `${s} · ${sorted.length} episodes`;
}

export class JobManager {
  private readonly file: JsonFile<{ jobs: Job[] }>;
  private readonly running = new Map<string, AbortController>();
  private readonly misses = new Map<string, number>();
  private readonly samples = new Map<string, { bytes: number; at: number }>();
  private ticking = false;
  private lastCreate = 0;
  private lastPoll = 0;
  private timer: NodeJS.Timeout | null = null;
  private torrentList: { at: number; list: TorboxTorrent[] } | null = null;

  constructor(private readonly deps: Deps) {
    this.file = new JsonFile(path.join(deps.options.dataDir, 'jobs.json'), () => ({ jobs: [] }));
    for (const job of this.file.data.jobs) {
      for (const file of job.files) if (file.status === 'downloading') file.status = 'pending';
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 2000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.running.values()) controller.abort();
    this.file.flush();
  }

  get jobs(): Job[] {
    return this.file.data.jobs;
  }

  activeCount(): number {
    return this.jobs.filter((job) => ACTIVE.has(job.status)).length;
  }

  find(id: string): Job | undefined {
    return this.jobs.find((job) => job.id === id);
  }

  create(input: NewJob): Job {
    const { meta, release } = input;
    const seasonEpisodes = input.season !== undefined ? meta.episodes.filter((episode) => episode.season === input.season) : [];
    const episodes = input.season !== undefined
      ? (input.episodes?.length ? [...new Set(input.episodes)].sort((a, b) => a - b) : seasonEpisodes.map((episode) => episode.episode))
      : undefined;
    const now = Date.now();
    const job: Job = {
      id: crypto.randomUUID(),
      type: meta.type,
      imdbId: meta.id,
      title: meta.name,
      year: meta.year,
      poster: meta.poster,
      background: meta.background,
      label: meta.type === 'movie' ? 'Movie' : episodeLabel(input.season ?? 1, episodes ?? [], seasonEpisodes.length),
      season: input.season,
      episodes,
      episodeTitles: Object.fromEntries(seasonEpisodes.map((episode) => [`${episode.season}:${episode.episode}`, episode.title])),
      release: {
        hash: release.hash.toLowerCase(),
        name: release.name,
        kind: release.kind,
        cached: release.cached,
        info: release.info,
        fileSize: release.fileSize,
        totalSize: release.totalSize,
        origin: release.origin
      },
      status: 'queued',
      torbox: {},
      files: [],
      speed: 0,
      groupId: input.groupId,
      createdAt: now,
      updatedAt: now
    };
    this.jobs.unshift(job);
    this.file.save();
    void this.tick();
    return job;
  }

  private touch(job: Job): void {
    job.updatedAt = Date.now();
    this.file.save();
  }

  private abortJob(job: Job): void {
    for (const file of job.files) {
      const controller = this.running.get(`${job.id}:${file.key}`);
      if (controller) controller.abort();
      if (file.status === 'downloading') file.status = 'pending';
    }
  }

  pause(id: string): Job | undefined {
    const job = this.find(id);
    if (!job || !ACTIVE.has(job.status)) return job;
    this.abortJob(job);
    job.resumeTo = job.status;
    job.status = 'paused';
    job.speed = 0;
    this.touch(job);
    return job;
  }

  resume(id: string): Job | undefined {
    const job = this.find(id);
    if (!job || job.status !== 'paused') return job;
    job.status = job.resumeTo ?? 'queued';
    job.resumeTo = undefined;
    this.touch(job);
    void this.tick();
    return job;
  }

  retry(id: string): Job | undefined {
    const job = this.find(id);
    if (!job || !['failed', 'cancelled'].includes(job.status)) return job;
    job.error = undefined;
    job.note = undefined;
    job.nextAttemptAt = undefined;
    if (job.files.length && job.torbox.id) {
      for (const file of job.files) if (file.status === 'failed' || file.status === 'pending') { file.status = 'pending'; file.attempts = 0; file.error = undefined; file.retryAt = undefined; }
      job.status = 'downloading';
    } else {
      job.files = [];
      job.torbox = {};
      job.status = 'queued';
    }
    this.touch(job);
    void this.tick();
    return job;
  }

  async cancel(id: string): Promise<Job | undefined> {
    const job = this.find(id);
    if (!job || ['completed', 'cancelled'].includes(job.status)) return job;
    this.abortJob(job);
    job.status = 'cancelled';
    job.note = undefined;
    job.speed = 0;
    this.touch(job);
    await this.cleanupPartials(job);
    if (job.torbox.createdByHaul && job.torbox.id) await this.deps.torbox.remove(job.torbox.id).catch(() => undefined);
    return job;
  }

  async remove(id: string): Promise<void> {
    const job = this.find(id);
    if (!job) return;
    if (ACTIVE.has(job.status) || job.status === 'paused') await this.cancel(id);
    this.file.data.jobs = this.jobs.filter((item) => item.id !== id);
    this.file.save();
  }

  clearFinished(): void {
    this.file.data.jobs = this.jobs.filter((job) => !['completed', 'cancelled'].includes(job.status));
    this.file.save();
  }

  private partDir(job: Job): string {
    return path.join(this.deps.settings.value.incompleteDir, job.id);
  }

  private async cleanupPartials(job: Job): Promise<void> {
    await fsp.rm(this.partDir(job), { recursive: true, force: true }).catch(() => undefined);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      if (this.deps.torbox.configured) {
        if (now - this.lastCreate >= 3000) {
          const next = this.jobs.slice().reverse().find((job) => job.status === 'queued' && (!job.nextAttemptAt || job.nextAttemptAt <= now));
          if (next) { this.lastCreate = now; await this.addToTorbox(next); }
        }
        if (now - this.lastPoll >= 5000 && this.jobs.some((job) => job.status === 'torbox')) {
          this.lastPoll = now;
          await this.pollTorbox();
        }
      } else {
        for (const job of this.jobs) if (job.status === 'queued') job.note = 'Waiting for a TorBox API key — add it in Settings.';
      }
      this.fillDownloadSlots();
      this.updateSpeeds();
    } catch (error) {
      console.error('[jobs] tick failed', error);
    } finally {
      this.ticking = false;
    }
  }

  private async torrents(maxAgeMs: number): Promise<TorboxTorrent[]> {
    if (!this.torrentList || Date.now() - this.torrentList.at > maxAgeMs) {
      this.torrentList = { at: Date.now(), list: await this.deps.torbox.list() };
    }
    return this.torrentList.list;
  }

  private matchTorrent(job: Job, list: TorboxTorrent[]): TorboxTorrent | undefined {
    const hash = job.release.hash;
    return list.find((torrent) => job.torbox.id !== undefined && torrent.id === job.torbox.id)
      ?? list.find((torrent) => torrent.hash?.toLowerCase() === hash || torrent.alternative_hashes?.some((value) => value.toLowerCase() === hash));
  }

  private async addToTorbox(job: Job): Promise<void> {
    try {
      const existing = this.matchTorrent(job, await this.torrents(20_000));
      if (existing) {
        job.torbox = { id: existing.id, state: existing.download_state, progress: existing.progress, createdByHaul: false };
      } else {
        const created = await this.deps.torbox.create(magnetFor(job.release.hash, job.release.name), job.release.name);
        job.torbox = { id: created.torrentId, queuedId: created.queuedId, state: created.queuedId ? 'Queued on TorBox' : 'Added', createdByHaul: true };
        this.torrentList = null;
      }
      job.status = 'torbox';
      job.note = undefined;
      this.lastPoll = 0;
    } catch (error) {
      const failure = error as TorboxError;
      const message = failure.message || 'TorBox rejected the torrent';
      if (failure.code === 'RATE_LIMIT') {
        job.nextAttemptAt = Date.now() + (failure.retryAfter ?? 60) * 1000;
        job.note = message;
      } else if (failure.code === 'NETWORK' || failure.code === 'NO_KEY' || /active|limit|slot|cooldown/i.test(`${failure.code} ${message}`)) {
        job.nextAttemptAt = Date.now() + 60_000;
        job.note = /active|slot/i.test(message) ? 'All your TorBox download slots are busy. Waiting for one to free up.' : message;
      } else {
        job.status = 'failed';
        job.error = message;
      }
    }
    this.touch(job);
  }

  private async pollTorbox(): Promise<void> {
    let list: TorboxTorrent[];
    try {
      list = await this.torrents(0);
    } catch (error) {
      for (const job of this.jobs) if (job.status === 'torbox') job.note = (error as Error).message;
      return;
    }
    const settings = this.deps.settings.value;
    for (const job of this.jobs.filter((item) => item.status === 'torbox')) {
      const torrent = this.matchTorrent(job, list);
      if (!torrent) {
        if (job.torbox.queuedId && !job.torbox.id) { job.torbox.state = 'Queued on TorBox'; continue; }
        const misses = (this.misses.get(job.id) ?? 0) + 1;
        this.misses.set(job.id, misses);
        if (misses >= 4) { job.status = 'failed'; job.error = 'This torrent is no longer in your TorBox list.'; this.touch(job); }
        continue;
      }
      this.misses.delete(job.id);
      job.torbox.id = torrent.id;
      job.torbox.state = torrent.download_state;
      job.torbox.progress = torrent.progress;
      job.torbox.speed = torrent.download_speed;
      job.torbox.eta = torrent.eta;
      job.note = /stalled|no seeds/i.test(torrent.download_state) ? 'TorBox is waiting for seeders for this torrent.' : undefined;
      if (/error|failed|invalid/i.test(torrent.download_state)) {
        job.status = 'failed';
        job.error = `TorBox reported: ${torrent.download_state}`;
      } else if (torrent.download_present || (torrent.download_finished && torrent.cached)) {
        const files = planFiles(job, torrent.files || [], {
          moviesDir: settings.moviesDir,
          tvDir: settings.tvDir,
          episodeTitles: settings.downloads.episodeTitles,
          qualityInName: settings.downloads.qualityInName,
          subtitles: settings.downloads.subtitles
        });
        if (!files.some((file) => file.kind === 'video')) {
          job.status = 'failed';
          job.error = job.type === 'series'
            ? `No video files for ${job.label} were found in this torrent.`
            : 'No video file was found in this torrent.';
        } else {
          for (const file of files) {
            try {
              if (fs.statSync(file.target).size === file.size) { file.status = 'skipped'; file.downloaded = file.size; }
            } catch { /* not downloaded yet */ }
          }
          job.files = files;
          job.status = 'downloading';
          this.finishIfDone(job);
        }
      }
      this.touch(job);
    }
  }

  private fillDownloadSlots(): void {
    const settings = this.deps.settings.value;
    let free = settings.downloads.concurrentFiles - this.running.size;
    if (free <= 0) return;
    const now = Date.now();
    for (const job of this.jobs.slice().reverse()) {
      if (job.status !== 'downloading' || !job.torbox.id) continue;
      for (const file of job.files) {
        if (free <= 0) return;
        if (file.status !== 'pending' || (file.retryAt && file.retryAt > now)) continue;
        if (this.running.has(`${job.id}:${file.key}`)) continue;
        free -= 1;
        void this.downloadFile(job, file);
      }
    }
  }

  private async downloadFile(job: Job, file: JobFile): Promise<void> {
    const key = `${job.id}:${file.key}`;
    const controller = new AbortController();
    this.running.set(key, controller);
    file.status = 'downloading';
    file.error = undefined;
    this.touch(job);
    const part = path.join(this.partDir(job), `${file.key}${file.kind === 'subtitle' ? '.srt' : ''}.part`);
    try {
      const url = await this.deps.torbox.downloadLink(job.torbox.id!, file.torboxFileId);
      await downloadToFile(url, part, {
        expectedSize: file.size || undefined,
        signal: controller.signal,
        onProgress: (bytes) => { file.downloaded = bytes; }
      });
      let target = file.target;
      try {
        if (fs.statSync(target).size !== file.size) target = target.replace(/(\.[a-z0-9]+)$/i, ` (Haul)$1`);
      } catch { /* target is free */ }
      await moveFile(part, target, this.deps.options.owner);
      file.target = target;
      file.status = 'done';
      file.downloaded = file.size;
    } catch (error) {
      if (controller.signal.aborted) return;
      file.attempts += 1;
      file.error = (error as Error).message;
      if (file.attempts >= MAX_ATTEMPTS) file.status = 'failed';
      else { file.status = 'pending'; file.retryAt = Date.now() + Math.min(120_000, 5_000 * 2 ** (file.attempts - 1)); }
    } finally {
      this.running.delete(key);
      this.finishIfDone(job);
      this.touch(job);
    }
  }

  private finishIfDone(job: Job): void {
    if (job.status !== 'downloading') return;
    const open = job.files.some((file) => file.status === 'pending' || file.status === 'downloading');
    if (open) return;
    const failedVideos = job.files.filter((file) => file.status === 'failed' && file.kind === 'video');
    if (failedVideos.length) {
      job.status = 'failed';
      job.error = `${failedVideos.length} file${failedVideos.length === 1 ? '' : 's'} could not be downloaded. ${failedVideos[0]!.error ?? ''}`.trim();
      return;
    }
    job.status = 'completed';
    job.note = undefined;
    job.completedAt = Date.now();
    job.speed = 0;
    void this.cleanupPartials(job);
    if (this.deps.settings.value.downloads.removeFromTorbox && job.torbox.createdByHaul && job.torbox.id) {
      void this.deps.torbox.remove(job.torbox.id).catch(() => undefined);
    }
    try { this.deps.onCompleted(job); } catch (error) { console.error('[jobs] library update failed', error); }
  }

  private updateSpeeds(): void {
    const now = Date.now();
    for (const job of this.jobs) {
      if (job.status !== 'downloading') { this.samples.delete(job.id); continue; }
      const bytes = job.files.reduce((sum, file) => sum + file.downloaded, 0);
      const previous = this.samples.get(job.id);
      if (previous && now > previous.at) {
        const instant = Math.max(0, (bytes - previous.bytes) / ((now - previous.at) / 1000));
        job.speed = Math.round(job.speed ? job.speed * 0.6 + instant * 0.4 : instant);
      }
      this.samples.set(job.id, { bytes, at: now });
    }
  }
}
