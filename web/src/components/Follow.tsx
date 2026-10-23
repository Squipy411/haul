import { Bell, BellRing, Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Follow, MediaType, VersionFilter } from '../../../shared/types';
import { api } from '../api';
import { useRouter, useToast } from '../lib';
import { Menu, Sheet, Toggle } from './ui';

const EMPTY: VersionFilter = { resolutions: [], sources: [], hdr: [] };

const GROUPS = [
  { key: 'resolutions', label: 'Quality', options: [['2160p', '4K'], ['1080p', '1080p'], ['720p', '720p']] },
  { key: 'sources', label: 'Source', options: [['WEB-DL', 'WEB-DL'], ['WEBRip', 'WEBRip'], ['BluRay', 'BluRay'], ['REMUX', 'Remux']] },
  { key: 'hdr', label: 'HDR', options: [['DV', 'Dolby Vision'], ['HDR', 'HDR10'], ['SDR', 'No HDR']] }
] as const;

export const isStrict = (want?: VersionFilter | null): want is VersionFilter => Boolean(want && (want.resolutions.length || want.sources.length || want.hdr.length));

/** "4K WEB-DL", the same wording the notifications use. */
export function describeWant(want?: VersionFilter | null): string {
  if (!isStrict(want)) return 'Any version';
  const res: Record<string, string> = { '2160p': '4K', '1080p': '1080p', '720p': '720p' };
  const hdr = want.hdr.map((kind) => (kind === 'DV' ? 'Dolby Vision' : kind === 'HDR' ? 'HDR10' : 'no HDR'));
  return [want.resolutions.map((value) => res[value]).join('/'), want.sources.map((value) => (value === 'REMUX' ? 'Remux' : value)).join('/'), hdr.join('/')].filter(Boolean).join(' ');
}

type GroupKey = (typeof GROUPS)[number]['key'];

function VersionChips({ value, onToggle }: { value: VersionFilter; onToggle: (group: GroupKey, option: string) => void }) {
  return (
    <div className="chip-groups">
      {GROUPS.map((group) => {
        const selected = value[group.key] as string[];
        return (
          <div key={group.key} className="chip-group" role="group" aria-label={group.label}>
            <span className="chip-label">{group.label}</span>
            <div className="chips">
              {group.options.map(([option, label]) => {
                const on = selected.includes(option);
                return (
                  <button
                    key={option}
                    type="button"
                    className="chip"
                    aria-pressed={on}
                    onClick={() => onToggle(group.key, option)}
                  >
                    {on && <Check size={13} />}{label}
                  </button>
                );
              })}
              {!selected.length && <span className="chip-any">Any</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export interface FollowTarget { type: MediaType; imdbId: string; title: string }

/** Follow a title, or change an existing follow: which versions count, and whether to download on sight. */
export function FollowSheet({ open, onOpenChange, target, follow, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: FollowTarget;
  follow: Follow | null;
  onSaved: (follow: Follow, notificationsReady?: boolean) => void;
}) {
  const toast = useToast();
  const [want, setWant] = useState<VersionFilter>(follow?.want ?? EMPTY);
  const [auto, setAuto] = useState(follow?.autoDownload ?? false);
  const [busy, setBusy] = useState(false);
  const isSeries = target.type === 'series';
  const strict = isStrict(want);

  useEffect(() => {
    if (open) { setWant(follow?.want ?? EMPTY); setAuto(follow?.autoDownload ?? false); }
  }, [open, follow]);

  const save = async () => {
    setBusy(true);
    try {
      if (follow) onSaved((await api.updateFollow(follow.id, { autoDownload: auto, want: strict ? want : null })).follow);
      else {
        const result = await api.follow(target.type, target.imdbId, auto, strict ? want : undefined);
        onSaved(result.follow, result.notificationsReady);
      }
      onOpenChange(false);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const what = isSeries ? 'each new episode' : 'this movie';
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={follow ? `Following ${target.title}` : `Follow ${target.title}`}
      description={isSeries
        ? 'Haul checks the torrent sources for each new episode from the moment it airs, every 5 minutes on the first day, and notifies your phone as soon as one is out.'
        : 'Haul checks the torrent sources every 20 minutes once the movie is out, and notifies your phone as soon as a version you want appears. Camera recordings are always ignored.'}
      footer={
        <>
          <span className="hint">{isSeries && !follow ? 'Episodes out for more than 3 days are left to you.' : ''}</span>
          <div className="row">
            <button className="btn ghost" onClick={() => onOpenChange(false)}>Cancel</button>
            <button className="btn primary" disabled={busy} onClick={save}>{busy && <span className="spinner" />}{follow ? 'Save' : 'Follow'}</button>
          </div>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <div className="panel" style={{ background: 'var(--raised)' }}>
          <div>
            <b>Which versions</b>
            <p className="hint" style={{ margin: '4px 0 0' }}>Pick only what you'd accept. A row left on Any takes anything. WEB-DL includes scene releases tagged WEB.</p>
          </div>
          <VersionChips
            value={want}
            onToggle={(group, option) => setWant((current) => {
              const list = current[group] as string[];
              return { ...current, [group]: list.includes(option) ? list.filter((item) => item !== option) : [...list, option] };
            })}
          />
          <div className="want-summary">
            {strict
              ? <>Only <b>{describeWant(want)}</b> for {what}. Every other version is ignored, however good.</>
              : <>Any good version counts, ranked by your quality settings.</>}
          </div>
        </div>
        <div className="panel" style={{ background: 'var(--raised)' }}>
          <div className="switch-row">
            <b>{strict ? 'Grab the first match' : `Download ${isSeries ? 'new episodes' : 'it'} automatically`}</b>
            <Toggle checked={auto} onChange={setAuto} label="Download automatically" />
            <small>{strict
              ? `The moment a ${describeWant(want)} version appears, Haul downloads it and tells you.`
              : 'Haul takes the best version that meets your quality settings. If only a lower quality is out, it tells you and waits up to 12 hours for a better one.'}</small>
          </div>
        </div>
      </div>
    </Sheet>
  );
}

/** The Follow button on a title page. */
export function FollowControl({ target, initial }: { target: FollowTarget; initial: Follow | null }) {
  const toast = useToast();
  const { navigate } = useRouter();
  const [follow, setFollow] = useState<Follow | null>(initial);
  const [editing, setEditing] = useState(false);
  const isSeries = target.type === 'series';

  const saved = (next: Follow, notificationsReady?: boolean) => {
    const created = !follow;
    setFollow(next);
    if (!created) { toast('Follow updated'); return; }
    const when = isStrict(next.want) ? `a ${describeWant(next.want)} version` : isSeries ? 'a new episode' : 'it';
    toast(notificationsReady
      ? `Following ${target.title}. You'll get a notification as soon as ${when} is out on torrent.`
      : <span>Following {target.title}. Turn on phone notifications in <a href="/settings" style={{ textDecoration: 'underline' }} onClick={(event) => { event.preventDefault(); navigate('/settings'); }}>Settings</a> to get alerts.</span>);
  };

  const sheet = <FollowSheet open={editing} onOpenChange={setEditing} target={target} follow={follow} onSaved={saved} />;

  if (follow) {
    const parts = [isStrict(follow.want) ? describeWant(follow.want) : '', follow.autoDownload ? 'auto' : ''].filter(Boolean);
    return (
      <>
        <Menu
          label={`Following ${target.title}`}
          trigger={<button className="btn"><BellRing size={15} />Following{parts.length ? ` · ${parts.join(' · ')}` : ''}</button>}
          actions={[
            { label: 'Change versions…', onSelect: () => setEditing(true) },
            { label: follow.autoDownload ? 'Stop downloading automatically' : `Download ${isSeries ? 'new episodes' : 'it'} automatically`, onSelect: async () => setFollow((await api.updateFollow(follow.id, { autoDownload: !follow.autoDownload })).follow) },
            'separator',
            { label: 'Unfollow', danger: true, onSelect: async () => { await api.unfollow(follow.id); setFollow(null); toast(`Stopped following ${target.title}`); } }
          ]}
        />
        {sheet}
      </>
    );
  }

  return (
    <>
      <button className="btn" onClick={() => setEditing(true)}><Bell size={15} />Follow</button>
      {sheet}
    </>
  );
}
