import { Check, ChevronLeft, ListVideo, X, Maximize, Minimize, Pause, PictureInPicture2, Play, RotateCcw, RotateCw, Settings2, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MediaType, PlayCaps, PlaySession, WatchProgress } from '../../../shared/types';
import { api, languages, preparePlay } from '../api';
import { useAsync, useRouter, useToast } from '../lib';
import { usePageTitle } from '../shell';

type HlsInstance = { destroy: () => void; loadSource: (url: string) => void; attachMedia: (media: HTMLMediaElement) => void; on: (event: string, handler: (event: string, data: any) => void) => void; startLoad: (at?: number) => void; recoverMediaError: () => void };

/** What this browser decodes, so the server converts only what it must. */
function detectCaps(): PlayCaps {
  const video = document.createElement('video');
  const can = (type: string) => Boolean((window as any).MediaSource?.isTypeSupported?.(type)) || video.canPlayType(type) === 'probably';
  return {
    hevc: can('video/mp4; codecs="hvc1.1.6.L120.90"'),
    av1: can('video/mp4; codecs="av01.0.08M.08"'),
    ac3: can('audio/mp4; codecs="ac-3"') || can('audio/mp4; codecs="ec-3"')
  };
}

const nativeHls = () => document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '';

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; // taste-skill-ignore: a clock
}

interface Cue { start: number; end: number; text: string }

/** WebVTT cues with markup removed. */
export function parseVtt(text: string): Cue[] {
  const time = (value: string) => {
    const parts = value.trim().replace(',', '.').split(':').map(Number);
    return parts.reduce((total, part) => total * 60 + part, 0);
  };
  const cues: Cue[] = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((line) => line.includes('-->'));
    if (at < 0) continue;
    const [from, to] = lines[at]!.split('-->');
    const body = lines.slice(at + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
    if (body) cues.push({ start: time(from!), end: time(to!.trim().split(/\s+/)[0]!), text: body });
  }
  return cues;
}

/** The show's episodes, in a drawer over the picture: pick one to play it. */
function EpisodesPanel({ session, onPick, onClose }: { session: PlaySession; onPick: (season: number, episode: number) => void; onClose: () => void }) {
  const meta = useAsync(() => api.meta('series', session.imdbId), [session.imdbId]);
  const seen = useAsync(() => api.progressFor('series', session.imdbId).catch(() => ({ items: [] as WatchProgress[] })), [session.imdbId]);
  const [season, setSeason] = useState(session.season ?? 1);
  const seasons = (meta.data?.seasons ?? []).filter((value) => value > 0);
  const episodes = (meta.data?.episodes ?? []).filter((episode) => episode.season === season);
  const progressOf = (episode: number) => seen.data?.items.find((entry) => entry.season === season && entry.episode === episode);
  const current = useRef<HTMLButtonElement>(null);
  useEffect(() => { current.current?.scrollIntoView({ block: 'center' }); }, [meta.data, season]);
  return (
    <aside className="player-panel" aria-label="Episodes" onPointerMove={(event) => event.stopPropagation()}>
      <div className="player-panel-head">
        <b>{session.title}</b>
        <button className="player-icon" onClick={onClose} aria-label="Close episodes"><X size={18} /></button>
      </div>
      {seasons.length > 1 && (
        <div className="chips player-seasons">
          {seasons.map((value) => <button key={value} type="button" className="chip" aria-pressed={value === season} onClick={() => setSeason(value)}>Season {value}</button>)}
        </div>
      )}
      <div className="player-episodes">
        {!meta.data && <div className="player-center"><span className="spinner" /></div>}
        {episodes.map((episode) => {
          const isCurrent = episode.season === session.season && episode.episode === session.episode;
          const out = !episode.released || Date.parse(episode.released) <= Date.now() + 12 * 3600_000;
          const entry = progressOf(episode.episode);
          const pct = entry && entry.duration ? Math.min(100, (entry.position / entry.duration) * 100) : 0;
          return (
            <button key={episode.id} ref={isCurrent ? current : undefined} className={`player-episode ${isCurrent ? 'current' : ''}`} disabled={!out} onClick={() => onPick(episode.season, episode.episode)}>
              <span className="still">{episode.thumbnail && <img src={episode.thumbnail} alt="" loading="lazy" onError={(event) => { (event.target as HTMLImageElement).style.display = 'none'; }} />}{pct > 2 && <i className="watched"><b style={{ width: `${pct}%` }} /></i>}</span>
              <span className="text">
                <b className="truncate">{episode.episode}. {episode.title}</b>
                <span className="truncate">{isCurrent ? 'Playing now' : out ? (pct >= 92 ? 'Watched' : pct > 2 ? 'Started' : '') : `Out ${new Date(episode.released!).toLocaleDateString()}`}</span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

export function Watch({ type, id }: { type: MediaType; id: string }) {
  const { search, navigate, back } = useRouter();
  const season = search.has('s') ? Number(search.get('s')) : undefined;
  const episode = search.has('e') ? Number(search.get('e')) : undefined;
  const source = search.get('src') === 'torbox' ? 'torbox' : undefined;
  const hash = search.get('hash') ?? undefined;
  const [session, setSession] = useState<PlaySession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The title's artwork shows while the stream gets ready, instead of a black screen.
  const meta = useAsync(() => api.meta(type, id).catch(() => null), [type, id]);
  const still = type === 'series' ? meta.data?.episodes.find((entry) => entry.season === season && entry.episode === episode)?.thumbnail ?? meta.data?.background : meta.data?.background;
  // Back to where the player was opened from (a real step back, so the browser's Back doesn't reopen
  // the player); straight to the title page when the player was opened directly.
  const leave = useCallback(() => back(`/title/${type}/${id}${season !== undefined ? `?season=${season}` : ''}`), [back, type, id, season]);

  useEffect(() => {
    let alive = true;
    setSession(null);
    setError(null);
    api.play({ type, imdbId: id, season, episode, source, hash, caps: detectCaps() })
      .then((value) => { if (alive) setSession(value); }, (failure: Error) => { if (alive) setError(failure.message); });
    return () => { alive = false; };
  }, [type, id, season, episode, source, hash, attempt]);

  if (error || !session) {
    return (
      <div className="player waiting">
        {still && !error && <img className="player-still" src={still} alt="" />}
        <div className="player-top visible">
          <button className="player-icon" onClick={leave} aria-label="Back"><ChevronLeft size={24} /></button>
          {meta.data && (
            <div className="player-title">
              <b className="truncate">{meta.data.name}</b>
              {season !== undefined && <span className="truncate">S{String(season).padStart(2, '0')}E{String(episode).padStart(2, '0')}</span>}{/* taste-skill-ignore: episode code */}
            </div>
          )}
        </div>
        <div className="player-message">
          {error ? (
            <>
              <h1>Can't play this</h1>
              <p>{error}</p>
              <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
                <button className="btn primary" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
                {source !== 'torbox' && <button className="btn" onClick={() => navigate(`/watch/${type}/${id}?${new URLSearchParams({ ...(season !== undefined ? { s: String(season), e: String(episode) } : {}), src: 'torbox' })}`, { replace: true })}>Stream from TorBox</button>}
                <button className="btn ghost" onClick={leave}>Back</button>
              </div>
            </>
          ) : (
            <>
              <span className="spinner large" />
              <p>{source === 'torbox' || hash ? 'Asking TorBox for the stream…' : 'Getting it ready…'}</p>
            </>
          )}
        </div>
      </div>
    );
  }
  return <Player key={`${session.key}-${session.stream}`} session={session} onLeave={leave} onFailedLocal={session.kind === 'local' ? () => navigate(`/watch/${type}/${id}?${new URLSearchParams({ ...(season !== undefined ? { s: String(season), e: String(episode) } : {}), src: 'torbox' })}`, { replace: true }) : undefined} />;
}

function Player({ session, onLeave, onFailedLocal }: { session: PlaySession; onLeave: () => void; onFailedLocal?: () => void }) {
  const toast = useToast();
  const { navigate } = useRouter();
  const video = useRef<HTMLVideoElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<HlsInstance | null>(null);
  const [url, setUrl] = useState(session.url);
  const [mode, setMode] = useState(session.mode);
  const [reload, setReload] = useState(0);
  // A converted stream starts where you left off, not at 0 with ffmpeg racing to catch up.
  const [offset, setOffset] = useState(session.mode === 'stream' ? Math.floor(session.resume ?? 0) : 0);
  const [audio, setAudio] = useState(session.audio);
  const [subtitle, setSubtitle] = useState<string | null>(session.chosenSubtitle ?? null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [time, setTime] = useState(session.resume ?? 0);
  const [duration, setDuration] = useState(session.duration ?? 0);
  const [buffered, setBuffered] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [volume, setVolume] = useState(() => { try { return Number(localStorage.getItem('haul.volume') ?? 1); } catch { return 1; } });
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [visible, setVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [panel, setPanel] = useState(false);
  const [slow, setSlow] = useState(false);
  /** Where the bar is being dragged to; the knob follows the finger and the seek happens on release. */
  const [scrub, setScrub] = useState<number | null>(null);
  /** The "10 seconds" bubble after a double tap or an arrow key, adding up while you keep going. */
  const [flash, setFlash] = useState<{ side: 'back' | 'forward'; seconds: number; at: number } | null>(null);
  const pointerKind = useRef('mouse');
  const lastTap = useRef<{ at: number; side: 'back' | 'forward' | null }>({ at: 0, side: null });
  const startAt = useRef(session.resume ?? 0);
  const hideTimer = useRef<number>(0);
  const lastSaved = useRef(0);
  /** Last known position, kept outside the video element so it can be saved after it's gone. */
  const position = useRef(session.resume ?? 0);

  const absolute = useCallback(() => (video.current ? offset + video.current.currentTime : position.current), [offset]);
  usePageTitle(session.subtitle ? `${session.title} ${session.subtitle.split(' · ')[0]}` : session.title);

  // Attach the source: a file, an HLS playlist through hls.js, or the browser's own HLS (Safari).
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let cancelled = false;
    setFailure(null);
    setWaiting(true);
    const seekTo = Math.max(0, startAt.current - offset);
    const resolved = url.replace('{start}', String(offset)).replace('{audio}', String(audio));
    const onLoaded = () => { if (seekTo > 0 && Math.abs(element.currentTime - seekTo) > 1) element.currentTime = seekTo; void element.play().catch(() => setPlaying(false)); };
    element.addEventListener('loadedmetadata', onLoaded, { once: true });
    if (mode === 'direct') {
      element.src = resolved;
    } else {
      // hls.js wherever Media Source exists: browsers' own HLS players are pickier (Chrome's rejects
      // TorBox's segments, which arrive with an odd content type). Older iPhones fall back to Safari's.
      void import('hls.js/light').then(({ default: Hls }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) {
          if (nativeHls()) element.src = resolved;
          else setFailure("This browser can't play streams. Try Chrome, Edge, Firefox or Safari.");
          return;
        }
        // TorBox converts on demand, so the first piece of a fresh stream (or one far into it) can take a
        // while; ffmpeg on a home server too. Give them time rather than failing at hls.js's 10 seconds.
        const patient = {
          default: {
            maxTimeToFirstByteMs: 30_000,
            maxLoadTimeMs: 120_000,
            timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
            errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 }
          }
        };
        // startFragPrefetch fetches the first piece while the player is still being set up.
        const hls = new Hls({ startPosition: seekTo, startFragPrefetch: true, testBandwidth: false, maxBufferLength: 60, backBufferLength: 90, enableWorker: true, fragLoadPolicy: patient, playlistLoadPolicy: patient, manifestLoadPolicy: patient } as any) as unknown as HlsInstance;
        hlsRef.current = hls;
        let recovered = 0;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data?.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recovered < 3) { recovered += 1; hls.startLoad(); return; }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recovered < 3) { recovered += 1; hls.recoverMediaError(); return; }
          setFailure(data.response?.code === 500 || data.response?.code === 502 ? 'The stream stopped. Try again, or pick another version.' : 'The stream stopped loading.');
        });
        hls.loadSource(resolved);
        hls.attachMedia(element);
      });
    }
    return () => {
      cancelled = true;
      element.removeEventListener('loadedmetadata', onLoaded);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      element.removeAttribute('src');
      element.load();
    };
  }, [url, offset, audio, mode, reload]);

  // After a few seconds of waiting, say why.
  useEffect(() => {
    if (!waiting) { setSlow(false); return; }
    const timer = window.setTimeout(() => setSlow(true), 5000);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  // Kept across a new source (a track switch or a restart further on), which resets it.
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.playbackRate = rate;
    const keep = () => { element.playbackRate = rate; };
    element.addEventListener('loadedmetadata', keep);
    return () => element.removeEventListener('loadedmetadata', keep);
  }, [rate, url, offset, audio, mode, reload]);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.volume = volume;
    element.muted = muted;
    try { localStorage.setItem('haul.volume', String(volume)); } catch { /* storage blocked */ }
  }, [volume, muted]);

  // Subtitles from files: parsed here and drawn over the picture, so they follow the true position.
  useEffect(() => {
    const chosen = session.subtitles.find((entry) => entry.id === subtitle);
    if (!chosen?.url) { setCues([]); return; }
    let alive = true;
    fetch(chosen.url, { credentials: 'same-origin' }).then((response) => (response.ok ? response.text() : Promise.reject(new Error()))).then((text) => { if (alive) setCues(parseVtt(text)); }, () => toast("Couldn't load those subtitles", 'error'));
    return () => { alive = false; };
  }, [subtitle, session.subtitles, toast]);

  const save = useCallback((keepalive = false) => {
    const at = position.current;
    if (!duration || at < 5) return;
    lastSaved.current = Date.now();
    void api.saveProgress({
      type: session.type, imdbId: session.imdbId, season: session.season, episode: session.episode,
      title: session.title, episodeTitle: session.subtitle?.split(' · ')[1], poster: session.poster, background: session.background,
      position: at, duration
    }, keepalive);
  }, [duration, session]);

  useEffect(() => {
    const onHide = () => save(true);
    window.addEventListener('pagehide', onHide);
    return () => { window.removeEventListener('pagehide', onHide); save(true); };
  }, [save]);

  const reveal = useCallback(() => {
    setVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => { if (!video.current?.paused && !panelOpen.current && !menuOpen.current) setVisible(false); }, 3000);
  }, []);
  const panelOpen = useRef(false);
  const menuOpen = useRef(false);
  useEffect(() => { panelOpen.current = panel; if (panel) setVisible(true); }, [panel]);

  const playEpisode = useCallback((season: number, episode: number) => {
    save();
    setPanel(false);
    if (season === session.season && episode === session.episode) return;
    navigate(`/watch/series/${session.imdbId}?s=${season}&e=${episode}`, { replace: true });
  }, [navigate, save, session.episode, session.imdbId, session.season]);

  const togglePlay = useCallback(() => {
    const element = video.current;
    if (!element) return;
    if (element.paused) void element.play(); else element.pause();
    reveal();
  }, [reveal]);

  /** Seeks to an absolute time. A converted local stream starts again from there if it hasn't got that far. */
  const seek = useCallback((target: number) => {
    const element = video.current;
    if (!element) return;
    const to = Math.max(0, Math.min(target, (duration || Infinity) - 1));
    if (mode === 'stream') {
      const ready = element.seekable.length ? element.seekable.end(element.seekable.length - 1) : 0;
      if (to >= offset && to <= offset + ready - 2) { element.currentTime = to - offset; }
      else { startAt.current = to; setOffset(Math.floor(to)); }
    } else {
      element.currentTime = to;
    }
    setTime(to);
    reveal();
  }, [duration, offset, mode, reveal]);

  /** TorBox burns the choice into a new stream; the player picks up at the same spot. */
  const rebuildTorbox = useCallback(async (choice: { audio?: number; subtitle?: number | null }) => {
    const resumeAt = absolute();
    try {
      const result = await api.playTracks(session.stream!, choice);
      startAt.current = resumeAt;
      setAudio(result.audio);
      setSubtitle(result.subtitle === null ? null : `tb:${result.subtitle}`);
      setUrl(result.url);
    } catch (failureError) {
      toast((failureError as Error).message, 'error');
    }
  }, [absolute, session.stream, toast]);

  const chooseAudio = useCallback((index: number) => {
    languages.save('audio', session.audios.find((track) => track.index === index)?.language);
    if (session.kind === 'torbox') { void rebuildTorbox({ audio: index }); return; }
    // A file played as it is can't change audio track, so it moves to a stream from this server.
    const resumeAt = absolute();
    startAt.current = resumeAt;
    if (mode === 'direct') { setUrl(`/api/play/local/${session.stream}/{start}/{audio}/playlist.m3u8`); setMode('stream'); }
    setOffset(Math.floor(resumeAt));
    setAudio(index);
  }, [absolute, mode, rebuildTorbox, session.audios, session.kind, session.stream]);

  const chooseSubtitle = useCallback((id: string | null) => {
    const language = id === null ? undefined : session.subtitles.find((track) => track.id === id)?.language;
    if (id === null || language) languages.save('subtitles', language);
    if (session.kind === 'torbox') { void rebuildTorbox({ subtitle: id === null ? null : Number(id.slice(3)) }); return; }
    setSubtitle(id);
  }, [rebuildTorbox, session.kind, session.subtitles]);

  /** C turns subtitles off, or on in your usual language (else the first track). */
  const toggleSubtitles = useCallback(() => {
    if (!session.subtitles.length) return;
    if (subtitle) { chooseSubtitle(null); return; }
    const usual = languages.read().subtitleLanguage;
    chooseSubtitle((session.subtitles.find((track) => usual && track.language === usual) ?? session.subtitles[0]!).id);
  }, [chooseSubtitle, session.subtitles, subtitle]);

  const playNext = useCallback(() => {
    if (!session.next) return;
    save();
    navigate(`/watch/series/${session.imdbId}?s=${session.next.season}&e=${session.next.episode}`, { replace: true });
  }, [navigate, save, session]);

  const skip = useCallback((seconds: number) => {
    seek(absolute() + seconds);
    const side = seconds < 0 ? 'back' : 'forward';
    const now = performance.now();
    setFlash((current) => ({ side, at: now, seconds: current && current.side === side && now - current.at < 900 ? current.seconds + Math.abs(seconds) : Math.abs(seconds) }));
  }, [absolute, seek]);
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 900);
    return () => window.clearTimeout(timer);
  }, [flash]);

  /** A mouse click plays or pauses. A tap shows or hides the controls, and a double tap on either side
   *  skips 10 seconds, as phone video apps do. */
  const onVideoClick = (event: React.MouseEvent<HTMLVideoElement>) => {
    if (pointerKind.current === 'mouse') { togglePlay(); return; }
    const rect = event.currentTarget.getBoundingClientRect();
    const across = (event.clientX - rect.left) / rect.width;
    const side = across < 0.38 ? 'back' : across > 0.62 ? 'forward' : null;
    const now = performance.now();
    const previous = lastTap.current;
    lastTap.current = { at: now, side };
    if (side && previous.side === side && now - previous.at < 350) { skip(side === 'back' ? -10 : 10); return; }
    if (visible && playing) { window.clearTimeout(hideTimer.current); setVisible(false); }
    else reveal();
  };

  // Lock screen, headset and keyboard media keys.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const media = navigator.mediaSession;
    try {
      media.metadata = new MediaMetadata({
        title: session.subtitle ? session.subtitle.split(' · ').slice(1).join(' · ') || session.subtitle : session.title,
        artist: session.subtitle ? `${session.title} · ${session.subtitle.split(' · ')[0]}` : 'Haul',
        artwork: [session.poster, session.background].filter((src): src is string => Boolean(src)).map((src) => ({ src }))
      });
    } catch { /* older browsers */ }
    const actions: [MediaSessionAction, MediaSessionActionHandler | null][] = [
      ['play', () => { void video.current?.play(); }],
      ['pause', () => video.current?.pause()],
      ['seekbackward', (details) => skip(-(details.seekOffset ?? 10))],
      ['seekforward', (details) => skip(details.seekOffset ?? 10)],
      ['seekto', (details) => { if (details.seekTime !== undefined) seek(details.seekTime); }],
      ['nexttrack', session.next ? playNext : null]
    ];
    for (const [action, handler] of actions) { try { media.setActionHandler(action, handler); } catch { /* not supported here */ } }
    return () => {
      for (const [action] of actions) { try { media.setActionHandler(action, null); } catch { /* not supported here */ } }
      media.metadata = null;
    };
  }, [playNext, seek, session, skip]);

  const toggleFullscreen = useCallback(() => {
    const element = shell.current as any;
    const media = video.current as any;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (element?.requestFullscreen) void element.requestFullscreen();
    else if (media?.webkitEnterFullscreen) media.webkitEnterFullscreen();
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Menus keep their keys; a focused button keeps Space and Enter, the volume slider its arrows.
      const target = event.target instanceof HTMLElement ? event.target : null;
      const key = event.key.toLowerCase();
      if (target?.closest('[role="menu"]')) return;
      if (target?.closest('button') && (key === ' ' || key === 'enter')) return;
      if (target?.closest('input') && (key === ' ' || key.startsWith('arrow'))) return;
      const element = video.current;
      if (!element) return;
      const handled = ({
        ' ': togglePlay, k: togglePlay,
        arrowleft: () => skip(-10), j: () => skip(-10),
        arrowright: () => skip(10), l: () => skip(10),
        arrowup: () => { setVolume((value) => Math.min(1, value + 0.1)); setMuted(false); },
        arrowdown: () => setVolume((value) => Math.max(0, value - 0.1)),
        m: () => setMuted((value) => !value),
        c: toggleSubtitles,
        f: toggleFullscreen,
        n: playNext
      } as Record<string, (() => void) | undefined>)[key];
      if (!handled) return;
      event.preventDefault();
      handled();
      reveal();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playNext, reveal, skip, toggleFullscreen, togglePlay, toggleSubtitles]);

  const onTimeUpdate = () => {
    const element = video.current!;
    const now = offset + element.currentTime;
    position.current = now;
    setTime(now);
    if (!session.duration && Number.isFinite(element.duration)) setDuration(offset + element.duration);
    if (element.buffered.length) setBuffered(offset + element.buffered.end(element.buffered.length - 1));
    if (Date.now() - lastSaved.current > 15_000 && !element.paused) save();
  };

  const onEnded = () => {
    save();
    setPlaying(false);
    if (session.next && !upNextDismissed) setCountdown(8);
  };

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) { playNext(); return; }
    const timer = window.setTimeout(() => setCountdown((value) => (value === null ? null : value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown, playNext]);

  const activeCues = useMemo(() => cues.filter((cue) => time >= cue.start && time <= cue.end), [cues, time]);
  const inIntro = session.intro && time >= session.intro.start && time < session.intro.end - 2;
  const nearEnd = session.next && duration > 0 && duration - time < 35 && !upNextDismissed;
  // Have the next episode ready by the time this one ends.
  const nextSoon = Boolean(session.next && duration > 0 && duration - time < 120);
  useEffect(() => {
    if (nextSoon && session.next) preparePlay({ type: 'series', imdbId: session.imdbId, season: session.next.season, episode: session.next.episode }, true);
  }, [nextSoon, session.imdbId, session.next]);
  const progressPct = duration ? Math.min(100, ((scrub ?? time) / duration) * 100) : 0;
  const bufferedPct = duration ? Math.min(100, (buffered / duration) * 100) : 0;
  const onBar = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    return { x: event.clientX - rect.left, time: ratio * duration };
  };
  const sourceLabel = session.kind === 'torbox' ? 'Streaming from TorBox' : session.converting && mode === 'stream' ? 'Your file, converted for this browser' : 'Your file';

  return (
    <div
      ref={shell}
      className={`player ${visible || !playing ? 'show-controls' : 'hide-controls'}`}
      onPointerMove={(event) => { if (event.pointerType === 'mouse') reveal(); }}
      onPointerDown={(event) => { pointerKind.current = event.pointerType; if (event.pointerType !== 'mouse' && event.target !== video.current) reveal(); }}
    >
      <video
        ref={video}
        playsInline
        poster={session.background}
        onClick={onVideoClick}
        onDoubleClick={() => { if (pointerKind.current === 'mouse') toggleFullscreen(); }}
        onPlay={() => { setPlaying(true); reveal(); }}
        onPause={() => { setPlaying(false); setVisible(true); save(); }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onTimeUpdate={onTimeUpdate}
        onProgress={onTimeUpdate}
        onEnded={onEnded}
        onError={() => {
          if (mode === 'direct') setFailure(onFailedLocal ? "This browser can't play this file's format." : 'The video failed to load.');
          else if (!hlsRef.current) setFailure('The video failed to load.');
        }}
      />

      {activeCues.length > 0 && <div className="player-cues">{activeCues.map((cue) => <span key={`${cue.start}-${cue.text}`}>{cue.text}</span>)}</div>}

      {waiting && !failure && (
        <div className="player-center"><span className="spinner large" /></div>
      )}
      {flash && (
        <div key={flash.seconds} className={`player-flash ${flash.side}`} aria-hidden="true">
          {flash.side === 'back' ? <RotateCcw size={22} /> : <RotateCw size={22} />}
          <span className="num">{flash.seconds} seconds</span>
        </div>
      )}
      {waiting && slow && !failure && (
        <div className="player-wait">{session.kind === 'torbox' ? 'TorBox is still preparing the video…' : session.converting ? 'Converting the video on your server…' : 'Still loading…'}</div>
      )}
      {!playing && !waiting && !failure && countdown === null && (
        <button className="player-center player-big" onClick={togglePlay} aria-label="Play"><Play size={40} fill="currentColor" /></button>
      )}

      {failure && (
        <div className="player-message">
          <h1>Playback stopped</h1>
          <p>{failure}</p>
          <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="btn primary" onClick={() => { startAt.current = absolute(); setFailure(null); setReload((value) => value + 1); }}>Try again</button>
            {onFailedLocal && <button className="btn" onClick={onFailedLocal}>Stream from TorBox instead</button>}
          </div>
        </div>
      )}

      <div className="player-top">
        <button className="player-icon" onClick={onLeave} aria-label="Back"><ChevronLeft size={24} /></button>
        <div className="player-title">
          <b className="truncate">{session.title}</b>
          <span className="truncate">{[session.subtitle, sourceLabel].filter(Boolean).join(' · ')}</span>
        </div>
      </div>

      {inIntro && <button className="btn player-skip" onClick={() => seek(session.intro!.end)}>Skip intro</button>}

      {(nearEnd || countdown !== null) && session.next && (
        <div className="player-next">
          <span className="faint">Up next</span>
          <b className="truncate">S{String(session.next.season).padStart(2, '0')}E{String(session.next.episode).padStart(2, '0')} · {session.next.title}</b>{/* taste-skill-ignore: episode code */}
          <div className="row">
            <button className="btn primary sm" onClick={playNext}>{countdown !== null ? `Play in ${countdown}` : 'Play now'}</button>
            <button className="btn ghost sm" onClick={() => { setUpNextDismissed(true); setCountdown(null); }}>Hide</button>
          </div>
        </div>
      )}

      {panel && <EpisodesPanel session={session} onPick={playEpisode} onClose={() => setPanel(false)} />}

      <div className="player-bottom">
        <div
          className={`player-bar${scrub !== null ? ' scrubbing' : ''}`}
          onPointerMove={(event) => {
            const at = onBar(event);
            setHover(at);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) { setScrub(at.time); reveal(); }
          }}
          onPointerLeave={() => { if (scrub === null) setHover(null); }}
          onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); const at = onBar(event); setHover(at); setScrub(at.time); }}
          onPointerUp={(event) => { if (scrub === null) return; const at = onBar(event); setScrub(null); setHover(null); seek(at.time); }}
          onPointerCancel={() => { setScrub(null); setHover(null); }}
          role="slider"
          aria-label="Position"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          aria-valuetext={`${clock(time)} of ${clock(duration)}`}
          tabIndex={0}
        >
          <div className="track"><i className="buffered" style={{ width: `${bufferedPct}%` }} /><i className="played" style={{ width: `${progressPct}%` }} /></div>
          <span className="knob" style={{ left: `${progressPct}%` }} />
          {hover && duration > 0 && <span className="hover-time num" style={{ left: hover.x }}>{clock(hover.time)}</span>}
        </div>
        <div className="player-row">
          <button className="player-icon" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}</button>
          <button className="player-icon hide-xs" onClick={() => seek(absolute() - 10)} aria-label="Back 10 seconds"><RotateCcw size={20} /></button>
          <button className="player-icon hide-xs" onClick={() => seek(absolute() + 10)} aria-label="Forward 10 seconds"><RotateCw size={20} /></button>
          <div className="player-volume hide-xs">
            <button className="player-icon" onClick={() => setMuted((value) => !value)} aria-label={muted ? 'Unmute' : 'Mute'}>{muted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}</button>
            <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={(event) => { setVolume(Number(event.target.value)); setMuted(false); }} aria-label="Volume" />
          </div>
          <span className="player-time num">{clock(time)} <span className="faint">/ {duration ? clock(duration) : '–'}</span></span>
          <span className="grow" />
          {session.next && <button className="player-icon" onClick={playNext} aria-label="Next episode" title="Next episode (N)"><SkipForward size={20} /></button>}
          {session.type === 'series' && <button className="player-icon" onClick={() => setPanel((value) => !value)} aria-label="Episodes" aria-expanded={panel} title="Episodes"><ListVideo size={20} /></button>}
          <DropdownMenu.Root onOpenChange={(open) => { menuOpen.current = open; if (open) setVisible(true); else reveal(); }}>
            <DropdownMenu.Trigger asChild>
              <button className="player-icon" aria-label="Audio, subtitles and speed" title="Audio, subtitles and speed"><Settings2 size={20} /></button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal container={shell.current}>
              <DropdownMenu.Content className="popover player-menu" side="top" align="end" sideOffset={10}>
                <DropdownMenu.Label className="player-menu-label">Speed</DropdownMenu.Label>
                <DropdownMenu.RadioGroup value={String(rate)} onValueChange={(value) => setRate(Number(value))} className="player-speeds">
                  {[0.75, 1, 1.25, 1.5, 2].map((value) => <DropdownMenu.RadioItem key={value} value={String(value)} className="popover-item num" aria-label={value === 1 ? 'Normal speed' : `${value} times speed`}>{value === 1 ? '1×' : `${value}×`}</DropdownMenu.RadioItem>)}
                </DropdownMenu.RadioGroup>
                {session.audios.length > 1 && (
                  <>
                    <DropdownMenu.Label className="player-menu-label">Audio</DropdownMenu.Label>
                    <DropdownMenu.RadioGroup value={String(audio)} onValueChange={(value) => chooseAudio(Number(value))}>
                      {session.audios.map((track) => <DropdownMenu.RadioItem key={track.index} value={String(track.index)} className="popover-item">{track.label}<DropdownMenu.ItemIndicator><Check size={14} /></DropdownMenu.ItemIndicator></DropdownMenu.RadioItem>)}
                    </DropdownMenu.RadioGroup>
                  </>
                )}
                {session.subtitles.length > 0 && (
                  <>
                    <DropdownMenu.Label className="player-menu-label">Subtitles</DropdownMenu.Label>
                    <DropdownMenu.RadioGroup value={subtitle ?? 'off'} onValueChange={(value) => chooseSubtitle(value === 'off' ? null : value)}>
                      <DropdownMenu.RadioItem value="off" className="popover-item">Off<DropdownMenu.ItemIndicator><Check size={14} /></DropdownMenu.ItemIndicator></DropdownMenu.RadioItem>
                      {session.subtitles.map((track) => <DropdownMenu.RadioItem key={track.id} value={track.id} className="popover-item">{track.label}<DropdownMenu.ItemIndicator><Check size={14} /></DropdownMenu.ItemIndicator></DropdownMenu.RadioItem>)}
                    </DropdownMenu.RadioGroup>
                  </>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          {'pictureInPictureEnabled' in document && (document as any).pictureInPictureEnabled && (
            <button className="player-icon hide-xs" onClick={() => { const element = video.current as any; if (document.pictureInPictureElement) void document.exitPictureInPicture(); else void element?.requestPictureInPicture?.(); }} aria-label="Picture in picture"><PictureInPicture2 size={20} /></button>
          )}
          <button className="player-icon" onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}>{fullscreen ? <Minimize size={20} /> : <Maximize size={20} />}</button>
        </div>
      </div>
    </div>
  );
}
