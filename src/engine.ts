import { NoteData, NoteValue, SortConfig, TablePage, ColumnDef, FolderConfig, ColumnConfig, FilterRule, FilterOperator } from './types';

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

/** Test a single note against a single filter rule */
function matchesRule(note: NoteData, rule: FilterRule): boolean {
  const val: NoteValue = rule.column === '_title'
    ? { type: 'text', value: note.displayTitle }
    : (note.values[rule.column] ?? { type: 'empty' });

  // Empty checks don't need a value
  if (rule.operator === 'is_empty') return val.type === 'empty';
  if (rule.operator === 'is_not_empty') return val.type !== 'empty';

  // All other operators return false for empty cells
  if (val.type === 'empty') return false;

  const ruleVal = rule.value.toLowerCase();

  switch (val.type) {
    case 'text':
    case 'status': {
      const cell = val.value.toLowerCase();
      return applyOp(rule.operator, cell, ruleVal);
    }
    case 'date': {
      // Match against the raw ISO string (allows "2025", "2025-03", "2025-03-15")
      const cell = val.value.toLowerCase();
      return applyOp(rule.operator, cell, ruleVal);
    }
    case 'number': {
      const cell = String(val.value);
      return applyOp(rule.operator, cell, rule.value);
    }
    case 'boolean': {
      const cell = val.value ? 'true' : 'false';
      return applyOp(rule.operator, cell, ruleVal);
    }
    case 'links':
    case 'tags': {
      // For multi-value cells: equals/contains match if ANY item matches;
      // not_equals/not_contains match only if NO item matches.
      const items = val.value.map((s) => s.toLowerCase());
      switch (rule.operator) {
        case 'equals':     return items.some((i) => i === ruleVal);
        case 'not_equals': return !items.some((i) => i === ruleVal);
        case 'contains':     return items.some((i) => i.includes(ruleVal));
        case 'not_contains': return !items.some((i) => i.includes(ruleVal));
        default: return true;
      }
    }
    default:
      return true;
  }
}

function applyOp(op: FilterOperator, cell: string, ruleVal: string): boolean {
  switch (op) {
    case 'equals':       return cell === ruleVal;
    case 'not_equals':   return cell !== ruleVal;
    case 'contains':     return cell.includes(ruleVal);
    case 'not_contains': return !cell.includes(ruleVal);
    default: return true;
  }
}

/** Filter notes by all rules in a view (AND logic — all rules must pass) */
export function filterNotes(notes: NoteData[], filters: FilterRule[]): NoteData[] {
  if (filters.length === 0) return notes;
  return notes.filter((note) => filters.every((rule) => matchesRule(note, rule)));
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
  folderConfig: { columns: Record<string, ColumnConfig> } | undefined
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
