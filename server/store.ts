import fs from 'node:fs';
import path from 'node:path';

/** A JSON document on disk, written atomically and debounced. */
export class JsonFile<T> {
  data: T;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string, fallback: () => T) {
    this.data = fallback();
    try {
      if (fs.existsSync(file)) this.data = { ...fallback(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (error) {
      const backup = `${file}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(file, backup); } catch { /* nothing to keep */ }
      console.error(`[store] ${path.basename(file)} was unreadable; kept a copy at ${backup}`, error);
    }
  }

  save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 250);
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
