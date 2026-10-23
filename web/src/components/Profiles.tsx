import { Check, Plus, Users } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { type ReactNode, useState } from 'react';
import { PROFILE_AVATARS, PROFILE_COLORS } from '../../../shared/profiles';
import type { Profile } from '../../../shared/types';
import { api } from '../api';
import { useToast } from '../lib';
import { AVATAR_ART } from './avatars';
import { Mark } from './ui';

export function Avatar({ profile, size = 28 }: { profile: Pick<Profile, 'name' | 'color' | 'avatar'>; size?: number }) {
  const art = profile.avatar ? AVATAR_ART[profile.avatar] : undefined;
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.44), background: profile.color }} aria-hidden="true">
      {art ? <svg viewBox="0 0 64 64" width={size} height={size}>{art.art}</svg> : [...profile.name.trim()][0]?.toUpperCase() ?? '?'}
    </span>
  );
}

/** Switching person reloads the page, so everything shown is theirs. */
async function switchTo(id: string): Promise<void> {
  await api.selectProfile(id);
  window.location.reload();
}

/** "Who's watching?": asked once per browser when the house has more than one profile. */
export function ProfilePicker({ profiles }: { profiles: Profile[] }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="gate">
      <div className="profile-picker">
        <div className="wordmark"><Mark size={26} /><span className="lockup"><b>Haul</b><small>Stream &amp; download</small></span></div>
        <h1>Who's watching?</h1>
        <div className="profile-grid">
          {profiles.map((profile) => (
            <button key={profile.id} className="profile-choice" disabled={busy !== null} onClick={async () => {
              setBusy(profile.id);
              try { await switchTo(profile.id); } catch (failure) { toast((failure as Error).message, 'error'); setBusy(null); }
            }}>
              <Avatar profile={profile} size={96} />
              <span>{busy === profile.id ? <span className="spinner" /> : profile.name}</span>
            </button>
          ))}
        </div>
        <p className="faint">Each person gets their own Continue watching, My list and watched episodes. Change profiles in Settings.</p>
      </div>
    </div>
  );
}

/** The current person in the top bar, with everyone else one click away. */
export function ProfileMenu({ profiles, current, onManage, children, side = 'bottom' }: { profiles: Profile[]; current: Profile; onManage: () => void; children?: ReactNode; side?: 'bottom' | 'top' }) {
  const toast = useToast();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        {children ?? <button className="profile-button" aria-label={`Profile: ${current.name}. Switch profile`} title={current.name}><Avatar profile={current} /></button>}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="popover" align={side === 'top' ? 'start' : 'end'} side={side} sideOffset={8}>
          <DropdownMenu.Label className="player-menu-label">{profiles.length > 1 ? 'Switch profile' : 'Profiles'}</DropdownMenu.Label>
          {profiles.map((profile) => (
            <DropdownMenu.Item key={profile.id} className="popover-item" onSelect={() => { if (profile.id !== current.id) switchTo(profile.id).catch((failure: Error) => toast(failure.message, 'error')); }}>
              <span className="row" style={{ gap: 10 }}><Avatar profile={profile} size={22} />{profile.name}</span>
              {profile.id === current.id && <Check size={14} />}
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="popover-sep" />
          <DropdownMenu.Item className="popover-item" onSelect={onManage}>
            <span className="row" style={{ gap: 10 }}>{profiles.length > 1 ? <Users size={16} /> : <Plus size={16} />}{profiles.length > 1 ? 'Pictures and profiles' : 'Pick a picture, add a profile'}</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Settings → Profiles: add people, rename them, pick their colour, remove them. */
export function ProfilesEditor({ profiles, current, onChange }: { profiles: Profile[]; current: Profile | null; onChange: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await action(); if (done) toast(done); onChange(); } catch (failure) { toast((failure as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ gap: 14 }}>
      {profiles.map((profile, index) => (
        <div key={profile.id} className="profile-row">
          <Avatar profile={profile} size={48} />
          <div className="stack" style={{ gap: 8, minWidth: 0 }}>
            <input
              className="input"
              defaultValue={profile.name}
              maxLength={24}
              aria-label={`Name of ${profile.name}`}
              onBlur={(event) => { const value = event.target.value.trim(); if (value && value !== profile.name) void run(() => api.updateProfile(profile.id, { name: value }), 'Profile renamed'); }}
              onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }}
            />
            <div className="swatches" role="radiogroup" aria-label={`Colour for ${profile.name}`}>
              {PROFILE_COLORS.map((color) => (
                <button key={color} type="button" role="radio" aria-checked={profile.color === color} aria-label={color} className="swatch" style={{ background: color }} disabled={busy} onClick={() => void run(() => api.updateProfile(profile.id, { color }))} />
              ))}
            </div>
            <div className="avatar-picker" role="radiogroup" aria-label={`Picture for ${profile.name}`}>
              <button type="button" role="radio" aria-checked={!profile.avatar} aria-label="Initial" className="avatar-option" disabled={busy} onClick={() => void run(() => api.updateProfile(profile.id, { avatar: null }))}>
                <Avatar profile={{ ...profile, avatar: undefined }} size={30} />
              </button>
              {PROFILE_AVATARS.map((avatar) => (
                <button key={avatar} type="button" role="radio" aria-checked={profile.avatar === avatar} aria-label={AVATAR_ART[avatar]?.label ?? avatar} title={AVATAR_ART[avatar]?.label} className="avatar-option" disabled={busy} onClick={() => void run(() => api.updateProfile(profile.id, { avatar }))}>
                  <Avatar profile={{ ...profile, avatar }} size={30} />
                </button>
              ))}
            </div>
          </div>
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            {current?.id === profile.id ? <span className="faint" style={{ fontSize: 13 }}>This browser</span> : <button className="btn sm" disabled={busy} onClick={() => void run(() => switchTo(profile.id))}>Switch</button>}
            {index > 0 && (confirming === profile.id
              ? <button className="btn sm danger" disabled={busy} onClick={() => void run(() => api.removeProfile(profile.id), `${profile.name} removed`)}>Remove, and their watching</button>
              : <button className="btn ghost sm" disabled={busy} onClick={() => setConfirming(profile.id)}>Remove</button>)}
          </div>
        </div>
      ))}
      <form className="row" style={{ gap: 8 }} onSubmit={(event) => { event.preventDefault(); if (name.trim()) void run(async () => {
        await api.addProfile(name.trim());
        // This browser stays who it was, rather than being asked who's watching straight away.
        if (current) await api.selectProfile(current.id);
        setName('');
      }, `${name.trim()} added`); }}>
        <input className="input" placeholder="Name, e.g. Sam" maxLength={24} value={name} onChange={(event) => setName(event.target.value)} aria-label="New profile name" />
        <button className="btn" disabled={busy || !name.trim()}><Plus size={15} />Add profile</button>
      </form>
    </div>
  );
}
