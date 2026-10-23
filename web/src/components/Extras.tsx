import { Check, Clapperboard, ExternalLink, Plus, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import type { MediaType } from '../../../shared/types';
import { api } from '../api';
import { useToast } from '../lib';

/** "My list": save a title to watch later, or take it off again. */
export function ListButton({ item, initial, className = 'btn glass' }: {
  item: { type: MediaType; imdbId: string; title: string; poster?: string; background?: string; releaseInfo?: string };
  initial: boolean;
  className?: string;
}) {
  const toast = useToast();
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    const next = !saved;
    setSaved(next);
    try {
      if (next) await api.addToList(item); else await api.removeFromList(item.type, item.imdbId);
      toast(next ? `${item.title} is on My list` : `${item.title} is off My list`);
    } catch (failure) {
      setSaved(!next);
      toast((failure as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className={className} onClick={toggle} disabled={busy} aria-pressed={saved} title={saved ? 'On My list. Press to remove it.' : 'Save to watch later'}>
      {saved ? <Check size={16} /> : <Plus size={16} />}My list
    </button>
  );
}

/** The YouTube id in a watch or short link. */
export function youtubeId(url?: string): string | undefined {
  return url ? /(?:[?&]v=|youtu\.be\/|\/embed\/)([\w-]{11})/.exec(url)?.[1] : undefined;
}

const YOUTUBE = 'https://www.youtube-nocookie.com';

/** A trailer in YouTube's privacy-enhanced player, set up to tell the page how it's doing. */
export const youtubeEmbed = (id: string, options: string) => `${YOUTUBE}/embed/${id}?${options}&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`;

/**
 * Follows a YouTube player in an iframe: 'playing' once it really is, 'failed' if it can't play here
 * (some trailers can only be watched on YouTube). The player reports its state once told someone listens.
 */
export function useYouTubeState(key: unknown) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<'loading' | 'playing' | 'failed'>('loading');
  useEffect(() => { setState('loading'); }, [key]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== YOUTUBE || event.source !== frame.current?.contentWindow) return;
      let data: { event?: string; info?: unknown } | null = null;
      try { data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
      if (data?.event === 'onError') setState('failed');
      else if (data?.event === 'infoDelivery' && (data.info as { playerState?: number } | null)?.playerState === 1) setState((value) => (value === 'failed' ? value : 'playing'));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  const onLoad = () => frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YOUTUBE);
  return { frame, state, onLoad };
}

/** Plays the trailer in a window over the page, in YouTube's privacy-enhanced player. */
export function TrailerButton({ url, title, className = 'btn glass', onOpenChange }: { url?: string; title: string; className?: string; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpenState] = useState(false);
  const setOpen = (value: boolean) => { setOpenState(value); onOpenChange?.(value); };
  const id = youtubeId(url);
  const player = useYouTubeState(open);
  if (!id) return null;
  return (
    <>
      <button className={className} onClick={() => setOpen(true)}><Clapperboard size={16} />Trailer</button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="overlay trailer-overlay" />
          <Dialog.Content className="trailer-dialog" aria-describedby={undefined}>
            <Dialog.Title className="sr-only">{title} trailer</Dialog.Title>
            <Dialog.Close asChild><button className="player-icon trailer-close" aria-label="Close trailer"><X size={22} /></button></Dialog.Close>
            <div className="trailer-frame">
              {player.state === 'failed' ? (
                <div className="trailer-failed">
                  <p>This trailer can only be played on YouTube.</p>
                  <a className="btn primary" href={`https://www.youtube.com/watch?v=${id}`} target="_blank" rel="noreferrer"><ExternalLink size={15} />Watch on YouTube</a>
                </div>
              ) : (
                <iframe ref={player.frame} onLoad={player.onLoad} src={youtubeEmbed(id, 'autoplay=1&rel=0&modestbranding=1&playsinline=1')} title={`${title} trailer`} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" referrerPolicy="strict-origin-when-cross-origin" />
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
