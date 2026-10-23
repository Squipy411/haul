import { BellRing, CalendarPlus } from 'lucide-react';
import { useState } from 'react';
import type { Follow, ScheduleItem } from '../../../shared/types';
import { api } from '../api';
import { FollowSheet, describeWant, isStrict } from '../components/Follow';
import { Empty, ErrorNote, Loading, Sheet, TabBar, Toggle, join } from '../components/ui';
import { Link, ago, copyText, pad, useAsync, usePolling, useToast } from '../lib';

const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

function dayLabel(date: Date): string {
  const today = new Date();
  const diff = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
  const named = date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  if (diff === 0) return `Today · ${named}`;
  if (diff === 1) return `Tomorrow · ${named}`;
  if (diff === -1) return `Yesterday · ${named}`;
  return named;
}

function until(at: number): string {
  const minutes = Math.round((at - Date.now()) / 60_000);
  if (minutes < 60) return `in ${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `in ${days} days`;
}

/** The middle column: what Haul knows or is doing about this episode. */
function Detail({ item }: { item: ScheduleItem }) {
  const at = Date.parse(item.released);
  const age = Date.now() - at;
  switch (item.state) {
    case 'available':
    case 'downloading': return <span className="truncate" title={item.release}>{item.release}</span>;
    case 'upcoming': return <span>{until(at)}{item.followed ? ', then checked every 5 minutes' : ''}</span>;
    case 'searching': return <span>Checked every {age < 86_400_000 ? '5 minutes' : age < 7 * 86_400_000 ? '30 minutes' : '6 hours'}</span>;
    case 'aired': return <span>{item.followed ? 'Came out before you followed' : `Out ${ago(at)}`}</span>;
    case 'owned': return <span>In your library</span>;
  }
}

function State({ item }: { item: ScheduleItem }) {
  const time = new Date(item.released).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  switch (item.state) {
    case 'owned': return <span className="pill positive">In library</span>;
    case 'downloading': return <span className="pill transfer">Downloading</span>;
    case 'available': return <span className="pill positive" title={item.release}>Torrent out</span>;
    case 'searching': return <span className="pill transfer">Looking for a torrent</span>;
    case 'aired': return <span className="pill">Out now</span>;
    case 'upcoming': return <span className="pill">Airs {time}</span>;
  }
}

function Schedule() {
  const { data, error, reload, setData } = useAsync(() => api.schedule(), []);
  usePolling(() => { api.schedule().then(setData, () => undefined); }, 60_000);
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return <Loading text="Building your schedule…" />;
  if (!data.items.length) {
    return <Empty title="Nothing scheduled">Follow a show from its page, or add shows to your library, and their next episodes appear here.</Empty>;
  }
  const groups = new Map<string, { label: string; items: ScheduleItem[] }>();
  for (const item of data.items) {
    const date = new Date(item.released);
    const key = dayKey(date);
    if (!groups.has(key)) groups.set(key, { label: dayLabel(date), items: [] });
    groups.get(key)!.items.push(item);
  }
  return (
    <div>
      {[...groups.values()].map((group) => (
        <section key={group.label}>
          <div className="section-title"><h2>{group.label}</h2><span className="faint num">{group.items.length}</span></div>
          <div className="table">
            {group.items.map((item) => (
              <Link
                key={`${item.imdbId}-${item.season}-${item.episode}`}
                to={`/title/${item.type}/${item.imdbId}${item.season !== undefined ? `?season=${item.season}` : ''}`}
                className="trow sched-row"
              >
                <span className="num muted when">{item.type === 'movie' ? 'Film' : new Date(item.released).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                <div className="ident">
                  <div className="poster-thumb">{item.poster && <img src={item.poster} alt="" loading="lazy" />}</div>
                  <div style={{ minWidth: 0 }}>
                    <div className="t1 truncate">{item.title}{item.followed && <BellRing size={13} style={{ marginLeft: 8, verticalAlign: -1, color: 'var(--muted)' }} aria-label="Following" />}</div>
                    <div className="t2 truncate">{item.type === 'movie' ? 'Movie release' : join([`S${pad(item.season!)}E${pad(item.episode!)}`, item.episodeTitle])}</div>
                  </div>
                </div>
                <span className="detail hide-sm">{(item.state === 'owned') ? null : <Detail item={item} />}</span>
                <State item={item} />
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Following() {
  const toast = useToast();
  const { data, error, reload, setData } = useAsync(() => api.follows(), []);
  const [editing, setEditing] = useState<Follow | null>(null);
  const [adding, setAdding] = useState(false);
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const followLibrary = async () => {
    setAdding(true);
    try {
      const result = await api.followLibrary();
      setData({ follows: result.follows });
      toast(result.added ? `Now following ${result.added} more show${result.added === 1 ? '' : 's'} from your library` : 'You already follow every show in your library');
    } catch (failure) {
      toast((failure as Error).message, 'error');
    } finally {
      setAdding(false);
    }
  };
  const addAll = <button className="btn" onClick={followLibrary} disabled={adding}>{adding && <span className="spinner" />}Follow all my shows</button>;
  if (!data.follows.length) {
    return (
      <Empty title="You're not following anything">
        Open a show or a movie and choose Follow, or follow every show in your library at once. Haul then tells you as soon as a new episode's torrent is out.
        <div style={{ marginTop: 14 }}>{addAll}</div>
      </Empty>
    );
  }
  const update = (next: Follow) => setData({ follows: data.follows.map((follow) => (follow.id === next.id ? next : follow)) });
  return (
    <>
    <div className="toolbar">
      <span className="count">{data.follows.length} followed</span>
      {addAll}
    </div>
    <div className="table">
      {editing && <FollowSheet open onOpenChange={(open) => { if (!open) setEditing(null); }} target={{ type: editing.type, imdbId: editing.imdbId, title: editing.title }} follow={editing} onSaved={(next) => { update(next); toast('Follow updated'); }} />}
      {data.follows.map((follow) => {
        const hits = Object.values(follow.found);
        const latest = hits.reduce((max, hit) => Math.max(max, hit.foundAt), 0);
        return (
          <div key={follow.id} className="trow follow-row">
            <Link to={`/title/${follow.type}/${follow.imdbId}`} className="ident">
              <div className="poster-thumb">{follow.poster && <img src={follow.poster} alt="" loading="lazy" />}</div>
              <div style={{ minWidth: 0 }}>
                <div className="t1 truncate">{follow.title}</div>
                <div className="t2">{join([follow.type === 'series' ? 'Show' : 'Movie', isStrict(follow.want) ? `only ${describeWant(follow.want)}` : 'any version', hits.length ? `${hits.length} found, latest ${ago(latest)}` : 'nothing found yet'])}</div>
              </div>
            </Link>
            <label className="row" style={{ gap: 10, cursor: 'pointer' }}>
              <span className="muted hide-sm" style={{ fontSize: 13 }}>Download automatically</span>
              <span className="muted only-sm" style={{ fontSize: 13 }}>Auto-download</span>
              <Toggle checked={follow.autoDownload} onChange={async (value) => update((await api.updateFollow(follow.id, { autoDownload: value })).follow)} label={`Download ${follow.title} automatically`} />
            </label>
            <button className="btn sm" onClick={() => setEditing(follow)}>Versions</button>
            <button className="btn ghost sm" onClick={async () => { await api.unfollow(follow.id); setData({ follows: data.follows.filter((item) => item.id !== follow.id) }); toast(`Stopped following ${follow.title}`); }}>Unfollow</button>
          </div>
        );
      })}
    </div>
    </>
  );
}

function CalendarSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const toast = useToast();
  const { data, setData } = useAsync(() => (open ? api.calendar() : Promise.resolve(undefined)), [open]);
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Add Upcoming to your calendar"
      description="Your calendar subscribes to this schedule and keeps it up to date: new episodes of everything you follow or own, and followed movies."
    >
      {!data ? <Loading /> : (
        <div className="stack" style={{ gap: 12 }}>
          <div className="panel" style={{ background: 'var(--raised)' }}>
            <b>iPhone, iPad or Mac</b>
            <p className="hint" style={{ margin: '4px 0 12px' }}>Open this page on the device and tap Subscribe. Your phone needs to reach Haul, on your home Wi-Fi or over a VPN such as Tailscale.</p>
            <a className="btn primary" href={data.webcalUrl}><CalendarPlus size={15} />Subscribe</a>
          </div>
          <div className="panel" style={{ background: 'var(--raised)' }}>
            <b>Any other calendar</b>
            <p className="hint" style={{ margin: '4px 0 12px' }}>Add a calendar "from URL" and paste this address. Google Calendar reads it from Google's servers, so it only works if Haul is reachable from the internet.</p>
            <div className="url" title={data.url}>{data.url}</div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn sm" onClick={async () => toast(await copyText(data.url) ? 'Calendar address copied' : 'Copy failed')}>Copy</button>
              <button className="btn sm ghost" onClick={async () => { setData(await api.regenerateCalendar()); toast('New address made. Subscribe again with it.'); }}>Make a new address</button>
            </div>
          </div>
          <p className="hint">Anyone with the address can see your schedule, so keep it to yourself.</p>
        </div>
      )}
    </Sheet>
  );
}

export function Upcoming() {
  const [tab, setTab] = useState<'schedule' | 'following'>('schedule');
  const [calendar, setCalendar] = useState(false);
  const follows = useAsync(() => api.follows(), [tab]);
  return (
    <div className="canvas">
      <div className="title-row">
        <div>
          <h1>Upcoming</h1>
          <div className="sub">New episodes of shows you follow or own, from last week to the next six weeks. Followed titles are checked for torrents as soon as they air.</div>
        </div>
        <button className="btn" onClick={() => setCalendar(true)}><CalendarPlus size={15} />Add to calendar</button>
      </div>
      <CalendarSheet open={calendar} onOpenChange={setCalendar} />
      <TabBar value={tab} onChange={setTab} tabs={[{ value: 'schedule', label: 'Schedule' }, { value: 'following', label: 'Following', count: follows.data?.follows.length }]} />
      {tab === 'schedule' ? <Schedule /> : <Following />}
    </div>
  );
}
