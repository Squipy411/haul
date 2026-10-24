import { Bell, Check, Globe, Image as Picture, Library, Tv, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import type { RemoteView, Settings } from '../../../shared/types';
import { api } from '../api';
import { Link, copyText, useToast } from '../lib';
import { useStatus } from '../shell';
import { AddFilesButton } from './Uploads';

// A first-week checklist on Home: the few things that make Haul worth having, each one press away.
// It goes once everything's done, or when hidden (per browser).

const HIDDEN = 'haul.getReady';
const ADDON_DONE = 'haul.getReady.addon';
const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage blocked */ } };

interface Step { id: string; icon: ReactNode; title: string; detail: string; done: boolean; action: ReactNode }

export function GetReady() {
  const status = useStatus();
  const toast = useToast();
  const [hidden, setHidden] = useState(() => read(HIDDEN) === '1');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [remote, setRemote] = useState<RemoteView | null>(null);
  const [addonDone, setAddonDone] = useState(() => read(ADDON_DONE) === '1');

  useEffect(() => {
    if (hidden) return;
    api.settings().then(setSettings, () => undefined);
    api.remote().then(setRemote, () => undefined);
  }, [hidden]);

  if (hidden || !status || !settings) return null;
  const counts = status.libraryCounts;
  const steps: Step[] = [
    {
      id: 'library',
      icon: <Library size={18} />,
      title: 'Bring in your films and shows',
      detail: 'Download something, drag videos onto Haul, or point it at the folders you already have.',
      done: counts.movies + counts.series > 0,
      action: <><AddFilesButton className="btn sm" /><Link to="/settings#folders" className="btn ghost sm">Folders</Link></>
    },
    {
      id: 'notify',
      icon: <Bell size={18} />,
      title: 'Hear about new episodes on your phone',
      detail: 'Follow a show and Haul tells you the moment a torrent is out, not just when it airs.',
      done: settings.notifications.enabled,
      action: <Link to="/settings#notifications" className="btn sm">Set up</Link>
    },
    {
      id: 'remote',
      icon: <Globe size={18} />,
      title: 'Watch away from home',
      detail: 'A free HTTPS link through Cloudflare. Nothing to change on your router.',
      done: Boolean(remote && remote.mode !== 'off') || Boolean(status.access?.fromInternet),
      action: <Link to="/settings#share" className="btn sm">Get a link</Link>
    },
    {
      id: 'addon',
      icon: <Tv size={18} />,
      title: 'Watch on your TV with Nuvio or Stremio',
      detail: 'Add Haul as an addon and your library shows up there, played from this machine.',
      done: addonDone || !settings.addon.enabled,
      action: (
        <button className="btn sm" onClick={async () => {
          const addon = await api.addon();
          toast(await copyText(addon.manifestUrl) ? 'Addon address copied. Paste it in Nuvio under Settings → Addons.' : addon.manifestUrl);
          write(ADDON_DONE, '1');
          setAddonDone(true);
        }}>Copy the address</button>
      )
    },
    {
      id: 'picture',
      icon: <Picture size={18} />,
      title: 'Pick your profile picture',
      detail: 'A cat, a robot, an astronaut… and a profile for each person in the house.',
      done: Boolean(status.profile?.avatar),
      action: <Link to="/settings#profiles" className="btn sm">Choose</Link>
    }
  ];
  const done = steps.filter((step) => step.done).length;
  if (done === steps.length) return null;

  return (
    <section className="card get-ready" aria-label="Get Haul ready">
      <div className="card-head">
        <div>
          <h2>Get the most out of Haul</h2>
          <p className="muted num" style={{ margin: '2px 0 0', fontSize: 13 }}>{done} of {steps.length} done</p>
        </div>
        <button className="icon-button" aria-label="Hide this list" title="Hide" onClick={() => { write(HIDDEN, '1'); setHidden(true); }}><X size={16} /></button>
      </div>
      <div className="get-ready-bar" aria-hidden="true"><i style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <ol className="get-ready-steps">
        {steps.map((step) => (
          <li key={step.id} className={step.done ? 'done' : ''}>
            <span className="get-ready-icon">{step.done ? <Check size={16} /> : step.icon}</span>
            <span className="get-ready-text"><b>{step.title}</b><span>{step.detail}</span></span>
            {!step.done && <span className="get-ready-action">{step.action}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
