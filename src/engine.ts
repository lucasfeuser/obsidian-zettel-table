import { NoteData, NoteValue, SortConfig, TablePage, ColumnDef, FolderConfig, ColumnConfig } from './types';

/** Compare two NoteValues for sorting */
function compareValues(a: NoteValue, b: NoteValue, direction: 'asc' | 'desc'): number {
  const mult = direction === 'asc' ? 1 : -1;

  if (a.type === 'empty' && b.type === 'empty') return 0;
  if (a.type === 'empty') return 1;
  if (b.type === 'empty') return -1;

  switch (a.type) {
    case 'text':
    case 'status':
    case 'date': {
      const aVal = a.value as string;
      const bVal = (b as { value: string }).value;
      return mult * aVal.localeCompare(bVal, undefined, { sensitivity: 'base' });
    }
    case 'number': {
      const aVal = a.value as number;
      const bVal = (b as { value: number }).value;
      return mult * (aVal - bVal);
    }
    case 'boolean': {
      const aVal = a.value ? 1 : 0;
      const bVal = (b as { value: boolean }).value ? 1 : 0;
      return mult * (aVal - bVal);
    }
    case 'links':
    case 'tags': {
      const aLen = (a.value as string[]).length;
      const bLen = (b.value as string[]).length;
      return mult * (aLen - bLen);
    }
    default:
      return 0;
  }
}

export function sortNotes(notes: NoteData[], sort: SortConfig | null): NoteData[] {
  if (!sort) return notes;

  return [...notes].sort((a, b) => {
    if (sort.column === '_title') {
      const cmp = a.displayTitle.localeCompare(b.displayTitle, undefined, { sensitivity: 'base' });
      return sort.direction === 'asc' ? cmp : -cmp;
    }
    const aVal = a.values[sort.column] ?? { type: 'empty' as const };
    const bVal = b.values[sort.column] ?? { type: 'empty' as const };
    return compareValues(aVal, bVal, sort.direction);
  });
}

export function paginate(notes: NoteData[], page: number, pageSize: number): TablePage {
  const totalRows = notes.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const clampedPage = Math.max(1, Math.min(page, totalPages));
  const start = (clampedPage - 1) * pageSize;
  const rows = notes.slice(start, start + pageSize);

  return {
    rows,
    totalRows,
    currentPage: clampedPage,
    totalPages,
  };
}

export function getVisibleColumns(
  columnDefs: ColumnDef[],
  folderConfig: FolderConfig | undefined
): { def: ColumnDef; config: ColumnConfig }[] {
  const columns = columnDefs.map((def) => {
    const config = folderConfig?.columns[def.key] ?? {
      visible: true,
      order: columnDefs.indexOf(def),
      width: null,
    };
    return { def, config };
  });

  return columns
    .filter((col) => col.config.visible)
    .sort((a, b) => a.config.order - b.config.order);
}

export function cycleSort(current: SortConfig | null, column: string): SortConfig | null {
  if (!current || current.column !== column) {
    return { column, direction: 'asc' };
  }
  if (current.direction === 'asc') {
    return { column, direction: 'desc' };
  }
  return null;
}
