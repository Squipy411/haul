import { Check, FilePlus2, Upload as UploadIcon, X } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import type { MediaType, UploadAdded } from '../../../shared/types';
import { api } from '../api';
import { Link, bytes, speed, useRouter } from '../lib';

// Videos dragged onto Haul (or picked with Add files) go up one at a time, in pieces sized to the
// connection: small to start, larger on a fast home network, never past what a proxy will take.

const VIDEO = /\.(mkv|mp4|m4v|avi|mov|ts|m2ts|wmv|webm|mpg|mpeg)$/i;
const MB = 1024 * 1024;
const FIRST_PIECE = 8 * MB;
const MAX_PIECE = 64 * MB;

export type UploadTarget = { type: MediaType; imdbId: string };

interface Item {
  key: number;
  file: File;
  target?: UploadTarget;
  sent: number;
  rate: number;
  state: 'waiting' | 'sending' | 'filing' | 'done' | 'failed' | 'cancelled';
  error?: string;
  added?: UploadAdded;
  id?: string;
  xhr?: XMLHttpRequest;
}

let items: Item[] = [];
let nextKey = 1;
let running = false;
const listeners = new Set<() => void>();
const changed = () => { items = [...items]; for (const listener of listeners) listener(); };
const update = (item: Item, change: Partial<Item>) => { Object.assign(item, change); changed(); };

function sendPiece(item: Item, offset: number, piece: Blob): Promise<{ status: number; data: { received?: number; resumeFrom?: number; error?: string } }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    const startedAt = performance.now();
    xhr.open('PUT', `/api/uploads/${item.id}?offset=${offset}`);
    xhr.setRequestHeader('X-Haul-Request', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      const seconds = (performance.now() - startedAt) / 1000;
      update(item, { sent: offset + event.loaded, rate: seconds > 0.5 ? event.loaded / seconds : item.rate });
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.onabort = () => reject(new Error('cancelled'));
    xhr.send(piece);
  });
}

async function upload(item: Item): Promise<void> {
  update(item, { state: 'sending', sent: 0 });
  const started = await api.startUpload({ name: item.file.name, size: item.file.size, ...item.target });
  item.id = started.id;
  let offset = 0;
  let size = FIRST_PIECE;
  let failures = 0;
  while (offset < item.file.size) {
    if (item.state === 'cancelled') return;
    const start = offset;
    const end = Math.min(item.file.size, start + size);
    const begun = performance.now();
    let answer;
    try {
      answer = await sendPiece(item, start, item.file.slice(start, end));
    } catch (error) {
      if ((error as Error).message === 'cancelled') return;
      answer = { status: 0, data: {} };
    }
    if (answer.status === 200 && answer.data.received !== undefined) {
      offset = answer.data.received;
      failures = 0;
      // Aim for pieces that take about 15 seconds: quick to resend, few requests on a fast network.
      const perSecond = (end - start) / Math.max(0.2, (performance.now() - begun) / 1000);
      size = Math.max(4 * MB, Math.min(MAX_PIECE, Math.round((perSecond * 15) / MB) * MB));
      continue;
    }
    if (answer.status === 409 && answer.data.resumeFrom !== undefined) { offset = answer.data.resumeFrom; continue; }
    if (answer.status >= 400 && answer.status < 500 && answer.status !== 409 && answer.status !== 408) throw new Error(answer.data.error ?? `Haul refused the file (${answer.status}).`);
    // Dropped connection or a server hiccup: wait a little longer each time, then carry on.
    failures += 1;
    if (failures > 6) throw new Error('The connection to Haul keeps dropping. Try again later.');
    size = Math.max(4 * MB, Math.round(size / 2 / MB) * MB);
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** failures));
  }
  update(item, { state: 'filing', sent: item.file.size });
  const added = await api.finishUpload(item.id);
  update(item, { state: 'done', added });
  toast(`${added.title} is in your library`);
  window.dispatchEvent(new Event('haul:refresh-status'));
  window.dispatchEvent(new Event('haul:library-changed'));
}

async function work(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (let item = items.find((each) => each.state === 'waiting'); item; item = items.find((each) => each.state === 'waiting')) {
      try {
        await upload(item);
      } catch (error) {
        if (item.state !== 'cancelled') update(item, { state: 'failed', error: (error as Error).message });
        if (item.id) void api.cancelUpload(item.id).catch(() => undefined);
      }
    }
  } finally {
    running = false;
  }
}

/** Queues videos for the library; anything else is pointed out and left. */
export function addFiles(files: File[], target?: UploadTarget): void {
  const videos = files.filter((file) => VIDEO.test(file.name));
  const others = files.length - videos.length;
  if (others) toast.error(others === 1 && files.length === 1 ? `${files[0]!.name} isn't a video. Haul takes MKV, MP4, AVI, MOV and other video files.` : `${others} of those aren't videos, so they were left out.`);
  if (!videos.length) return;
  for (const file of videos) items.push({ key: nextKey++, file, target, sent: 0, rate: 0, state: 'waiting' });
  changed();
  void work();
}

function cancel(item: Item): void {
  if (item.state === 'done') return;
  const id = item.id;
  update(item, { state: 'cancelled' });
  item.xhr?.abort();
  if (id) void api.cancelUpload(id).catch(() => undefined);
}

function useItems(): Item[] {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => items);
}

/** Opens the file picker for videos to add. */
export function AddFilesButton({ target, className = 'btn' }: { target?: UploadTarget; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className={className} onClick={() => input.current?.click()}><FilePlus2 size={16} />Add files</button>
      <input ref={input} type="file" accept="video/*,.mkv,.avi,.m2ts,.ts,.wmv" multiple hidden onChange={(event) => { addFiles([...(event.target.files ?? [])], target); event.target.value = ''; }} />
    </>
  );
}

/** Drag videos anywhere over Haul. On a title's page they're filed as that title. */
export function DropZone() {
  const { path } = useRouter();
  const [over, setOver] = useState(false);
  const title = /^\/title\/(movie|series)\/(tt\d+)$/.exec(path);
  const target = title ? { type: title[1] as MediaType, imdbId: title[2]! } : undefined;
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes('Files'));
    const enter = (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); depth += 1; setOver(true); };
    const leave = (event: DragEvent) => { if (!hasFiles(event)) return; depth = Math.max(0, depth - 1); if (!depth) setOver(false); };
    const overHandler = (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setOver(false);
      addFiles([...(event.dataTransfer?.files ?? [])], targetRef.current);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overHandler);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overHandler);
      window.removeEventListener('drop', drop);
    };
  }, []);

  if (!over) return null;
  return (
    <div className="drop-zone" aria-hidden="true">
      <div className="drop-card">
        <span className="drop-icon"><UploadIcon size={28} strokeWidth={1.6} /></span>
        <b>{target ? `Drop to add to this ${target.type === 'movie' ? 'film' : 'show'}` : 'Drop to add to your library'}</b>
        <span>
          {!target ? 'Films go to Movies. Episodes go to TV Shows when the name says which one, like S01E04.'
            : target.type === 'movie' ? 'It’s filed under Movies with this film’s name.'
              : 'Each file needs the season and episode in its name, like S01E04.'}
        </span>
      </div>
    </div>
  );
}

/** What's going up, in a small card at the foot of the page. */
export function UploadTray() {
  const list = useItems();
  const [hidden, setHidden] = useState(false);
  const active = list.filter((item) => item.state === 'waiting' || item.state === 'sending' || item.state === 'filing');
  useEffect(() => { if (active.length) setHidden(false); }, [active.length]);
  // Once everything's in, the card steps aside after a moment.
  useEffect(() => {
    if (active.length || !list.length) return;
    const timer = window.setTimeout(() => { items = items.filter((item) => item.state === 'failed'); changed(); }, 8000);
    return () => window.clearTimeout(timer);
  }, [active.length, list.length]);
  if (!list.length || hidden) return null;
  return (
    <section className="upload-tray" aria-label="Adding files">
      <div className="upload-head">
        <b>{active.length ? `Adding ${active.length === 1 ? '1 file' : `${active.length} files`}` : 'Files added'}</b>
        <button className="icon-button" aria-label="Hide" onClick={() => { if (!active.length) { items = []; changed(); } setHidden(true); }}><X size={16} /></button>
      </div>
      <div className="upload-list">
        {list.map((item) => {
          const percent = Math.round((item.sent / item.file.size) * 100);
          return (
            <div key={item.key} className={`upload-row ${item.state}`}>
              <div className="upload-text">
                <span className="truncate" title={item.file.name}>{item.added ? item.added.title : item.file.name}</span>
                <span className="faint truncate num">
                  {item.state === 'waiting' && `Waiting · ${bytes(item.file.size)}`}
                  {item.state === 'sending' && `${percent}% of ${bytes(item.file.size)}${item.rate ? ` · ${speed(item.rate)}` : ''}`}
                  {item.state === 'filing' && 'Putting it in your library…'}
                  {item.state === 'done' && item.added && <>In {item.added.type === 'movie' ? 'Movies' : 'TV Shows'} · <Link to={item.added.imdbId ? `/title/${item.added.type}/${item.added.imdbId}` : '/library'}>Open</Link></>}
                  {item.state === 'failed' && <span className="negative-text">{item.error}</span>}
                  {item.state === 'cancelled' && 'Cancelled'}
                </span>
                {(item.state === 'sending' || item.state === 'filing') && <span className="bar"><i style={{ width: `${percent}%` }} /></span>}
              </div>
              {item.state === 'done' ? <Check size={16} className="upload-done" /> : item.state !== 'cancelled' && item.state !== 'failed' && (
                <button className="icon-button" aria-label={`Stop adding ${item.file.name}`} onClick={() => cancel(item)}><X size={15} /></button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
