import type { AddonInfo, Follow, FolderListing, FolderStatus, HomeRow, Job, LibraryItem, LibrarySummary, MediaType, Meta, MetaPreview, NewEpisodes, PlayCaps, PlaySession, Profile, Release, RemoteView, ScheduleItem, SeasonPlan, Settings, SettingsPatch, SetupRequest, Status, TorboxAccount, UploadAdded, VersionFilter, WatchProgress, WatchlistItem } from '../../shared/types';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Recent answers for pages you go back to: the catalog, titles and the library, kept a minute. */
const recent = new Map<string, { at: number; value: Promise<unknown> }>();
const CACHEABLE = /^\/api\/(home|meta\/|catalog\/|search\?)/;
/** Requests that change nothing those pages show (getting a stream ready, playing), so keep the cache. */
const HARMLESS = /^\/api\/(play\b|progress\b)/;

/** The card you pressed, so a title page can show its artwork and name at once while the rest loads. */
const previews = new Map<string, MetaPreview>();
export function rememberPreview(item: MetaPreview): void {
  previews.set(`${item.type}:${item.id}`, { ...previews.get(`${item.type}:${item.id}`), ...item });
}
export const previewOf = (type: MediaType, id: string): MetaPreview | undefined => previews.get(`${type}:${id}`);
function rememberAll<T>(value: Promise<T>, items: (data: T) => MetaPreview[]): Promise<T> {
  return value.then((data) => {
    for (const item of items(data)) if (!previews.has(`${item.type}:${item.id}`)) previews.set(`${item.type}:${item.id}`, item);
    return data;
  });
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (method !== 'GET') { if (!HARMLESS.test(path)) recent.clear(); }
  else if (CACHEABLE.test(path)) {
    const hit = recent.get(path);
    if (hit && Date.now() - hit.at < 60_000) return hit.value as Promise<T>;
    const value = send<T>(method, path, body);
    recent.set(path, { at: Date.now(), value });
    value.catch(() => recent.delete(path));
    return value;
  }
  return send<T>(method, path, body);
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
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

/** The audio and subtitle languages last picked in the player, so the next episode starts the same way. */
export const languages = {
  read(): { audioLanguage?: string; subtitleLanguage?: string } {
    try { return { audioLanguage: localStorage.getItem('haul.audio') || undefined, subtitleLanguage: localStorage.getItem('haul.subtitles') || undefined }; } catch { return {}; }
  },
  save(kind: 'audio' | 'subtitles', language: string | undefined): void {
    try { if (language) localStorage.setItem(`haul.${kind}`, language); else localStorage.removeItem(`haul.${kind}`); } catch { /* storage blocked */ }
  }
};

const preparedAt = new Map<string, number>();

/**
 * Tells the server what is likely to be played next, so pressing play is near instant: `stream` starts
 * TorBox's stream too (only for versions already in the TorBox list). Repeats within 30 s are skipped.
 */
export function preparePlay(target: { type: MediaType; imdbId: string; season?: number; episode?: number }, stream = false): void {
  const key = `${target.type}:${target.imdbId}:${target.season}:${target.episode}:${stream}`;
  if (Date.now() - (preparedAt.get(key) ?? 0) < 30_000) return;
  preparedAt.set(key, Date.now());
  void request('POST', '/api/play/prepare', { ...target, stream, ...languages.read() }).catch(() => undefined);
}

export const api = {
  status: () => request<Status>('GET', '/api/status'),
  login: (password: string, code?: string) => request<{ ok: true }>('POST', '/api/login', { password, code }),
  twoFactorStart: (password: string) => request<{ secret: string; url: string }>('POST', '/api/two-factor/start', { password }),
  twoFactorConfirm: (code: string) => request<{ ok: true }>('POST', '/api/two-factor/confirm', { code }),
  twoFactorOff: (password: string, code: string) => request<{ ok: true }>('POST', '/api/two-factor/off', { password, code }),
  endOtherSessions: () => request<{ ok: true }>('POST', '/api/sessions/end-others'),
  watchlist: () => request<{ items: WatchlistItem[] }>('GET', '/api/watchlist'),
  remote: () => request<RemoteView>('GET', '/api/remote'),
  setRemote: (body: { mode: 'off' | 'quick' | 'token'; token?: string; hostname?: string }) => request<RemoteView>('POST', '/api/remote', body),
  addProfile: (name: string, color?: string) => request<Profile>('POST', '/api/profiles', { name, color }),
  updateProfile: (id: string, change: { name?: string; color?: string; avatar?: string | null }) => request<Profile>('PUT', `/api/profiles/${id}`, change),
  removeProfile: (id: string) => request<{ ok: true }>('DELETE', `/api/profiles/${id}`),
  selectProfile: (id: string) => request<Profile>('POST', '/api/profiles/select', { id }),
  history: () => request<{ items: WatchProgress[] }>('GET', '/api/progress/history'),
  addToList: (item: Omit<WatchlistItem, 'addedAt'>) => request<WatchlistItem>('POST', '/api/watchlist', item),
  removeFromList: (type: MediaType, imdbId: string) => request<{ ok: true }>('DELETE', `/api/watchlist/${type}/${imdbId}`),
  markWatched: (body: { type: MediaType; imdbId: string; title: string; poster?: string; background?: string; episodes?: Array<{ season: number; episode: number; title?: string }>; watched: boolean }) =>
    request<{ items: WatchProgress[] }>('POST', '/api/progress/watched', body),
  logout: () => request<{ ok: true }>('POST', '/api/logout'),

  settings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (patch: SettingsPatch) => request<Settings>('PUT', '/api/settings', patch),
  changePassword: (current: string, next: string | null) => request<{ ok: true }>('POST', '/api/password', { current, next }),
  testTorbox: (apiKey?: string) => request<TorboxAccount>('POST', '/api/settings/torbox-test', { apiKey }),
  setupDefaults: () => request<{ moviesDir: string; tvDir: string; needsPassword: boolean }>('GET', '/api/setup/defaults'),
  setupTestTorbox: (apiKey: string) => request<TorboxAccount>('POST', '/api/setup/torbox-test', { apiKey }),
  setup: (body: SetupRequest) => request<{ ok: true; account: TorboxAccount }>('POST', '/api/setup', body),
  folders: (path: string) => request<FolderListing>('GET', `/api/folders?path=${encodeURIComponent(path)}`),
  folderStatus: () => request<{ folders: FolderStatus[] }>('GET', '/api/folders/status'),
  checkFolders: () => request<{ results: Array<{ dir: string; ok: boolean; error?: string }> }>('POST', '/api/settings/check-folders'),

  home: () => rememberAll(request<{ rows: HomeRow[] }>('GET', '/api/home'), (data) => data.rows.flatMap((row) => row.items)),
  catalog: (type: MediaType, id: string, options: { genre?: string; skip?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.genre) query.set('genre', options.genre);
    if (options.skip) query.set('skip', String(options.skip));
    return rememberAll(request<{ items: MetaPreview[] }>('GET', `/api/catalog/${type}/${id}?${query}`), (data) => data.items);
  },
  newEpisodes: () => request<{ shows: NewEpisodes[] }>('GET', '/api/new-episodes'),
  search: (q: string) => rememberAll(request<{ movies: MetaPreview[]; series: MetaPreview[] }>('GET', `/api/search?q=${encodeURIComponent(q)}`), (data) => [...data.movies, ...data.series]),
  meta: (type: MediaType, id: string) => request<Meta>('GET', `/api/meta/${type}/${id}`),

  movieReleases: (id: string) => request<{ releases: Release[] }>('GET', `/api/releases/movie/${id}`),
  seasonPacks: (id: string, season: number) => request<{ releases: Release[] }>('GET', `/api/releases/series/${id}/${season}`),
  episodeReleases: (id: string, season: number, episode: number) => request<{ releases: Release[] }>('GET', `/api/releases/series/${id}/${season}/${episode}`),
  planSeason: (imdbId: string, season: number, episodes?: number[], skipOwned = true) =>
    request<SeasonPlan>('POST', '/api/plan/season', { imdbId, season, episodes, skipOwned }),

  downloads: () => request<{ jobs: Job[] }>('GET', '/api/downloads'),
  startUpload: (body: { name: string; size: number; type?: MediaType; imdbId?: string }) => request<{ id: string; received: number }>('POST', '/api/uploads', body),
  finishUpload: (id: string) => request<UploadAdded>('POST', `/api/uploads/${id}/finish`),
  cancelUpload: (id: string) => request<{ ok: true }>('DELETE', `/api/uploads/${id}`),
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
  follow: (type: MediaType, imdbId: string, autoDownload: boolean, want?: VersionFilter) => request<{ follow: Follow; notificationsReady: boolean }>('POST', '/api/follows', { type, imdbId, autoDownload, want }),
  updateFollow: (id: string, patch: { autoDownload?: boolean; want?: VersionFilter | null }) => request<{ follow: Follow }>('POST', `/api/follows/${id}`, patch),
  followLibrary: () => request<{ added: number; follows: Follow[] }>('POST', '/api/follows/library'),
  unfollow: (id: string) => request<{ ok: true }>('DELETE', `/api/follows/${id}`),
  schedule: () => request<{ items: ScheduleItem[] }>('GET', '/api/schedule'),
  testNotification: () => request<{ ok: true }>('POST', '/api/notifications/test'),

  addon: () => request<AddonInfo>('GET', '/api/addon'),
  regenerateAddon: () => request<AddonInfo>('POST', '/api/addon/regenerate'),
  play: (body: { type: MediaType; imdbId: string; season?: number; episode?: number; source?: 'local' | 'torbox'; hash?: string; caps: PlayCaps }) => request<PlaySession>('POST', '/api/play', { ...body, ...languages.read() }),
  playTracks: (stream: string, choice: { audio?: number; subtitle?: number | null }) => request<{ url: string; audio: number; subtitle: number | null }>('POST', `/api/play/torbox/${stream}/tracks`, choice),
  playInfo: () => request<{ ffmpeg: boolean; torbox: boolean }>('GET', '/api/play/info'),
  progressFor: (type: MediaType, imdbId: string) => request<{ items: WatchProgress[] }>('GET', `/api/progress/title/${type}/${imdbId}`),
  continueWatching: () => request<{ items: WatchProgress[] }>('GET', '/api/continue'),
  forgetProgress: (key: string) => request<{ ok: true }>('DELETE', `/api/progress/${encodeURIComponent(key)}`),
  /** keepalive lets the last position save as the page closes. */
  saveProgress: (body: Omit<WatchProgress, 'key' | 'updatedAt' | 'upNext'>, keepalive = false) => fetch('/api/progress', {
    method: 'POST', keepalive, credentials: 'same-origin',
    headers: { 'X-Haul-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => undefined),
  calendar: () => request<{ url: string; webcalUrl: string; mode: 'found' | 'aired' }>('GET', '/api/calendar'),
  setCalendarMode: (mode: 'found' | 'aired') => request<{ url: string; webcalUrl: string; mode: 'found' | 'aired' }>('POST', '/api/calendar/mode', { mode }),
  regenerateCalendar: () => request<{ url: string; webcalUrl: string; mode: 'found' | 'aired' }>('POST', '/api/calendar/regenerate')
};
