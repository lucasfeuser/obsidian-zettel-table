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

/** Filter comparison operators */
export type FilterOperator =
  | 'contains'
  | 'not_contains'
  | 'equals'
  | 'not_equals'
  | 'is_empty'
  | 'is_not_empty';

/** A single filter rule in a view */
export interface FilterRule {
  /** Frontmatter key or '_title' */
  column: string;
  operator: FilterOperator;
  /** Empty string for is_empty / is_not_empty */
  value: string;
}

/** A named saved view — its own filter set, column layout, sort, and page size */
export interface ViewConfig {
  name: string;
  filters: FilterRule[];
  columns: Record<string, ColumnConfig>;
  sort: SortConfig | null;
  /** null = inherit the folder-level pageSize */
  pageSize: number | null;
}

/**
 * Per-folder table configuration stored in data.json.
 *
 * v2 layout: folders have a `views` array.
 * v1 (legacy) layout had `columns`, `sort`, `pageSize` at the top level.
 * The migration helper below converts v1 → v2 on first load.
 */
export interface FolderConfig {
  views: ViewConfig[];
  activeViewIndex: number;
  /** Folder-level default page size used when a view's pageSize is null */
  pageSize: number;
}

/** Create a blank default view */
export function createDefaultView(name: string, pageSize: number): ViewConfig {
  return {
    name,
    filters: [],
    columns: {},
    sort: null,
    pageSize,
  };
}

/**
 * One-shot migration from v1 FolderConfig (columns/sort/pageSize at top level)
 * to v2 FolderConfig (views array). Safe to call on already-migrated configs.
 */
export function migrateToViews(
  raw: unknown,
  defaultViewName: string,
  defaultPageSize: number
): FolderConfig {
  const obj = (raw ?? {}) as Record<string, unknown>;

  // Already v2 — has a views array
  if (Array.isArray(obj.views)) {
    return raw as FolderConfig;
  }

  // v1 — wrap existing state into the first view
  const pageSize = (typeof obj.pageSize === 'number' ? obj.pageSize : defaultPageSize);
  return {
    views: [
      {
        name: defaultViewName,
        filters: [],
        columns: (obj.columns ?? {}) as Record<string, ColumnConfig>,
        sort: (obj.sort ?? null) as SortConfig | null,
        pageSize: null, // inherit folder default
      },
    ],
    activeViewIndex: 0,
    pageSize,
  };
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
