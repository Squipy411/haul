import type { SettingsService } from './settings.js';

export interface Note {
  title: string;
  message: string;
  /** Path inside Haul to open when the notification is tapped, e.g. /title/series/tt7587890?season=8 */
  path?: string;
  /** 1 (min) to 5 (urgent), ntfy's scale. */
  priority?: number;
  tags?: string[];
}

/** Sends phone notifications through ntfy and, if set, a Discord webhook. */
export class Notifier {
  /** The address people open Haul at, learned from their requests, for tap-through links. */
  baseUrl = '';

  constructor(private readonly settings: SettingsService) {}

  get configured(): boolean {
    const n = this.settings.value.notifications;
    return n.enabled && Boolean((n.ntfyServer && n.ntfyTopic) || n.discordWebhook);
  }

  private link(path?: string): string | undefined {
    const base = this.settings.value.addon.publicUrl || this.baseUrl;
    return path && base ? `${base}${path}` : undefined;
  }

  async send(note: Note): Promise<{ ok: boolean; error?: string }> {
    if (!this.configured) return { ok: false, error: 'Notifications are off. Turn them on in Settings.' };
    const n = this.settings.value.notifications;
    const link = this.link(note.path);
    const errors: string[] = [];
    if (n.ntfyServer && n.ntfyTopic) {
      try {
        // ntfy's JSON publishing keeps titles with any characters intact.
        const response = await fetch(n.ntfyServer, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/json', ...(n.ntfyToken ? { Authorization: `Bearer ${n.ntfyToken}` } : {}) },
          body: JSON.stringify({
            topic: n.ntfyTopic,
            title: note.title,
            message: note.message,
            priority: note.priority ?? 3,
            tags: note.tags ?? [],
            ...(link ? { click: link, actions: [{ action: 'view', label: 'Open Haul', url: link }] } : {})
          })
        });
        if (!response.ok) errors.push(`ntfy answered ${response.status}`);
      } catch (error) {
        errors.push(`ntfy: ${(error as Error).message}`);
      }
    }
    if (n.discordWebhook) {
      try {
        const response = await fetch(n.discordWebhook, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `**${note.title}**\n${note.message}${link ? `\n${link}` : ''}`.slice(0, 1900) })
        });
        if (!response.ok) errors.push(`Discord answered ${response.status}`);
      } catch (error) {
        errors.push(`Discord: ${(error as Error).message}`);
      }
    }
    if (errors.length) console.warn('[notify]', errors.join('; '));
    return errors.length ? { ok: false, error: errors.join('; ') } : { ok: true };
  }
}
