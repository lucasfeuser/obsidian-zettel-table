export function attachResizeHandle(
  handle: HTMLElement,
  th: HTMLElement,
  columnKey: string,
  onResize: (columnKey: string, width: number | null) => void
): () => void {
  let startX = 0;
  let startWidth = 0;

  const onMouseMove = (e: MouseEvent) => {
    const newWidth = Math.max(60, startWidth + (e.clientX - startX));
    th.style.setProperty('--zt-col-width', `${newWidth}px`);
  };

  const onMouseUp = (e: MouseEvent) => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.removeClass('zettel-table-resizing');

    const finalWidth = Math.max(60, startWidth + (e.clientX - startX));
    th.style.setProperty('--zt-col-width', `${finalWidth}px`);
    onResize(columnKey, finalWidth);
  };

  handle.addEventListener('mousedown', (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    startWidth = th.offsetWidth;
    document.body.addClass('zettel-table-resizing');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  handle.addEventListener('dblclick', (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    th.style.removeProperty('--zt-col-width');
    onResize(columnKey, null);
  });

  return () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.removeClass('zettel-table-resizing');
  };
}
