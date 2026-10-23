import type {
  AddonInfo, Follow, HomeRow, ScheduleItem, Job, LibraryItem, LibrarySummary, MediaType, Meta, MetaPreview, NewEpisodes, Release, SeasonPlan, Settings, SettingsPatch, SetupRequest, Status, TorboxAccount
} from '../../shared/types';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'X-Haul-Request': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin'
  });
  let data: any = null;
  try { data = await response.json(); } catch { /* empty body */ }
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') window.dispatchEvent(new Event('haul:unauthorized'));
    throw new ApiError(data?.error || `Request failed (${response.status})`, response.status);
  }
  return data as T;
}

export const api = {
  status: () => request<Status>('GET', '/api/status'),
  login: (password: string) => request<{ ok: true }>('POST', '/api/login', { password }),
  logout: () => request<{ ok: true }>('POST', '/api/logout'),

  settings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (patch: SettingsPatch) => request<Settings>('PUT', '/api/settings', patch),
  changePassword: (current: string, next: string | null) => request<{ ok: true }>('POST', '/api/password', { current, next }),
  testTorbox: (apiKey?: string) => request<TorboxAccount>('POST', '/api/settings/torbox-test', { apiKey }),
  setupDefaults: () => request<{ moviesDir: string; tvDir: string; needsPassword: boolean }>('GET', '/api/setup/defaults'),
  setupTestTorbox: (apiKey: string) => request<TorboxAccount>('POST', '/api/setup/torbox-test', { apiKey }),
  setup: (body: SetupRequest) => request<{ ok: true; account: TorboxAccount }>('POST', '/api/setup', body),
  checkFolders: () => request<{ results: Array<{ dir: string; ok: boolean; error?: string }> }>('POST', '/api/settings/check-folders'),

  home: () => request<{ rows: HomeRow[] }>('GET', '/api/home'),
  catalog: (type: MediaType, id: string, options: { genre?: string; skip?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.genre) query.set('genre', options.genre);
    if (options.skip) query.set('skip', String(options.skip));
    return request<{ items: MetaPreview[] }>('GET', `/api/catalog/${type}/${id}?${query}`);
  },
  newEpisodes: () => request<{ shows: NewEpisodes[] }>('GET', '/api/new-episodes'),
  search: (q: string) => request<{ movies: MetaPreview[]; series: MetaPreview[] }>('GET', `/api/search?q=${encodeURIComponent(q)}`),
  meta: (type: MediaType, id: string) => request<Meta>('GET', `/api/meta/${type}/${id}`),

  movieReleases: (id: string) => request<{ releases: Release[] }>('GET', `/api/releases/movie/${id}`),
  seasonPacks: (id: string, season: number) => request<{ releases: Release[] }>('GET', `/api/releases/series/${id}/${season}`),
  episodeReleases: (id: string, season: number, episode: number) => request<{ releases: Release[] }>('GET', `/api/releases/series/${id}/${season}/${episode}`),
  planSeason: (imdbId: string, season: number, episodes?: number[], skipOwned = true) =>
    request<SeasonPlan>('POST', '/api/plan/season', { imdbId, season, episodes, skipOwned }),

  downloads: () => request<{ jobs: Job[] }>('GET', '/api/downloads'),
  download: (body: { type: MediaType; imdbId: string; release?: Release; season?: number; episodes?: number[]; items?: Array<{ release: Release; season: number; episodes: number[] }> }) =>
    request<{ jobs: Job[] }>('POST', '/api/downloads', body),
  jobAction: (id: string, action: 'pause' | 'resume' | 'retry' | 'cancel') => request<{ job: Job }>('POST', `/api/downloads/${id}/${action}`),
  removeJob: (id: string) => request<{ ok: true }>('DELETE', `/api/downloads/${id}`),
  clearFinished: () => request<{ ok: true }>('POST', '/api/downloads/clear'),

  library: () => request<{ items: LibrarySummary[]; scanning: boolean; scannedAt?: number }>('GET', '/api/library'),
  libraryItem: (id: string) => request<LibraryItem>('GET', `/api/library/${id}`),
  scanLibrary: () => request<{ ok: true }>('POST', '/api/library/scan'),
  matchLibraryItem: (id: string, imdbId: string | null) => request<LibraryItem>('POST', `/api/library/${id}/match`, { imdbId }),

  follows: () => request<{ follows: Follow[] }>('GET', '/api/follows'),
  follow: (type: MediaType, imdbId: string, autoDownload: boolean) => request<{ follow: Follow; notificationsReady: boolean }>('POST', '/api/follows', { type, imdbId, autoDownload }),
  updateFollow: (id: string, autoDownload: boolean) => request<{ follow: Follow }>('POST', `/api/follows/${id}`, { autoDownload }),
  unfollow: (id: string) => request<{ ok: true }>('DELETE', `/api/follows/${id}`),
  schedule: () => request<{ items: ScheduleItem[] }>('GET', '/api/schedule'),
  testNotification: () => request<{ ok: true }>('POST', '/api/notifications/test'),

  addon: () => request<AddonInfo>('GET', '/api/addon'),
  regenerateAddon: () => request<AddonInfo>('POST', '/api/addon/regenerate')
};
