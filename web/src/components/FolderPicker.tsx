import { ChevronRight, Folder, HardDrive } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FolderListing, FolderStatus } from '../../../shared/types';
import { api } from '../api';
import { bytes } from '../lib';
import { Sheet } from './ui';

/** Browse the folders Haul can see and pick one, instead of typing a path. */
export function FolderPicker({ open, onOpenChange, start, title, onPick }: { open: boolean; onOpenChange: (open: boolean) => void; start?: string; title: string; onPick: (path: string) => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const go = async (target: string) => {
    setLoading(true);
    setError(null);
    try { setListing(await api.folders(target)); } catch (failure) { setError((failure as Error).message); } finally { setLoading(false); }
  };
  useEffect(() => { if (open) void go(start ?? '').catch(() => undefined); }, [open, start]);
  const here = listing?.path ?? '';
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description="Folders Haul can see. In Docker that's what's mounted into the container: network shares and USB drives connected in ZimaOS are under /drives."
      footer={(
        <>
          <span className="code-path truncate" title={here}>{here || 'Pick a place to start'}</span>
          <button className="btn primary" disabled={!here} onClick={() => { onPick(here); onOpenChange(false); }}>Use this folder</button>
        </>
      )}
    >
      <div className="folder-crumbs">
        <button className="btn ghost sm" onClick={() => void go('')}><HardDrive size={14} />Places</button>
        {here && here.split(/(?<=[/\\])/).filter(Boolean).map((part, index, parts) => {
          const target = parts.slice(0, index + 1).join('');
          return <span key={target} className="row" style={{ gap: 2 }}><ChevronRight size={14} className="faint" /><button className="btn ghost sm" onClick={() => void go(target)}>{part.replace(/[/\\]$/, '') || part}</button></span>;
        })}
      </div>
      {error && <p className="notice negative">{error}</p>}
      <div className="folder-list" aria-busy={loading}>
        {listing && listing.parent !== null && <button className="folder-row" onClick={() => void go(listing.parent ?? '')}><Folder size={16} />..</button>}
        {listing?.folders.map((folder) => (
          <button key={folder.path} className="folder-row" onClick={() => void go(folder.path)}>{here ? <Folder size={16} /> : <HardDrive size={16} />}<span className="truncate">{folder.name}</span></button>
        ))}
        {listing && !listing.folders.length && <p className="faint" style={{ padding: '10px 12px' }}>{here ? 'No folders in here. Use this one, or go back.' : 'Haul can’t see any of the usual media places. Type the path instead.'}</p>}
      </div>
    </Sheet>
  );
}

const ROLE: Record<FolderStatus['role'], string> = { movies: 'Movies', tv: 'Shows', downloads: 'Downloads in progress', extra: 'Also included' };

/** Each folder Haul uses, whether it's there right now, and the room left on its drive. */
export function FolderHealth({ refreshKey }: { refreshKey: unknown }) {
  const [folders, setFolders] = useState<FolderStatus[] | null>(null);
  useEffect(() => { api.folderStatus().then((result) => setFolders(result.folders), () => setFolders(null)); }, [refreshKey]);
  if (!folders?.length) return null;
  return (
    <div className="folder-health">
      {folders.map((folder) => (
        <div key={`${folder.role}:${folder.path}`} className="folder-health-row">
          <span className={`dot ${folder.reachable ? 'on' : 'off'}`} />
          <span className="truncate"><b>{ROLE[folder.role]}</b> <span className="code-path">{folder.path}</span></span>
          <span className="faint num">{!folder.reachable ? 'Can’t reach it. Is the drive connected?' : folder.notYet ? 'Made when first needed' : folder.free !== undefined ? `${bytes(folder.free)} free` : 'Reachable'}</span>
        </div>
      ))}
    </div>
  );
}
