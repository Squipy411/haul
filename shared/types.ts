// Types shared by the server and the web dashboard.

export type MediaType = 'movie' | 'series';

export type Resolution = '2160p' | '1080p' | '720p' | '480p' | 'unknown';

export interface ReleaseInfo {
  resolution: Resolution;
  source?: string;
  hdr: string[];
  codec?: string;
  bitDepth?: number;
  audio: string[];
  channels?: string;
  group?: string;
  languages: string[];
  seasons: number[];
  episodes: number[];
  complete: boolean;
  upscaled: boolean;
  threeD: boolean;
  lowQuality: boolean;
}

/** What a torrent covers relative to the title being requested. */
export type ReleaseKind = 'movie' | 'episode' | 'season' | 'multi-season';

export interface PackFile {
  id: number;
  name: string;
  size: number;
}

export interface Release {
  hash: string;
  name: string;
  fileName?: string;
  /** Size of the matching file (episode/movie) when known. */
  fileSize?: number;
  /** Size of what Haul would download (for a pack: the requested season's videos) when known. */
  totalSize?: number;
  /** Size of every video in the torrent (cached packs only). */
  packSize?: number;
  seeders?: number;
  provider?: string;
  origin: string;
  info: ReleaseInfo;
  kind: ReleaseKind;
  cached: boolean;
  /** Episodes of the requested season found inside the torrent (cached packs only). */
  packEpisodes?: number[];
  /** Seasons covered by the torrent. */
  packSeasons?: number[];
  score: number;
}

export interface Settings {
  torboxApiKey: string;
  moviesDir: string;
  tvDir: string;
  incompleteDir: string;
  extraLibraryDirs: string[];
  sources: {
    torrentio: boolean;
    torrentioUrl: string;
    torboxSearch: boolean;
    addons: string[];
  };
  quality: {
    preferred: Resolution | 'any';
    maxEpisodeGB: number;
    maxMovieGB: number;
    preferCached: boolean;
    allowHdr: boolean;
    allowUpscaled: boolean;
    blockedWords: string[];
  };
  downloads: {
    concurrentFiles: number;
    removeFromTorbox: boolean;
    subtitles: boolean;
    episodeTitles: boolean;
    qualityInName: boolean;
  };
  addon: {
    enabled: boolean;
    token: string;
    name: string;
    publicUrl: string;
  };
  library: {
    rescanMinutes: number;
  };
  passwordSet: boolean;
}

export type SettingsPatch = Partial<Omit<Settings, 'passwordSet' | 'sources' | 'quality' | 'downloads' | 'addon' | 'library'>> & {
  sources?: Partial<Settings['sources']>;
  quality?: Partial<Settings['quality']>;
  downloads?: Partial<Settings['downloads']>;
  addon?: Partial<Settings['addon']>;
  library?: Partial<Settings['library']>;
  password?: string;
};

export interface TorboxAccount {
  ok: boolean;
  email?: string;
  plan?: string;
  expires?: string | null;
  error?: string;
}

export interface Status {
  version: string;
  authRequired: boolean;
  authenticated: boolean;
  setupComplete: boolean;
  torboxConfigured: boolean;
  activeDownloads: number;
  libraryCounts: { movies: number; series: number; episodes: number };
  desktop: boolean;
}

export interface MetaPreview {
  id: string;
  type: MediaType;
  name: string;
  poster?: string;
  background?: string;
  logo?: string;
  releaseInfo?: string;
  imdbRating?: string;
  description?: string;
  genres?: string[];
  inLibrary?: boolean;
}

export interface Episode {
  id: string;
  season: number;
  episode: number;
  title: string;
  overview?: string;
  thumbnail?: string;
  released?: string;
  owned?: boolean;
}

export interface Meta extends MetaPreview {
  year?: number;
  runtime?: string;
  cast?: string[];
  director?: string[];
  status?: string;
  trailer?: string;
  episodes: Episode[];
  seasons: number[];
  ownedMovie?: boolean;
}

export interface HomeRow {
  id: string;
  title: string;
  type: MediaType;
  items: MetaPreview[];
}

export type JobStatus = 'queued' | 'torbox' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface JobFile {
  key: string;
  torboxFileId: number;
  name: string;
  size: number;
  season?: number;
  episode?: number;
  episodeEnd?: number;
  target: string;
  kind: 'video' | 'subtitle';
  downloaded: number;
  status: 'pending' | 'downloading' | 'done' | 'failed' | 'skipped';
  attempts: number;
  retryAt?: number;
  error?: string;
}

export interface Job {
  id: string;
  type: MediaType;
  imdbId: string;
  title: string;
  year?: number;
  poster?: string;
  background?: string;
  label: string;
  season?: number;
  episodes?: number[];
  episodeTitles?: Record<string, string>;
  release: Pick<Release, 'hash' | 'name' | 'kind' | 'cached' | 'info' | 'fileSize' | 'totalSize' | 'origin'>;
  status: JobStatus;
  resumeTo?: JobStatus;
  note?: string;
  torbox: {
    id?: number;
    queuedId?: number;
    state?: string;
    progress?: number;
    speed?: number;
    eta?: number;
    createdByHaul?: boolean;
  };
  files: JobFile[];
  speed: number;
  error?: string;
  groupId?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  nextAttemptAt?: number;
}

export interface SeasonPlanItem {
  episodes: number[];
  release: Release;
}

export interface SeasonPlan {
  imdbId: string;
  season: number;
  items: SeasonPlanItem[];
  missing: number[];
  skipped: number[];
  totalSize: number;
  cachedCount: number;
}

export interface LibraryFile {
  id: string;
  path: string;
  relative: string;
  size: number;
  mtime: number;
  addedAt: number;
  season?: number;
  episode?: number;
  episodeEnd?: number;
  resolution?: Resolution;
  tags: string[];
  subtitles: { lang: string; path: string }[];
}

export interface LibraryItem {
  id: string;
  key: string;
  type: MediaType;
  imdbId?: string;
  matchSource?: 'haul' | 'folder' | 'search' | 'manual';
  title: string;
  year?: number;
  poster?: string;
  background?: string;
  folder: string;
  addedAt: number;
  files: LibraryFile[];
}

export interface LibrarySummary {
  id: string;
  type: MediaType;
  imdbId?: string;
  title: string;
  year?: number;
  poster?: string;
  background?: string;
  folder: string;
  addedAt: number;
  fileCount: number;
  size: number;
  seasons: number[];
  matched: boolean;
}

export interface AddonInfo {
  enabled: boolean;
  manifestUrl: string;
  stremioUrl: string;
  baseUrlSource: 'setting' | 'request';
}
