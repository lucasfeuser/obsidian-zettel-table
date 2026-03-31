import { TFile } from 'obsidian';

/** The detected type of a frontmatter property */
export type ColumnType = 'title' | 'text' | 'date' | 'number' | 'boolean' | 'links' | 'tags' | 'status';

/** A column definition auto-detected from frontmatter */
export interface ColumnDef {
  /** The frontmatter property key (e.g., "related_fragments") */
  key: string;
  /** Display name (e.g., "Related Fragments") — derived from key */
  label: string;
  /** Detected type */
  type: ColumnType;
}

/** Per-column user overrides, stored in data.json */
export interface ColumnConfig {
  visible: boolean;
  order: number;
  /** null = auto-width, number = manual pixel width */
  width: number | null;
}

/** Sort state */
export interface SortConfig {
  column: string;
  direction: 'asc' | 'desc';
}

/** Per-folder table configuration, stored in data.json */
export interface FolderConfig {
  columns: Record<string, ColumnConfig>;
  sort: SortConfig | null;
  pageSize: number;
}

/** One row of normalized note data */
export interface NoteData {
  /** The TFile reference for opening the note */
  file: TFile;
  /** The note's display title (from frontmatter title or filename) */
  displayTitle: string;
  /** Frontmatter values keyed by property name, already normalized */
  values: Record<string, NoteValue>;
}

/** A normalized frontmatter value with its detected type */
export type NoteValue =
  | { type: 'text'; value: string }
  | { type: 'date'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'links'; value: string[] }
  | { type: 'tags'; value: string[] }
  | { type: 'status'; value: string }
  | { type: 'empty' };

/** Theme mode setting */
export type ThemeMode = 'light' | 'dark' | 'auto';

/** Date format options */
export type DateFormat = 'MMM D, YYYY' | 'YYYY-MM-DD' | 'D MMM YYYY' | 'MM/DD/YYYY';

/** Named color for pills */
export type PillColor = 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'indigo' | 'purple' | 'pink' | 'gray';

/** Plugin settings stored in data.json */
export interface ZettelTableSettings {
  themeMode: ThemeMode;
  pageSize: number;
  maxRowHeight: number | null;
  dateFormat: DateFormat;
  pillColors: Record<string, PillColor>;
  folders: Record<string, FolderConfig>;
  lastFolder: string | null;
}

export const DEFAULT_SETTINGS: ZettelTableSettings = {
  themeMode: 'auto',
  pageSize: 50,
  maxRowHeight: null,
  dateFormat: 'MMM D, YYYY',
  pillColors: {},
  folders: {},
  lastFolder: null,
};

/** Output of the table engine */
export interface TablePage {
  rows: NoteData[];
  totalRows: number;
  currentPage: number;
  totalPages: number;
}
