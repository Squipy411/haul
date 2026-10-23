import type { DebridService } from './types.js';

/** The debrid services Haul works with, in the order they're offered. */
export const SERVICES: DebridService[] = ['torbox', 'realdebrid', 'alldebrid', 'premiumize'];

export const SERVICE_NAMES: Record<DebridService, string> = {
  torbox: 'TorBox',
  realdebrid: 'Real-Debrid',
  alldebrid: 'AllDebrid',
  premiumize: 'Premiumize'
};

/** Where each service shows your API key, and what's worth knowing before picking it. */
export const SERVICE_INFO: Record<DebridService, { keyUrl: string; keyPage: string; note: string }> = {
  torbox: { keyUrl: 'https://torbox.app/settings', keyPage: 'torbox.app/settings', note: 'Converts videos for the browser on its servers, so any device plays them. Says which versions are ready before you pick.' },
  realdebrid: { keyUrl: 'https://real-debrid.com/apitoken', keyPage: 'real-debrid.com/apitoken', note: "Can't say which versions are ready in advance, so Haul tries a few. Videos your browser can't play are converted on this server." },
  alldebrid: { keyUrl: 'https://alldebrid.com/apikeys', keyPage: 'alldebrid.com/apikeys', note: "Can't say which versions are ready in advance, so Haul tries a few. Videos your browser can't play are converted on this server." },
  premiumize: { keyUrl: 'https://www.premiumize.me/account', keyPage: 'premiumize.me/account', note: "Says which versions are ready before you pick. Videos your browser can't play are converted on this server." }
};
