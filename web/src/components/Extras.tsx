import { Check, Plus, Clapperboard, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useState } from 'react';
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

/** Plays the trailer in a window over the page, in YouTube's privacy-enhanced player. */
export function TrailerButton({ url, title, className = 'btn glass', onOpenChange }: { url?: string; title: string; className?: string; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpenState] = useState(false);
  const setOpen = (value: boolean) => { setOpenState(value); onOpenChange?.(value); };
  const id = youtubeId(url);
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
              <iframe src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1&playsinline=1`} title={`${title} trailer`} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" referrerPolicy="strict-origin-when-cross-origin" />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
