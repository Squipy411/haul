import { BellRing } from 'lucide-react';
import { useState } from 'react';
import type { Follow, ScheduleItem } from '../../../shared/types';
import { api } from '../api';
import { Empty, ErrorNote, Loading, TabBar, Toggle, join } from '../components/ui';
import { Link, ago, pad, useAsync, usePolling, useToast } from '../lib';

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
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (!data.follows.length) return <Empty title="You're not following anything">Open a show or a movie and choose Follow. Haul then tells you as soon as a torrent is out.</Empty>;
  const update = (next: Follow) => setData({ follows: data.follows.map((follow) => (follow.id === next.id ? next : follow)) });
  return (
    <div className="table" style={{ marginTop: 10 }}>
      {data.follows.map((follow) => {
        const hits = Object.values(follow.found);
        const latest = hits.reduce((max, hit) => Math.max(max, hit.foundAt), 0);
        return (
          <div key={follow.id} className="trow follow-row">
            <Link to={`/title/${follow.type}/${follow.imdbId}`} className="ident">
              <div className="poster-thumb">{follow.poster && <img src={follow.poster} alt="" loading="lazy" />}</div>
              <div style={{ minWidth: 0 }}>
                <div className="t1 truncate">{follow.title}</div>
                <div className="t2">{join([follow.type === 'series' ? 'Show' : 'Movie', `following since ${new Date(follow.createdAt).toLocaleDateString()}`, hits.length ? `${hits.length} found, latest ${ago(latest)}` : 'nothing found yet'])}</div>
              </div>
            </Link>
            <label className="row" style={{ gap: 10, cursor: 'pointer' }}>
              <span className="muted hide-sm" style={{ fontSize: 13 }}>Download automatically</span>
              <Toggle checked={follow.autoDownload} onChange={async (value) => update((await api.updateFollow(follow.id, value)).follow)} label={`Download ${follow.title} automatically`} />
            </label>
            <button className="btn ghost sm" onClick={async () => { await api.unfollow(follow.id); setData({ follows: data.follows.filter((item) => item.id !== follow.id) }); toast(`Stopped following ${follow.title}`); }}>Unfollow</button>
          </div>
        );
      })}
    </div>
  );
}

export function Upcoming() {
  const [tab, setTab] = useState<'schedule' | 'following'>('schedule');
  const follows = useAsync(() => api.follows(), [tab]);
  return (
    <div className="canvas">
      <div className="title-row">
        <div>
          <h1>Upcoming</h1>
          <div className="sub">New episodes of shows you follow or own, from last week to the next six weeks. Followed titles are checked for torrents as soon as they air.</div>
        </div>
      </div>
      <TabBar value={tab} onChange={setTab} tabs={[{ value: 'schedule', label: 'Schedule' }, { value: 'following', label: 'Following', count: follows.data?.follows.length }]} />
      {tab === 'schedule' ? <Schedule /> : <Following />}
    </div>
  );
}
