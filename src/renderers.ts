import { App, TFile } from 'obsidian';
import { NoteValue, NoteData, DateFormat, PillColor } from './types';

/**
 * Callbacks passed from the view so renderers can open notes
 * without needing to know about the workspace leaf strategy.
 */
export interface RenderCallbacks {
  openFile: (file: TFile) => void;
  openLink: (linktext: string, sourcePath: string) => void;
}

export function renderTitleCell(
  td: HTMLElement,
  note: NoteData,
  callbacks: RenderCallbacks
): void {
  const link = td.createEl('a', {
    cls: 'zettel-table-title-link',
    text: note.displayTitle,
    attr: { tabindex: '0' },
  });
  link.setAttribute('aria-label', `Open ${note.displayTitle}`);
  const openNote = (e: Event) => {
    e.preventDefault();
    callbacks.openFile(note.file);
  };
  link.addEventListener('click', openNote);
  link.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') openNote(e);
  });
}

export function renderTextCell(td: HTMLElement, value: NoteValue): void {
  if (value.type !== 'text') return;
  td.createSpan({ text: value.value, cls: 'zettel-table-text' });
}

export function renderDateCell(td: HTMLElement, value: NoteValue, format: DateFormat): void {
  if (value.type !== 'date') return;
  const m = (window as unknown as { moment: (s: string) => { format: (f: string) => string } }).moment(value.value);
  td.createSpan({ text: m.format(format), cls: 'zettel-table-date' });
}

export function renderNumberCell(td: HTMLElement, value: NoteValue): void {
  if (value.type !== 'number') return;
  td.createSpan({ text: String(value.value), cls: 'zettel-table-number' });
}

export function renderBooleanCell(td: HTMLElement, value: NoteValue): void {
  if (value.type !== 'boolean') return;
  const checkbox = td.createEl('input', { type: 'checkbox', cls: 'zettel-table-checkbox' });
  checkbox.checked = value.value;
  checkbox.disabled = true;
}

function resolvePillColor(value: string, pillColors: Record<string, PillColor>): PillColor {
  return pillColors[value] ?? 'gray';
}

export function renderLinkPills(
  td: HTMLElement,
  value: NoteValue,
  sourcePath: string,
  callbacks: RenderCallbacks
): void {
  if (value.type !== 'links') return;
  const container = td.createDiv({ cls: 'zettel-table-pill-container' });

  for (const linkName of value.value) {
    const pill = container.createEl('a', {
      cls: 'zettel-table-link-pill',
      text: linkName,
      attr: { tabindex: '0' },
    });
    pill.setAttribute('aria-label', `Open ${linkName}`);
    const openLink = (e: Event) => {
      e.preventDefault();
      callbacks.openLink(linkName, sourcePath);
    };
    pill.addEventListener('click', openLink);
    pill.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') openLink(e);
    });
  }
}

export function renderTagPills(
  td: HTMLElement,
  value: NoteValue,
  pillColors: Record<string, PillColor>
): void {
  if (value.type !== 'tags') return;
  const container = td.createDiv({ cls: 'zettel-table-pill-container' });

  for (const tag of value.value) {
    const color = resolvePillColor(tag, pillColors);
    const pill = container.createSpan({
      cls: 'zettel-table-pill',
      text: tag,
    });
    pill.dataset.color = color;
  }
}

export function renderStatusBadge(td: HTMLElement, value: NoteValue): void {
  if (value.type !== 'status') return;
  const badge = td.createSpan({
    cls: 'zettel-table-badge',
    text: value.value,
  });
  badge.dataset.status = value.value.toLowerCase();
}

export function renderEmptyCell(td: HTMLElement): void {
  td.createSpan({ cls: 'zettel-table-empty', text: '\u2014' });
}

export function renderCell(
  td: HTMLElement,
  value: NoteValue,
  note: NoteData,
  app: App,
  dateFormat: DateFormat,
  pillColors: Record<string, PillColor>,
  callbacks: RenderCallbacks
): void {
  switch (value.type) {
    case 'text':
      renderTextCell(td, value);
      break;
    case 'date':
      renderDateCell(td, value, dateFormat);
      break;
    case 'number':
      renderNumberCell(td, value);
      break;
    case 'boolean':
      renderBooleanCell(td, value);
      break;
    case 'links':
      renderLinkPills(td, value, note.file.path, callbacks);
      break;
    case 'tags':
      renderTagPills(td, value, pillColors);
      break;
    case 'status':
      renderStatusBadge(td, value);
      break;
    case 'empty':
      renderEmptyCell(td);
      break;
  }
}
