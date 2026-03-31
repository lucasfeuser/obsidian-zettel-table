import { ItemView, Menu, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { DataLayer } from './data';
import {
  ZettelTableSettings,
  FolderConfig,
  ColumnConfig,
  SortConfig,
  ThemeMode,
} from './types';
import { sortNotes, paginate, getVisibleColumns, cycleSort } from './engine';
import { renderTitleCell, renderCell, RenderCallbacks } from './renderers';
import { attachResizeHandle } from './resize';

export const VIEW_TYPE_ZETTEL_TABLE = 'zettel-table-view';

/**
 * Compute the minimum column width so that `text` wraps to at most 2 lines.
 *
 * Strategy: you can't break inside a word, so the floor is the widest single word.
 * Above that floor, wrapping at half the total line width always fits in 2 lines.
 * Formula: max(longestWordWidth, totalWidth / 2)
 */
function twoLineWidth(text: string, measure: (s: string) => number): number {
  const words = text.trim().split(/\s+/);
  if (words.length === 0) return 0;
  const total = measure(text);
  const longestWord = Math.max(...words.map((w) => measure(w)));
  return Math.max(longestWord, total / 2);
}

/** Humanize a sort config into a readable label */
function humanizeSort(sort: SortConfig | null): string {
  if (!sort) return 'Unsorted';
  const col = sort.column === '_title' ? 'Title' : sort.column
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const dir = sort.direction === 'asc' ? '\u2191' : '\u2193';
  return `${col} ${dir}`;
}

export class ZettelTableView extends ItemView {
  private dataLayer: DataLayer;
  private settings: ZettelTableSettings;
  private saveSettings: () => Promise<void>;

  private currentFolder: string | null = null;
  private currentPage = 1;
  private currentSort: SortConfig | null = null;
  private folderConfig: FolderConfig | undefined;
  private columnDropdownOpen = false;
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private resizeCleanups: Array<() => void> = [];

  // Column drag-and-drop state
  private dragSourceColumn: string | null = null;
  // Map of columnKey → <th> element, rebuilt each render
  private thMap: Map<string, HTMLElement> = new Map();

  constructor(
    leaf: WorkspaceLeaf,
    dataLayer: DataLayer,
    settings: ZettelTableSettings,
    saveSettings: () => Promise<void>
  ) {
    super(leaf);
    this.dataLayer = dataLayer;
    this.settings = settings;
    this.saveSettings = saveSettings;
  }

  getViewType(): string {
    return VIEW_TYPE_ZETTEL_TABLE;
  }

  getDisplayText(): string {
    return 'Zettel table';
  }

  getIcon(): string {
    return 'table';
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass('zettel-table-view');
    this.applyThemeClass();

    this.dataLayer.onChange(() => {
      this.renderView();
    });

    // Restore last folder if saved
    const lastFolder = this.settings.lastFolder;
    if (lastFolder) {
      this.loadFolder(lastFolder);
    } else {
      this.renderEmptyState();
    }
  }

  async onClose(): Promise<void> {
    this.cleanupDropdownListeners();
    this.cleanupResizeListeners();
  }

  refreshSettings(settings: ZettelTableSettings): void {
    this.settings = settings;
    this.applyThemeClass();
    if (this.currentFolder) {
      this.folderConfig = this.settings.folders[this.currentFolder];
    }
    this.renderView();
  }

  applyThemeClass(): void {
    this.containerEl.removeClass('zt-theme-light');
    this.containerEl.removeClass('zt-theme-dark');

    const mode: ThemeMode = this.settings.themeMode;
    if (mode === 'light') {
      this.containerEl.addClass('zt-theme-light');
    } else if (mode === 'dark') {
      this.containerEl.addClass('zt-theme-dark');
    }
  }

  private loadFolder(folderPath: string): void {
    this.currentFolder = folderPath;
    this.currentPage = 1;
    this.folderConfig = this.settings.folders[folderPath];
    this.currentSort = this.folderConfig?.sort ?? null;

    this.dataLayer.loadFolder(folderPath);
    this.settings.lastFolder = folderPath;
    this.saveSettings();
    this.renderView();
  }

  private ensureFolderConfig(): FolderConfig {
    if (!this.currentFolder) {
      return { columns: {}, sort: null, pageSize: this.settings.pageSize };
    }
    if (!this.settings.folders[this.currentFolder]) {
      this.settings.folders[this.currentFolder] = {
        columns: {},
        sort: null,
        pageSize: this.settings.pageSize,
      };
    }
    this.folderConfig = this.settings.folders[this.currentFolder];
    return this.folderConfig;
  }

  /**
   * Measure actual column content to find the ideal width where every value
   * fits in at most 2 lines (or 1 line for fixed-size types like dates).
   *
   * Called lazily on double-click — never at render time.
   */
  private computeAutoWidth(columnKey: string): number {
    const CELL_PADDING = 24;   // 12px left + 12px right
    const PILL_PADDING = 20;   // pill horizontal padding + gap

    // Borrow font metrics from a rendered cell if one exists
    const sampleTd = this.containerEl.querySelector('.zettel-table-td') as HTMLElement | null;
    const font = sampleTd ? getComputedStyle(sampleTd).font : '13px ui-sans-serif, sans-serif';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return 200;
    ctx.font = font;
    const measure = (s: string) => ctx.measureText(s).width;

    // For fixed-format types, pixel measurement is not needed
    const def = this.dataLayer.getColumnDefs().find((d) => d.key === columnKey);
    if (def?.type === 'date') return 120;
    if (def?.type === 'number') return 80;
    if (def?.type === 'boolean') return 80;

    // Start width from the header label so it never clips the column title
    const headerLabel = columnKey === '_title' ? 'Title' : (def?.label ?? columnKey);
    let maxContentWidth = measure(headerLabel);

    const notes = this.dataLayer.getNotes();
    for (const note of notes) {
      if (columnKey === '_title') {
        maxContentWidth = Math.max(maxContentWidth, twoLineWidth(note.displayTitle, measure));
        continue;
      }
      const val = note.values[columnKey];
      if (!val || val.type === 'empty') continue;

      if (val.type === 'text' || val.type === 'status') {
        // Plain text and status badges: 2-line fit
        maxContentWidth = Math.max(maxContentWidth, twoLineWidth(val.value as string, measure));
      } else if (val.type === 'links' || val.type === 'tags') {
        // Each pill is independent — find the widest pill, 2-line fit within that pill
        for (const item of (val.value as string[])) {
          const pillWidth = twoLineWidth(item, measure) + PILL_PADDING;
          maxContentWidth = Math.max(maxContentWidth, pillWidth);
        }
      }
    }

    return Math.max(80, Math.round(maxContentWidth + CELL_PADDING));
  }

  /** Reorder columns: move fromKey to the position of toKey */
  private reorderColumn(fromKey: string, toKey: string): void {
    if (!this.currentFolder) return;
    const fc = this.ensureFolderConfig();
    const columnDefs = this.dataLayer.getColumnDefs();
    const visible = getVisibleColumns(columnDefs, fc);

    const keys = visible.map((c) => c.def.key);
    const fromIdx = keys.indexOf(fromKey);
    const toIdx = keys.indexOf(toKey);
    if (fromIdx === -1 || toIdx === -1) return;

    keys.splice(fromIdx, 1);
    keys.splice(toIdx, 0, fromKey);

    keys.forEach((key, i) => {
      if (!fc.columns[key]) {
        fc.columns[key] = { visible: true, order: i, width: null };
      } else {
        fc.columns[key].order = i;
      }
    });

    this.saveSettings();
    this.renderView();
  }

  // ── Link opening ──────────────────────────────────────────

  /**
   * Find the best existing leaf to open a note in:
   * - Prefers any already-open non-table leaf in the main workspace
   *   (so clicking multiple notes reuses the same pane rather than
   *   stacking up new splits)
   * - Falls back to creating a vertical split if none exists
   */
  private getAdjacentLeaf(): WorkspaceLeaf {
    let target: WorkspaceLeaf | null = null;
    this.app.workspace.iterateRootLeaves((leaf) => {
      if (!target && leaf.view.getViewType() !== VIEW_TYPE_ZETTEL_TABLE) {
        target = leaf;
      }
    });
    return target ?? this.app.workspace.getLeaf('split');
  }

  private openInAdjacentLeaf(file: TFile): void {
    const leaf = this.getAdjacentLeaf();
    leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
  }

  private openLinkInAdjacentLeaf(linktext: string, sourcePath: string): void {
    // Resolve the wikilink to a TFile if possible
    const resolved = this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
    if (resolved) {
      this.openInAdjacentLeaf(resolved);
    } else {
      // Unresolved link (note doesn't exist yet) — let Obsidian handle it
      this.app.workspace.openLinkText(linktext, sourcePath, 'split');
    }
  }

  /** Build the RenderCallbacks object used by every cell renderer */
  private renderCallbacks(): RenderCallbacks {
    return {
      openFile: (file: TFile) => this.openInAdjacentLeaf(file),
      openLink: (linktext: string, sourcePath: string) =>
        this.openLinkInAdjacentLeaf(linktext, sourcePath),
    };
  }

  // ── Render ────────────────────────────────────────────────

  private renderEmptyState(): void {
    const content = this.containerEl.children[1] as HTMLElement;
    content.empty();

    const empty = content.createDiv({ cls: 'zettel-table-toolbar' });
    const btn = empty.createEl('button', {
      cls: 'zettel-table-toolbar-btn',
      text: 'Select folder',
      attr: { 'aria-label': 'Select a folder to view' },
    });
    btn.addEventListener('click', (e) => {
      this.showFolderMenu(btn, e);
    });
  }

  private renderView(): void {
    if (!this.currentFolder) {
      this.renderEmptyState();
      return;
    }

    this.cleanupDropdownListeners();
    this.cleanupResizeListeners();
    this.thMap = new Map();

    const content = this.containerEl.children[1] as HTMLElement;
    content.empty();

    const allNotes = this.dataLayer.getNotes();
    const columnDefs = this.dataLayer.getColumnDefs();
    const visibleColumns = getVisibleColumns(columnDefs, this.folderConfig);
    const sorted = sortNotes(allNotes, this.currentSort);
    const pageSize = this.folderConfig?.pageSize ?? this.settings.pageSize;
    const tableData = paginate(sorted, this.currentPage, pageSize);

    // Toolbar
    this.renderToolbar(content, tableData.totalRows, pageSize);

    // Table container
    const tableContainer = content.createDiv({ cls: 'zettel-table-container' });
    if (this.settings.maxRowHeight !== null && this.settings.maxRowHeight > 0) {
      tableContainer.style.setProperty('--zt-max-row-height', `${this.settings.maxRowHeight}px`);
    }
    const table = tableContainer.createEl('table', { cls: 'zettel-table' });

    // Header
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');

    // Title column — read saved width from folderConfig
    const titleWidth = this.folderConfig?.columns['_title']?.width ?? null;
    this.renderHeaderCell(headerRow, 'Title', '_title', titleWidth);
    for (const col of visibleColumns) {
      this.renderHeaderCell(headerRow, col.def.label, col.def.key, col.config.width);
    }

    // Body
    const tbody = table.createEl('tbody');
    for (const note of tableData.rows) {
      const tr = tbody.createEl('tr');

      // Title cell
      const titleTd = tr.createEl('td', { cls: 'zettel-table-td' });
      this.applyClamping(titleTd);
      renderTitleCell(titleTd, note, this.renderCallbacks());
      this.attachBodyResizeHandle(titleTd, '_title');

      // Property cells
      for (const col of visibleColumns) {
        const td = tr.createEl('td', { cls: 'zettel-table-td' });
        this.applyClamping(td);
        const value = note.values[col.def.key] ?? { type: 'empty' as const };
        renderCell(td, value, note, this.app, this.settings.dateFormat, this.settings.pillColors, this.renderCallbacks());
        this.attachBodyResizeHandle(td, col.def.key);
      }
    }

    // Pagination
    this.renderPagination(content, tableData);
  }

  /** Attach a resize handle to a <td> that drives the corresponding <th> */
  private attachBodyResizeHandle(td: HTMLElement, columnKey: string): void {
    const th = this.thMap.get(columnKey);
    if (!th) return;
    const handle = td.createDiv({ cls: 'zettel-table-resize-handle' });
    const cleanup = attachResizeHandle(handle, th, columnKey, () => this.computeAutoWidth(columnKey), (key, newWidth) => {
      if (!this.currentFolder) return;
      const fc = this.ensureFolderConfig();
      if (!fc.columns[key]) {
        const colIdx = this.dataLayer.getColumnDefs().findIndex((d) => d.key === key);
        fc.columns[key] = { visible: true, order: colIdx >= 0 ? colIdx : 0, width: null };
      }
      fc.columns[key].width = newWidth;
      this.saveSettings();
    });
    this.resizeCleanups.push(cleanup);
  }

  private applyClamping(td: HTMLElement): void {
    if (this.settings.maxRowHeight !== null && this.settings.maxRowHeight > 0) {
      td.addClass('is-clamped');
    }
  }

  private renderToolbar(parent: HTMLElement, totalRows: number, pageSize: number): void {
    const toolbar = parent.createDiv({ cls: 'zettel-table-toolbar' });

    // Left side: folder name, note count, sort indicator
    const left = toolbar.createDiv({ cls: 'zettel-table-toolbar-left' });

    const folderBtn = left.createEl('button', {
      cls: 'zettel-table-folder-name',
      text: this.currentFolder ?? 'Select folder',
      attr: { 'aria-label': 'Change folder' },
    });
    folderBtn.addEventListener('click', (e) => {
      this.showFolderMenu(folderBtn, e);
    });

    left.createSpan({
      cls: 'zettel-table-note-count',
      text: `${totalRows} notes`,
    });

    left.createSpan({
      cls: 'zettel-table-toolbar-btn',
      text: humanizeSort(this.currentSort),
      attr: { 'aria-label': 'Current sort order' },
    });

    // Right side: page size selector, column visibility toggle
    const right = toolbar.createDiv({ cls: 'zettel-table-toolbar-right' });

    const pageSizeBtn = right.createEl('button', {
      cls: 'zettel-table-toolbar-btn',
      text: `${pageSize} per page`,
      attr: { 'aria-label': 'Change page size' },
    });
    pageSizeBtn.addEventListener('click', (e) => {
      this.showPageSizeMenu(pageSizeBtn, e);
    });

    const columnAnchor = right.createDiv({ cls: 'zettel-table-dropdown-anchor' });
    const columnBtn = columnAnchor.createEl('button', {
      cls: 'zettel-table-toolbar-btn',
      text: 'Columns',
      attr: { 'aria-label': 'Toggle column visibility' },
    });
    columnBtn.addEventListener('click', () => {
      if (this.columnDropdownOpen) {
        this.closeColumnDropdown();
      } else {
        this.openColumnDropdown(columnAnchor);
      }
    });
  }

  private renderHeaderCell(
    row: HTMLElement,
    label: string,
    columnKey: string,
    width: number | null
  ): void {
    const th = row.createEl('th', {
      cls: 'zettel-table-th',
      attr: { 'aria-label': `Sort by ${label}` },
    });

    this.thMap.set(columnKey, th);

    if (width !== null) {
      th.style.setProperty('--zt-col-width', `${width}px`);
    }

    const labelSpan = th.createSpan({ text: label });

    // Sort indicator
    if (this.currentSort?.column === columnKey) {
      labelSpan.createSpan({
        cls: 'zettel-table-sort-indicator',
        text: this.currentSort.direction === 'asc' ? '\u2191' : '\u2193',
      });
    }

    // Click to sort (ignore clicks on the resize handle)
    th.addEventListener('click', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.zettel-table-resize-handle')) return;
      this.currentSort = cycleSort(this.currentSort, columnKey);
      if (this.currentFolder) {
        const fc = this.ensureFolderConfig();
        fc.sort = this.currentSort;
        this.saveSettings();
      }
      this.currentPage = 1;
      this.renderView();
    });

    // Drag-and-drop column reorder (title column is fixed, not draggable)
    if (columnKey !== '_title') {
      th.setAttribute('draggable', 'true');

      th.addEventListener('dragstart', (e: DragEvent) => {
        this.dragSourceColumn = columnKey;
        e.dataTransfer?.setData('text/plain', columnKey);
        th.addClass('is-dragging');
      });

      th.addEventListener('dragend', () => {
        this.dragSourceColumn = null;
        th.removeClass('is-dragging');
        // Clear any lingering drag-over indicators
        this.containerEl.querySelectorAll('.zettel-table-th.is-drag-over').forEach((el) => {
          el.removeClass('is-drag-over');
        });
      });
    }

    // All columns are valid drop targets (except title as source)
    th.addEventListener('dragover', (e: DragEvent) => {
      if (!this.dragSourceColumn || this.dragSourceColumn === columnKey || columnKey === '_title') return;
      e.preventDefault();
      th.addClass('is-drag-over');
    });

    th.addEventListener('dragleave', () => {
      th.removeClass('is-drag-over');
    });

    th.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      th.removeClass('is-drag-over');
      if (!this.dragSourceColumn || this.dragSourceColumn === columnKey || columnKey === '_title') return;
      this.reorderColumn(this.dragSourceColumn, columnKey);
    });

    // Resize handle
    const handle = th.createDiv({ cls: 'zettel-table-resize-handle' });
    const cleanup = attachResizeHandle(handle, th, columnKey, () => this.computeAutoWidth(columnKey), (key, newWidth) => {
      if (!this.currentFolder) return;
      const fc = this.ensureFolderConfig();
      if (!fc.columns[key]) {
        const colIdx = this.dataLayer.getColumnDefs().findIndex((d) => d.key === key);
        fc.columns[key] = { visible: true, order: colIdx >= 0 ? colIdx : 0, width: null };
      }
      fc.columns[key].width = newWidth;
      this.saveSettings();
    });
    this.resizeCleanups.push(cleanup);
  }

  private renderPagination(parent: HTMLElement, tableData: ReturnType<typeof paginate>): void {
    const pagination = parent.createDiv({ cls: 'zettel-table-pagination' });

    const start = (tableData.currentPage - 1) * (this.folderConfig?.pageSize ?? this.settings.pageSize) + 1;
    const end = Math.min(
      start + tableData.rows.length - 1,
      tableData.totalRows
    );

    pagination.createSpan({
      cls: 'zettel-table-page-info',
      text: tableData.totalRows > 0
        ? `${start}\u2013${end} of ${tableData.totalRows}`
        : 'No notes',
    });

    const buttons = pagination.createDiv({ cls: 'zettel-table-page-buttons' });

    for (let i = 1; i <= tableData.totalPages; i++) {
      const btn = buttons.createEl('button', {
        cls: 'zettel-table-page-btn',
        text: String(i),
        attr: { 'aria-label': `Go to page ${i}` },
      });
      if (i === tableData.currentPage) {
        btn.addClass('is-active');
      }
      btn.addEventListener('click', () => {
        this.currentPage = i;
        this.renderView();
      });
    }
  }

  private collectFolders(folder: TFolder, depth: number, result: Array<{ folder: TFolder; depth: number }>): void {
    for (const child of folder.children) {
      if (child instanceof TFolder && !child.path.startsWith('.')) {
        result.push({ folder: child, depth });
        this.collectFolders(child, depth + 1, result);
      }
    }
  }

  private showFolderMenu(anchor: HTMLElement, event: Event): void {
    const menu = new Menu();

    const entries: Array<{ folder: TFolder; depth: number }> = [];
    this.collectFolders(this.app.vault.getRoot(), 0, entries);
    entries.sort((a, b) => a.folder.path.localeCompare(b.folder.path));

    for (const { folder, depth } of entries) {
      const indent = '\u00a0\u00a0'.repeat(depth);
      menu.addItem((item) => {
        item.setTitle(`${indent}${folder.name}`)
          .setIcon('folder')
          .onClick(() => {
            this.loadFolder(folder.path);
          });
      });
    }

    if (event instanceof MouseEvent) {
      menu.showAtMouseEvent(event);
    } else {
      const rect = anchor.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom });
    }
  }

  private showPageSizeMenu(anchor: HTMLElement, event: Event): void {
    const menu = new Menu();
    const sizes = [25, 50, 100];

    for (const size of sizes) {
      menu.addItem((item) => {
        item.setTitle(String(size))
          .onClick(() => {
            if (this.currentFolder) {
              const fc = this.ensureFolderConfig();
              fc.pageSize = size;
              this.saveSettings();
            }
            this.currentPage = 1;
            this.renderView();
          });
      });
    }

    if (event instanceof MouseEvent) {
      menu.showAtMouseEvent(event);
    } else {
      const rect = anchor.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom });
    }
  }

  private openColumnDropdown(anchor: HTMLElement): void {
    this.cleanupDropdownListeners();
    this.columnDropdownOpen = true;

    const dropdown = anchor.createDiv({ cls: 'zettel-table-column-dropdown' });
    const columnDefs = this.dataLayer.getColumnDefs();

    for (const def of columnDefs) {
      const config: ColumnConfig = this.folderConfig?.columns[def.key] ?? {
        visible: true,
        order: 0,
        width: null,
      };

      const item = dropdown.createDiv({ cls: 'zettel-table-column-item' });
      const checkbox = item.createEl('input', {
        type: 'checkbox',
        attr: { 'aria-label': `Toggle ${def.label} column` },
      });
      checkbox.checked = config.visible;
      item.createSpan({ text: def.label });

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        this.toggleColumnVisibility(def.key, checkbox.checked);
      });

      checkbox.addEventListener('change', () => {
        this.toggleColumnVisibility(def.key, checkbox.checked);
      });
    }

    // Close on Escape
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closeColumnDropdown();
      }
    };
    document.addEventListener('keydown', this.escapeHandler);

    // Close on click outside
    this.outsideClickHandler = (e: MouseEvent) => {
      if (!anchor.contains(e.target as Node)) {
        this.closeColumnDropdown();
      }
    };
    // Delay to avoid the opening click triggering close
    window.setTimeout(() => {
      if (this.outsideClickHandler) {
        document.addEventListener('click', this.outsideClickHandler);
      }
    }, 0);
  }

  private closeColumnDropdown(): void {
    this.columnDropdownOpen = false;
    this.cleanupDropdownListeners();
    // Remove any existing dropdown elements
    const existing = this.containerEl.querySelectorAll('.zettel-table-column-dropdown');
    existing.forEach((el) => el.remove());
  }

  private cleanupDropdownListeners(): void {
    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler);
      this.escapeHandler = null;
    }
    if (this.outsideClickHandler) {
      document.removeEventListener('click', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }
  }

  private cleanupResizeListeners(): void {
    for (const cleanup of this.resizeCleanups) {
      cleanup();
    }
    this.resizeCleanups = [];
  }

  private toggleColumnVisibility(key: string, visible: boolean): void {
    if (!this.currentFolder) return;
    const fc = this.ensureFolderConfig();
    if (!fc.columns[key]) {
      const colIdx = this.dataLayer.getColumnDefs().findIndex((d) => d.key === key);
      fc.columns[key] = { visible: true, order: colIdx >= 0 ? colIdx : 0, width: null };
    }
    fc.columns[key].visible = visible;
    this.columnDropdownOpen = false;
    this.saveSettings();
    this.renderView();
  }
}
