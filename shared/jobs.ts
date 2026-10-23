import type { Job } from './types.js';

/** How far along a download is (0–1): bytes on this machine once files are coming, else TorBox's own figure. */
export function jobProgress(job: Pick<Job, 'files' | 'torbox'>): { value: number; remote: boolean } {
  const total = job.files.reduce((sum, file) => sum + file.size, 0);
  if (job.files.length && total) return { value: job.files.reduce((sum, file) => sum + Math.min(file.downloaded, file.size), 0) / total, remote: false };
  return { value: job.torbox.progress ?? 0, remote: true };
}
