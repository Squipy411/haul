import { Info, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Meta, MetaPreview, WatchProgress } from '../../../shared/types';
import { api } from '../api';
import { Link, useAsync, useRouter } from '../lib';
import { ListButton, useYouTubeState, youtubeEmbed, youtubeId } from './Extras';

// Rest the pointer on a poster and a card opens over it with the trailer playing muted, the way streaming
// sites do. Only with a mouse (phones have no hover), and it can be turned off in Settings.

type Target = { item: MetaPreview; rect: DOMRect };
let show: ((target: Target | null) => void) | null = null;
let openTimer = 0;
let closeTimer = 0;
const OPEN_AFTER_MS = 650;

export const hoverPreviews = {
  enabled(): boolean {
    try { return localStorage.getItem('haul.hoverTrailers') !== '0'; } catch { return true; }
  },
  setEnabled(value: boolean): void {
    try { localStorage.setItem('haul.hoverTrailers', value ? '1' : '0'); } catch { /* storage blocked */ }
  },
  enter(item: MetaPreview, element: HTMLElement): void {
    window.clearTimeout(closeTimer);
    window.clearTimeout(openTimer);
    if (!hoverPreviews.enabled() || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    // The details load while the pointer settles, so the card opens with everything in it.
    void api.meta(item.type, item.id).catch(() => undefined);
    openTimer = window.setTimeout(() => show?.({ item, rect: element.getBoundingClientRect() }), OPEN_AFTER_MS);
  },
  leave(): void {
    window.clearTimeout(openTimer);
    closeTimer = window.setTimeout(() => show?.(null), 180);
  },
  keep(): void {
    window.clearTimeout(closeTimer);
  }
};

/** Where Play goes: the film, or the episode to carry on with (else the first one out). */
function playPath(meta: Meta, progress: WatchProgress[]): string {
  if (meta.type === 'movie') return `/watch/movie/${meta.id}`;
  const aired = meta.episodes.filter((episode) => episode.season > 0 && (!episode.released || Date.parse(episode.released) <= Date.now()))
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  const latest = [...progress].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  let target = aired[0];
  if (latest) {
    const finished = latest.duration > 0 && latest.position / latest.duration >= 0.92;
    const at = aired.findIndex((episode) => episode.season === latest.season && episode.episode === latest.episode);
    target = finished ? aired[at + 1] ?? aired[at] ?? target : aired[at] ?? target;
  }
  return target ? `/watch/series/${meta.id}?s=${target.season}&e=${target.episode}` : `/title/series/${meta.id}`;
}

export function HoverPreviewLayer() {
  const [target, setTarget] = useState<Target | null>(null);

  const { path } = useRouter();
  useEffect(() => { show = setTarget; return () => { show = null; }; }, []);
  // Scrolling or going somewhere closes it.
  useEffect(() => { setTarget(null); }, [path]);
  useEffect(() => {
    if (!target) return;
    const close = () => setTarget(null);
    window.addEventListener('scroll', close, { passive: true, once: true });
    return () => window.removeEventListener('scroll', close);
  }, [target]);
  // The still picture stays until YouTube says the trailer is really playing, and if it can't play here.
  const video = useYouTubeState(target?.item.id);

  const meta = useAsync(() => (target ? api.meta(target.item.type, target.item.id).catch(() => null) : Promise.resolve(null)), [target?.item.type, target?.item.id]);
  const progress = useAsync(() => (target ? api.progressFor(target.item.type, target.item.id).then((result) => result.items, () => [] as WatchProgress[]) : Promise.resolve([] as WatchProgress[])), [target?.item.id]);
  if (!target) return null;

  const { item, rect } = target;
  const details = meta.data && meta.data.id === item.id ? meta.data : null;
  const trailer = youtubeId(details?.trailer);
  const width = Math.min(380, window.innerWidth - 24);
  const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, 12), window.innerWidth - width - 12);
  const top = Math.min(Math.max(rect.top - 24, 12), window.innerHeight - 420);
  const facts = [item.releaseInfo, details?.runtime, (details?.genres ?? item.genres ?? []).slice(0, 2).join(', '), item.imdbRating && `IMDb ${item.imdbRating}`].filter(Boolean).join(' · ');
  const backdrop = details?.background ?? item.background ?? item.poster;

  return createPortal(
    <div className="hover-card" style={{ left, top, width }} onPointerEnter={hoverPreviews.keep} onPointerLeave={hoverPreviews.leave} role="dialog" aria-label={`${item.name} preview`}>
      <Link to={`/title/${item.type}/${item.id}`} className="hover-media" tabIndex={-1}>
        {backdrop && <img src={backdrop} alt="" />}
        {trailer && video.state !== 'failed' && (
          <iframe
            ref={video.frame}
            className={video.state === 'playing' ? 'ready' : ''}
            src={youtubeEmbed(trailer, `autoplay=1&mute=1&controls=0&loop=1&playlist=${trailer}&playsinline=1&rel=0&iv_load_policy=3&disablekb=1&modestbranding=1`)}
            title={`${item.name} trailer`}
            allow="autoplay; encrypted-media"
            referrerPolicy="strict-origin-when-cross-origin"
            tabIndex={-1}
            onLoad={video.onLoad}
          />
        )}
      </Link>
      <div className="hover-body">
        <b className="truncate">{item.name}</b>
        {facts && <span className="hover-facts truncate">{facts}</span>}
        {(details?.description ?? item.description) && <p>{details?.description ?? item.description}</p>}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {details && <Link to={playPath(details, progress.data ?? [])} className="btn primary sm"><Play size={14} fill="currentColor" />Play</Link>}
          {details && <ListButton key={item.id} item={{ type: item.type, imdbId: item.id, title: item.name, poster: item.poster, background: item.background, releaseInfo: item.releaseInfo }} initial={Boolean(details.inList)} className="btn sm" />}
          <Link to={`/title/${item.type}/${item.id}`} className="btn ghost sm"><Info size={14} />More info</Link>
        </div>
      </div>
    </div>,
    document.body
  );
}
