import { App, TFile, TFolder, Component } from 'obsidian';
import { ColumnDef, ColumnType, NoteData, NoteValue } from './types';

/** Humanize a frontmatter key: "related_fragments" → "Related Fragments" */
function humanizeKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Detect if a string is a date or datetime (YYYY-MM-DD or YYYY-MM-DDTHH:mm) */
function isDateString(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  // Match plain date (2025-12-21) or ISO datetime (2025-12-21T14:30 or 2025-12-21T14:30:00)
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(value);
}

/** Detect if a string is a wikilink: [[...]] */
function isWikilink(value: string): boolean {
  return value.startsWith('[[') && value.endsWith(']]');
}

/** Strip [[ and ]] from a wikilink string */
function stripWikilink(value: string): string {
  if (isWikilink(value)) {
    return value.slice(2, -2);
  }
  return value;
}

/** Known status values that get badge treatment */
const STATUS_VALUES = new Set(['active', 'superseded', 'reading', 'processed', 'unprocessed', 'developing']);

/** Normalize a single frontmatter value into a typed NoteValue */
function normalizeValue(key: string, raw: unknown): NoteValue {
  if (raw === null || raw === undefined || raw === '') {
    return { type: 'empty' };
  }

  // Status field detection
  if (key === 'status' && typeof raw === 'string' && STATUS_VALUES.has(raw.toLowerCase())) {
    return { type: 'status', value: raw };
  }

  // Array types
  if (Array.isArray(raw)) {
    if (raw.length === 0) return { type: 'empty' };
    const strings = raw.map((item) => String(item));
    if (strings.some(isWikilink)) {
      return { type: 'links', value: strings.map(stripWikilink) };
    }
    return { type: 'tags', value: strings };
  }

  // Scalar types
  if (typeof raw === 'boolean') {
    return { type: 'boolean', value: raw };
  }
  if (typeof raw === 'number') {
    return { type: 'number', value: raw };
  }
  if (isDateString(raw)) {
    return { type: 'date', value: raw as string };
  }
  if (typeof raw === 'string') {
    return { type: 'text', value: raw };
  }

  return { type: 'text', value: String(raw) };
}

/** Detect the column type from a NoteValue */
function noteValueToColumnType(nv: NoteValue): ColumnType {
  if (nv.type === 'empty') return 'text';
  return nv.type;
}

export class DataLayer extends Component {
  private app: App;
  private notes: Map<string, NoteData> = new Map();
  private columnDefs: ColumnDef[] = [];
  private folderPath: string | null = null;
  private onChangeCallback: (() => void) | null = null;

  constructor(app: App) {
    super();
    this.app = app;
  }

  onChange(callback: () => void): void {
    this.onChangeCallback = callback;
  }

  loadFolder(folderPath: string): void {
    this.folderPath = folderPath;
    this.notes.clear();

    const abstractFile = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(abstractFile instanceof TFolder)) return;

    for (const child of abstractFile.children) {
      if (child instanceof TFile && child.extension === 'md') {
        this.extractNote(child);
      }
    }

    this.rebuildColumnDefs();
  }

  private extractNote(file: TFile): void {
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;

    const values: Record<string, NoteValue> = {};
    if (frontmatter) {
      for (const [key, raw] of Object.entries(frontmatter)) {
        if (key === 'position') continue;
        values[key] = normalizeValue(key, raw);
      }
    }

    const displayTitle = frontmatter?.title ?? file.basename;
    this.notes.set(file.path, { file, displayTitle, values });
  }

  private rebuildColumnDefs(): void {
    const typeMap = new Map<string, ColumnType>();

    for (const note of this.notes.values()) {
      for (const [key, nv] of Object.entries(note.values)) {
        if (nv.type === 'empty') continue;
        const existing = typeMap.get(key);
        if (!existing) {
          typeMap.set(key, noteValueToColumnType(nv));
        }
      }
    }

    this.columnDefs = Array.from(typeMap.entries()).map(([key, type]) => ({
      key,
      label: humanizeKey(key),
      type,
    }));
  }

  getNotes(): NoteData[] {
    return Array.from(this.notes.values());
  }

  getColumnDefs(): ColumnDef[] {
    return this.columnDefs;
  }

  getNoteCount(): number {
    return this.notes.size;
  }

  registerEvents(): void {
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        if (!(file instanceof TFile)) return;
        if (!this.folderPath) return;
        const folder = file.parent;
        if (!folder || folder.path !== this.folderPath) return;

        this.extractNote(file);
        this.rebuildColumnDefs();
        this.onChangeCallback?.();
      })
    );

    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        if (!this.folderPath || file.parent?.path !== this.folderPath) return;
        this.extractNote(file);
        this.rebuildColumnDefs();
        this.onChangeCallback?.();
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (!(file instanceof TFile)) return;
        if (this.notes.has(file.path)) {
          this.notes.delete(file.path);
          this.rebuildColumnDefs();
          this.onChangeCallback?.();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        const wasTracked = this.notes.has(oldPath);
        // Remove old path entry
        if (wasTracked) {
          this.notes.delete(oldPath);
        }
        // If file is now in our folder, re-extract it
        if (this.folderPath && file.parent?.path === this.folderPath) {
          this.extractNote(file);
          this.rebuildColumnDefs();
          this.onChangeCallback?.();
        } else if (wasTracked) {
          // File moved out of our folder — rebuild without it
          this.rebuildColumnDefs();
          this.onChangeCallback?.();
        }
      })
    );
  }
}
