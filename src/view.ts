import { ItemView, Menu, Notice, setIcon, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { DataLayer } from './data';
import {
  ZettelTableSettings,
  FolderConfig,
  ViewConfig,
  ColumnConfig,
  FilterRule,
  FilterOperator,
  SortConfig,
  ThemeMode,
  createDefaultView,
  migrateToViews,
} from './types';
import { sortNotes, filterNotes, paginate, getVisibleColumns, cycleSort } from './engine';
import { renderTitleCell, renderCell, RenderCallbacks } from './renderers';
import { attachResizeHandle } from './resize';

export const VIEW_TYPE_ZETTEL_TABLE = 'zettel-table-view';

const FILTER_OPERATOR_LABELS: Record<FilterOperator, string> = {
  contains:     'contains',
  not_contains: 'does not contain',
  equals:       'is',
  not_equals:   'is not',
  is_empty:     'is empty',
  is_not_empty: 'is not empty',
};

/**
 * Compute the minimum column width so that `text` wraps to at most 2 lines.
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

/** Strip leading number prefix from folder name: "1 Fragments" → "Fragments" */
function folderBasename(folderPath: string): string {
  const last = folderPath.split('/').pop() ?? folderPath;
  return last.replace(/^\d+\s+/, '');
}

export class ZettelTableView extends ItemView {
  private dataLayer: DataLayer;
  private settings: ZettelTableSettings;
  private saveSettings: () => Promise<void>;

  private currentFolder: string | null = null;
  private currentPage = 1;
  private folderConfig: FolderConfig | undefined;
  private currentViewIndex = 0;
  private filterPanelOpen = false;

  // Dropdown / overlay state
  private columnDropdownOpen = false;
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private resizeCleanups: Array<() => void> = [];

  // Column drag state (header drag)
  private dragSourceColumn: string | null = null;
  // Map of columnKey → <th>, rebuilt each render
  private thMap: Map<string, HTMLElement> = new Map();
  // Column drag state (dropdown list)
  private dropdownDragSource: string | null = null;

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

  getViewType(): string { return VIEW_TYPE_ZETTEL_TABLE; }
  getDisplayText(): string { return 'Zettel table'; }
  getIcon(): string { return 'table'; }

  async onOpen(): Promise<void> {
    this.containerEl.addClass('zettel-table-view');
    this.applyThemeClass();
    this.dataLayer.onChange(() => this.renderView());

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
    if (mode === 'light') this.containerEl.addClass('zt-theme-light');
    else if (mode === 'dark') this.containerEl.addClass('zt-theme-dark');
  }

  // ── Shortcut to the currently active view ────────────────

  private get cv(): ViewConfig | undefined {
    if (!this.folderConfig?.views?.length) return undefined;
    const idx = Math.min(this.currentViewIndex, this.folderConfig.views.length - 1);
    return this.folderConfig.views[idx];
  }

  // ── Folder loading & config helpers ──────────────────────

  private loadFolder(folderPath: string): void {
    this.currentFolder = folderPath;
    this.currentPage = 1;

    // Migrate v1 → v2 on first load
    const raw = this.settings.folders[folderPath] as unknown;
    const defaultName = 'All ' + folderBasename(folderPath);
    const migrated = migrateToViews(raw, defaultName, this.settings.pageSize);
    this.settings.folders[folderPath] = migrated;
    this.folderConfig = migrated;
    this.currentViewIndex = migrated.activeViewIndex;

    this.dataLayer.loadFolder(folderPath);
    this.settings.lastFolder = folderPath;
    this.saveSettings();
    this.renderView();
  }

  private ensureFolderConfig(): FolderConfig {
    if (!this.currentFolder) {
      // Transient — callers should never mutate this
      return {
        views: [createDefaultView('All', this.settings.pageSize)],
        activeViewIndex: 0,
        pageSize: this.settings.pageSize,
      };
    }
    if (!this.settings.folders[this.currentFolder]) {
      const defaultName = 'All ' + folderBasename(this.currentFolder);
      this.settings.folders[this.currentFolder] = {
        views: [createDefaultView(defaultName, this.settings.pageSize)],
        activeViewIndex: 0,
        pageSize: this.settings.pageSize,
      };
    }
    this.folderConfig = this.settings.folders[this.currentFolder];
    return this.folderConfig;
  }

  private ensureCurrentView(): ViewConfig {
    const fc = this.ensureFolderConfig();
    if (!fc.views[this.currentViewIndex]) {
      this.currentViewIndex = 0;
    }
    if (!fc.views[this.currentViewIndex]) {
      const defaultName = 'All ' + folderBasename(this.currentFolder ?? '');
      fc.views.push(createDefaultView(defaultName, this.settings.pageSize));
      this.currentViewIndex = 0;
    }
    return fc.views[this.currentViewIndex];
  }

  // ── View management ───────────────────────────────────────

  private switchView(index: number): void {
    const fc = this.ensureFolderConfig();
    this.currentViewIndex = Math.min(index, fc.views.length - 1);
    fc.activeViewIndex = this.currentViewIndex;
    this.currentPage = 1;
    this.saveSettings();
    this.renderView();
  }

  private createView(): void {
    const fc = this.ensureFolderConfig();
    const idx = fc.views.length + 1;
    const newView = createDefaultView(`View ${idx}`, this.settings.pageSize);
    fc.views.push(newView);
    this.currentViewIndex = fc.views.length - 1;
    fc.activeViewIndex = this.currentViewIndex;
    this.currentPage = 1;
    this.saveSettings();
    this.renderView();
    // After render, start inline rename on the new tab
    window.setTimeout(() => {
      const tabs = this.containerEl.querySelectorAll('.zettel-table-view-tab');
      const newTab = tabs[this.currentViewIndex] as HTMLElement | undefined;
      const nameEl = newTab?.querySelector('.zettel-table-tab-name') as HTMLElement | undefined;
      if (nameEl) this.startInlineRename(nameEl, this.currentViewIndex);
    }, 50);
  }

  private deleteView(index: number): void {
    const fc = this.ensureFolderConfig();
    if (fc.views.length <= 1) {
      new Notice('Cannot delete the last view.');
      return;
    }
    fc.views.splice(index, 1);
    this.currentViewIndex = Math.max(0, Math.min(this.currentViewIndex, fc.views.length - 1));
    fc.activeViewIndex = this.currentViewIndex;
    this.currentPage = 1;
    this.saveSettings();
    this.renderView();
  }

  private renameView(index: number, name: string): void {
    const fc = this.ensureFolderConfig();
    if (!fc.views[index]) return;
    fc.views[index].name = name.trim() || fc.views[index].name;
    this.saveSettings();
    // Update just the tab text rather than a full re-render
    const tabs = this.containerEl.querySelectorAll('.zettel-table-view-tab');
    const nameEl = tabs[index]?.querySelector('.zettel-table-tab-name') as HTMLElement | undefined;
    if (nameEl) nameEl.textContent = fc.views[index].name;
  }

  private startInlineRename(nameEl: HTMLElement, viewIndex: number): void {
    const original = nameEl.textContent ?? '';
    nameEl.contentEditable = 'true';
    nameEl.focus();
    // Select all text
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const commit = () => {
      nameEl.contentEditable = 'false';
      this.renameView(viewIndex, nameEl.textContent ?? original);
    };
    const cancel = () => {
      nameEl.contentEditable = 'false';
      nameEl.textContent = original;
    };

    nameEl.addEventListener('blur', commit, { once: true });
    nameEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
      if (e.key === 'Escape') { nameEl.removeEventListener('blur', commit); cancel(); }
    }, { once: true });
  }

  // ── Filter management ─────────────────────────────────────

  private addFilterRule(): void {
    const view = this.ensureCurrentView();
    const columnDefs = this.dataLayer.getColumnDefs();
    const defaultCol = columnDefs[0]?.key ?? '_title';
    view.filters.push({ column: defaultCol, operator: 'contains', value: '' });
    this.currentPage = 1;
    this.saveSettings();
    this.renderView();
  }

  private removeFilterRule(ruleIndex: number): void {
    const view = this.ensureCurrentView();
    view.filters.splice(ruleIndex, 1);
    this.currentPage = 1;
    this.saveSettings();
    this.renderView();
  }

  private updateFilterRule(ruleIndex: number, changes: Partial<FilterRule>): void {
    const view = this.ensureCurrentView();
    if (!view.filters[ruleIndex]) return;
    Object.assign(view.filters[ruleIndex], changes);
    this.currentPage = 1;
    this.saveSettings();
    this.renderView();
  }

  // ── Column helpers ────────────────────────────────────────

  private computeAutoWidth(columnKey: string): number {
    const CELL_PADDING = 24;
    const PILL_PADDING = 20;

    const sampleTd = this.containerEl.querySelector('.zettel-table-td') as HTMLElement | null;
    const font = sampleTd ? getComputedStyle(sampleTd).font : '13px ui-sans-serif, sans-serif';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return 200;
    ctx.font = font;
    const measure = (s: string) => ctx.measureText(s).width;

    const def = this.dataLayer.getColumnDefs().find((d) => d.key === columnKey);
    if (def?.type === 'date') return 120;
    if (def?.type === 'number') return 80;
    if (def?.type === 'boolean') return 80;

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
        maxContentWidth = Math.max(maxContentWidth, twoLineWidth(val.value as string, measure));
      } else if (val.type === 'links' || val.type === 'tags') {
        for (const item of (val.value as string[])) {
          maxContentWidth = Math.max(maxContentWidth, twoLineWidth(item, measure) + PILL_PADDING);
        }
      }
    }
    return Math.max(80, Math.round(maxContentWidth + CELL_PADDING));
  }

  private reorderColumn(fromKey: string, toKey: string): void {
    const view = this.ensureCurrentView();
    const columnDefs = this.dataLayer.getColumnDefs();
    const visible = getVisibleColumns(columnDefs, view);
    const keys = visible.map((c) => c.def.key);
    const fromIdx = keys.indexOf(fromKey);
    const toIdx = keys.indexOf(toKey);
    if (fromIdx === -1 || toIdx === -1) return;
    keys.splice(fromIdx, 1);
    keys.splice(toIdx, 0, fromKey);
    keys.forEach((key, i) => {
      if (!view.columns[key]) {
        const colIdx = columnDefs.findIndex((d) => d.key === key);
        view.columns[key] = { visible: true, order: colIdx >= 0 ? colIdx : i, width: null };
      } else {
        view.columns[key].order = i;
      }
    });
    this.saveSettings();
    this.renderView();
  }

  private toggleColumnVisibility(key: string, visible: boolean): void {
    const view = this.ensureCurrentView();
    const columnDefs = this.dataLayer.getColumnDefs();
    if (!view.columns[key]) {
      const colIdx = columnDefs.findIndex((d) => d.key === key);
      view.columns[key] = { visible: true, order: colIdx >= 0 ? colIdx : 0, width: null };
    }
    view.columns[key].visible = visible;
    this.columnDropdownOpen = false;
    this.saveSettings();
    this.renderView();
  }

  // ── Link opening ──────────────────────────────────────────

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
    const resolved = this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
    if (resolved) {
      this.openInAdjacentLeaf(resolved);
    } else {
      this.app.workspace.openLinkText(linktext, sourcePath, 'split');
    }
  }

  private renderCallbacks(): RenderCallbacks {
    return {
      openFile: (file: TFile) => this.openInAdjacentLeaf(file),
      openLink: (linktext: string, sourcePath: string) =>
        this.openLinkInAdjacentLeaf(linktext, sourcePath),
    };
  }

  // ── Rendering ─────────────────────────────────────────────

  private renderEmptyState(): void {
    const content = this.containerEl.children[1] as HTMLElement;
    content.empty();
    const empty = content.createDiv({ cls: 'zettel-table-toolbar' });
    const btn = empty.createEl('button', {
      cls: 'zettel-table-toolbar-btn',
      text: 'Select folder',
      attr: { 'aria-label': 'Select a folder to view' },
    });
    btn.addEventListener('click', (e) => this.showFolderMenu(btn, e));
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

    const view = this.cv;
    const allNotes = this.dataLayer.getNotes();
    const columnDefs = this.dataLayer.getColumnDefs();
    const visibleColumns = getVisibleColumns(columnDefs, view);
    const filtered = filterNotes(allNotes, view?.filters ?? []);
    const sorted = sortNotes(filtered, view?.sort ?? null);
    const pageSize = view?.pageSize ?? (this.folderConfig?.pageSize ?? this.settings.pageSize);
    const tableData = paginate(sorted, this.currentPage, pageSize);

    // View tabs
    this.renderViewTabs(content);

    // Toolbar
    this.renderToolbar(content, allNotes.length, tableData.totalRows, pageSize);

    // Filter panel (when open)
    if (this.filterPanelOpen) {
      this.renderFilterPanel(content);
    }

    // Table
    const tableContainer = content.createDiv({ cls: 'zettel-table-container' });
    if (this.settings.maxRowHeight !== null && this.settings.maxRowHeight > 0) {
      tableContainer.style.setProperty('--zt-max-row-height', `${this.settings.maxRowHeight}px`);
    }
    const table = tableContainer.createEl('table', { cls: 'zettel-table' });

    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');

    const titleWidth = view?.columns['_title']?.width ?? null;
    this.renderHeaderCell(headerRow, 'Title', '_title', titleWidth);
    for (const col of visibleColumns) {
      this.renderHeaderCell(headerRow, col.def.label, col.def.key, col.config.width);
    }

    const tbody = table.createEl('tbody');
    for (const note of tableData.rows) {
      const tr = tbody.createEl('tr');

      const titleTd = tr.createEl('td', { cls: 'zettel-table-td' });
      this.applyClamping(titleTd);
      renderTitleCell(titleTd, note, this.renderCallbacks());
      this.attachBodyResizeHandle(titleTd, '_title');

      for (const col of visibleColumns) {
        const td = tr.createEl('td', { cls: 'zettel-table-td' });
        this.applyClamping(td);
        const value = note.values[col.def.key] ?? { type: 'empty' as const };
        renderCell(td, value, note, this.app, this.settings.dateFormat, this.settings.pillColors, this.renderCallbacks());
        this.attachBodyResizeHandle(td, col.def.key);
      }
    }

    this.renderPagination(content, tableData, pageSize);
  }

  private renderViewTabs(parent: HTMLElement): void {
    if (!this.folderConfig) return;

    const bar = parent.createDiv({ cls: 'zettel-table-view-tabs' });

    this.folderConfig.views.forEach((view, i) => {
      const tab = bar.createEl('button', {
        cls: 'zettel-table-view-tab' + (i === this.currentViewIndex ? ' is-active' : ''),
        attr: { 'aria-label': view.name },
      });

      const iconEl = tab.createSpan({ cls: 'zettel-table-tab-icon' });
      setIcon(iconEl, i === this.currentViewIndex ? 'table' : 'table');

      const nameEl = tab.createSpan({ cls: 'zettel-table-tab-name', text: view.name });

      // Badge showing active filter count
      if (view.filters.length > 0) {
        tab.createSpan({
          cls: 'zettel-table-tab-badge',
          text: String(view.filters.length),
        });
      }

      // Click to switch
      tab.addEventListener('click', (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('[contenteditable="true"]')) return;
        if (i !== this.currentViewIndex) this.switchView(i);
      });

      // Double-click to rename
      tab.addEventListener('dblclick', () => {
        this.startInlineRename(nameEl, i);
      });

      // Right-click context menu (rename / delete)
      tab.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault();
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle('Rename').setIcon('pencil').onClick(() => {
            this.startInlineRename(nameEl, i);
          })
        );
        if (this.folderConfig && this.folderConfig.views.length > 1) {
          menu.addItem((item) =>
            item.setTitle('Delete view').setIcon('trash').onClick(() => this.deleteView(i))
          );
        }
        menu.showAtMouseEvent(e);
      });
    });

    // Add view button
    const addBtn = bar.createEl('button', {
      cls: 'zettel-table-view-tab-add',
      attr: { 'aria-label': 'Add view' },
    });
    setIcon(addBtn, 'plus');
    addBtn.addEventListener('click', () => this.createView());
  }

  private renderToolbar(
    parent: HTMLElement,
    totalNotes: number,
    filteredCount: number,
    pageSize: number
  ): void {
    const toolbar = parent.createDiv({ cls: 'zettel-table-toolbar' });
    const left = toolbar.createDiv({ cls: 'zettel-table-toolbar-left' });

    const folderBtn = left.createEl('button', {
      cls: 'zettel-table-folder-name',
      text: this.currentFolder ?? 'Select folder',
      attr: { 'aria-label': 'Change folder' },
    });
    folderBtn.addEventListener('click', (e) => this.showFolderMenu(folderBtn, e));

    const countText = (this.cv?.filters?.length ?? 0) > 0
      ? `${filteredCount} of ${totalNotes} notes`
      : `${totalNotes} notes`;
    left.createSpan({ cls: 'zettel-table-note-count', text: countText });

    left.createSpan({
      cls: 'zettel-table-toolbar-btn',
      text: humanizeSort(this.cv?.sort ?? null),
      attr: { 'aria-label': 'Current sort order' },
    });

    const right = toolbar.createDiv({ cls: 'zettel-table-toolbar-right' });

    // Filters button
    const filterCount = this.cv?.filters?.length ?? 0;
    const filterBtn = right.createEl('button', {
      cls: 'zettel-table-toolbar-btn' + (filterCount > 0 ? ' is-active' : ''),
      text: filterCount > 0 ? `Filters (${filterCount})` : 'Filters',
      attr: { 'aria-label': 'Toggle filters panel' },
    });
    filterBtn.addEventListener('click', () => {
      this.filterPanelOpen = !this.filterPanelOpen;
      this.renderView();
    });

    const pageSizeBtn = right.createEl('button', {
      cls: 'zettel-table-toolbar-btn',
      text: `${pageSize} per page`,
      attr: { 'aria-label': 'Change page size' },
    });
    pageSizeBtn.addEventListener('click', (e) => this.showPageSizeMenu(pageSizeBtn, e));

    const columnAnchor = right.createDiv({ cls: 'zettel-table-dropdown-anchor' });
    const columnBtn = columnAnchor.createEl('button', {
      cls: 'zettel-table-toolbar-btn',
      text: 'Columns',
      attr: { 'aria-label': 'Toggle column visibility and order' },
    });
    columnBtn.addEventListener('click', () => {
      if (this.columnDropdownOpen) {
        this.closeColumnDropdown();
      } else {
        this.openColumnDropdown(columnAnchor);
      }
    });
  }

  private renderFilterPanel(parent: HTMLElement): void {
    const panel = parent.createDiv({ cls: 'zettel-table-filter-panel' });
    const view = this.cv;
    const rules = view?.filters ?? [];
    const columnDefs = this.dataLayer.getColumnDefs();

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      const row = panel.createDiv({ cls: 'zettel-table-filter-row' });

      // Column selector
      const colSelect = row.createEl('select', { cls: 'zettel-table-filter-select' });
      // Title
      const titleOpt = colSelect.createEl('option', { text: 'Title', attr: { value: '_title' } });
      if (rule.column === '_title') titleOpt.selected = true;
      for (const def of columnDefs) {
        const opt = colSelect.createEl('option', { text: def.label, attr: { value: def.key } });
        if (rule.column === def.key) opt.selected = true;
      }
      colSelect.addEventListener('change', () => {
        this.updateFilterRule(i, { column: colSelect.value, value: '' });
      });

      // Operator selector
      const opSelect = row.createEl('select', { cls: 'zettel-table-filter-select' });
      for (const [op, label] of Object.entries(FILTER_OPERATOR_LABELS)) {
        const opt = opSelect.createEl('option', { text: label, attr: { value: op } });
        if (rule.operator === op) opt.selected = true;
      }
      opSelect.addEventListener('change', () => {
        this.updateFilterRule(i, { operator: opSelect.value as FilterOperator });
      });

      // Value input (hidden for is_empty / is_not_empty)
      const needsValue = rule.operator !== 'is_empty' && rule.operator !== 'is_not_empty';
      const valueInput = row.createEl('input', {
        cls: 'zettel-table-filter-input' + (needsValue ? '' : ' is-hidden'),
        type: 'text',
        value: rule.value,
        attr: { placeholder: 'Value…' },
      });
      valueInput.addEventListener('input', () => {
        this.updateFilterRule(i, { value: valueInput.value });
      });

      // Remove button
      const removeBtn = row.createEl('button', {
        cls: 'zettel-table-filter-remove',
        attr: { 'aria-label': 'Remove filter' },
      });
      setIcon(removeBtn, 'x');
      removeBtn.addEventListener('click', () => this.removeFilterRule(i));
    }

    // Add filter
    const addRow = panel.createDiv({ cls: 'zettel-table-filter-add-row' });
    const addBtn = addRow.createEl('button', {
      cls: 'zettel-table-toolbar-btn',
      text: '+ Add filter',
      attr: { 'aria-label': 'Add filter rule' },
    });
    addBtn.addEventListener('click', () => this.addFilterRule());
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
    if (this.cv?.sort?.column === columnKey) {
      labelSpan.createSpan({
        cls: 'zettel-table-sort-indicator',
        text: this.cv.sort.direction === 'asc' ? '\u2191' : '\u2193',
      });
    }

    th.addEventListener('click', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.zettel-table-resize-handle')) return;
      const view = this.ensureCurrentView();
      view.sort = cycleSort(view.sort ?? null, columnKey);
      this.saveSettings();
      this.currentPage = 1;
      this.renderView();
    });

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
        this.containerEl.querySelectorAll('.zettel-table-th.is-drag-over').forEach((el) => {
          el.removeClass('is-drag-over');
        });
      });
    }

    th.addEventListener('dragover', (e: DragEvent) => {
      if (!this.dragSourceColumn || this.dragSourceColumn === columnKey || columnKey === '_title') return;
      e.preventDefault();
      th.addClass('is-drag-over');
    });
    th.addEventListener('dragleave', () => th.removeClass('is-drag-over'));
    th.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      th.removeClass('is-drag-over');
      if (!this.dragSourceColumn || this.dragSourceColumn === columnKey || columnKey === '_title') return;
      this.reorderColumn(this.dragSourceColumn, columnKey);
    });

    const handle = th.createDiv({ cls: 'zettel-table-resize-handle' });
    const cleanup = attachResizeHandle(handle, th, columnKey, () => this.computeAutoWidth(columnKey), (key, newWidth) => {
      const view = this.ensureCurrentView();
      if (!view.columns[key]) {
        const colIdx = this.dataLayer.getColumnDefs().findIndex((d) => d.key === key);
        view.columns[key] = { visible: true, order: colIdx >= 0 ? colIdx : 0, width: null };
      }
      view.columns[key].width = newWidth;
      this.saveSettings();
    });
    this.resizeCleanups.push(cleanup);
  }

  private attachBodyResizeHandle(td: HTMLElement, columnKey: string): void {
    const th = this.thMap.get(columnKey);
    if (!th) return;
    const handle = td.createDiv({ cls: 'zettel-table-resize-handle' });
    const cleanup = attachResizeHandle(handle, th, columnKey, () => this.computeAutoWidth(columnKey), (key, newWidth) => {
      const view = this.ensureCurrentView();
      if (!view.columns[key]) {
        const colIdx = this.dataLayer.getColumnDefs().findIndex((d) => d.key === key);
        view.columns[key] = { visible: true, order: colIdx >= 0 ? colIdx : 0, width: null };
      }
      view.columns[key].width = newWidth;
      this.saveSettings();
    });
    this.resizeCleanups.push(cleanup);
  }

  private applyClamping(td: HTMLElement): void {
    if (this.settings.maxRowHeight !== null && this.settings.maxRowHeight > 0) {
      td.addClass('is-clamped');
    }
  }

  private renderPagination(
    parent: HTMLElement,
    tableData: ReturnType<typeof paginate>,
    pageSize: number
  ): void {
    const pagination = parent.createDiv({ cls: 'zettel-table-pagination' });

    const start = (tableData.currentPage - 1) * pageSize + 1;
    const end = Math.min(start + tableData.rows.length - 1, tableData.totalRows);
    pagination.createSpan({
      cls: 'zettel-table-page-info',
      text: tableData.totalRows > 0 ? `${start}\u2013${end} of ${tableData.totalRows}` : 'No notes',
    });

    const buttons = pagination.createDiv({ cls: 'zettel-table-page-buttons' });
    for (let i = 1; i <= tableData.totalPages; i++) {
      const btn = buttons.createEl('button', {
        cls: 'zettel-table-page-btn',
        text: String(i),
        attr: { 'aria-label': `Go to page ${i}` },
      });
      if (i === tableData.currentPage) btn.addClass('is-active');
      btn.addEventListener('click', () => {
        this.currentPage = i;
        this.renderView();
      });
    }
  }

  // ── Column dropdown ───────────────────────────────────────

  private openColumnDropdown(anchor: HTMLElement): void {
    this.cleanupDropdownListeners();
    this.columnDropdownOpen = true;

    const dropdown = anchor.createDiv({ cls: 'zettel-table-column-dropdown' });
    const columnDefs = this.dataLayer.getColumnDefs();
    const view = this.cv;

    // Build a sorted list of all columns (visible and hidden) for the dropdown
    const allCols = columnDefs.map((def) => {
      const config: ColumnConfig = view?.columns[def.key] ?? {
        visible: true,
        order: columnDefs.indexOf(def),
        width: null,
      };
      return { def, config };
    }).sort((a, b) => a.config.order - b.config.order);

    for (const { def, config } of allCols) {
      const item = dropdown.createDiv({ cls: 'zettel-table-column-item', attr: { draggable: 'true' } });

      // Drag handle
      const dragHandle = item.createSpan({
        cls: 'zettel-table-column-drag-handle',
        attr: { 'aria-label': 'Drag to reorder' },
      });
      setIcon(dragHandle, 'grip-vertical');

      // Drag events on the item row
      item.addEventListener('dragstart', (e: DragEvent) => {
        this.dropdownDragSource = def.key;
        e.dataTransfer?.setData('text/plain', def.key);
        item.addClass('is-dragging');
      });
      item.addEventListener('dragend', () => {
        this.dropdownDragSource = null;
        item.removeClass('is-dragging');
        dropdown.querySelectorAll('.is-drag-over').forEach((el) => el.removeClass('is-drag-over'));
      });
      item.addEventListener('dragover', (e: DragEvent) => {
        if (!this.dropdownDragSource || this.dropdownDragSource === def.key) return;
        e.preventDefault();
        item.addClass('is-drag-over');
      });
      item.addEventListener('dragleave', () => item.removeClass('is-drag-over'));
      item.addEventListener('drop', (e: DragEvent) => {
        e.preventDefault();
        item.removeClass('is-drag-over');
        if (!this.dropdownDragSource || this.dropdownDragSource === def.key) return;
        this.reorderColumn(this.dropdownDragSource, def.key);
        this.columnDropdownOpen = false;
      });

      // Checkbox
      const checkbox = item.createEl('input', {
        type: 'checkbox',
        attr: { 'aria-label': `Toggle ${def.label} column` },
      });
      checkbox.checked = config.visible;
      item.createSpan({ text: def.label });

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.target === checkbox || e.target === dragHandle || dragHandle.contains(e.target as Node)) return;
        checkbox.checked = !checkbox.checked;
        this.toggleColumnVisibility(def.key, checkbox.checked);
      });
      checkbox.addEventListener('change', () => {
        this.toggleColumnVisibility(def.key, checkbox.checked);
      });
    }

    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.closeColumnDropdown();
    };
    document.addEventListener('keydown', this.escapeHandler);

    this.outsideClickHandler = (e: MouseEvent) => {
      if (!anchor.contains(e.target as Node)) this.closeColumnDropdown();
    };
    window.setTimeout(() => {
      if (this.outsideClickHandler) document.addEventListener('click', this.outsideClickHandler);
    }, 0);
  }

  private closeColumnDropdown(): void {
    this.columnDropdownOpen = false;
    this.cleanupDropdownListeners();
    this.containerEl.querySelectorAll('.zettel-table-column-dropdown').forEach((el) => el.remove());
  }

  // ── Folder / page-size menus ──────────────────────────────

  private collectFolders(
    folder: TFolder,
    depth: number,
    result: Array<{ folder: TFolder; depth: number }>
  ): void {
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
      menu.addItem((item) =>
        item.setTitle(`${indent}${folder.name}`).setIcon('folder').onClick(() => {
          this.loadFolder(folder.path);
        })
      );
    }

    if (event instanceof MouseEvent) menu.showAtMouseEvent(event);
    else {
      const rect = anchor.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom });
    }
  }

  private showPageSizeMenu(anchor: HTMLElement, event: Event): void {
    const menu = new Menu();
    for (const size of [25, 50, 100]) {
      menu.addItem((item) =>
        item.setTitle(String(size)).onClick(() => {
          const view = this.ensureCurrentView();
          view.pageSize = size;
          this.saveSettings();
          this.currentPage = 1;
          this.renderView();
        })
      );
    }
    if (event instanceof MouseEvent) menu.showAtMouseEvent(event);
    else {
      const rect = anchor.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom });
    }
  }

  // ── Cleanup ───────────────────────────────────────────────

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
    for (const cleanup of this.resizeCleanups) cleanup();
    this.resizeCleanups = [];
  }
}
