/** The compact table every list of records uses — controllers, discovered devices, driver
 *  search results, connections and their endpoints. Composer's grid density with a modern
 *  finish: sortable headers, a sticky head, row hover and selection, arrow-key navigation,
 *  Enter or double-click to act on a row, and virtual rows once a list gets long.
 *
 *  Columns are TanStack Table `ColumnDef`s; `meta` adds the width and alignment. It is not a
 *  data grid: no editing, no column resizing, no paging. */

import {
  flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type RowData, type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cx } from "../lib/ui";

declare module "@tanstack/react-table" {
  // Type parameters must match the library's declaration to merge.
  interface ColumnMeta<TData extends RowData, TValue> {
    /** CSS width of the column (`120`, `"30%"`); the rest share what is left. */
    width?: number | string;
    align?: "right" | "center";
    /** Extra class on every cell of the column. */
    className?: string;
    /** Hide the column while the table is narrower than this (px): a narrow pane keeps the
     *  columns that matter instead of squeezing all of them to a letter. */
    hideBelow?: number;
  }
}

export type { ColumnDef } from "@tanstack/react-table";

/** Row count past which only the rows on screen are drawn. */
const VIRTUAL_OVER = 80;
const ROW_HEIGHT = 27;

export function DataTable<T>({
  data, columns, rowId, selected, onSelect, onActivate, rowClass, empty, sort, label, className, scroll = true, autoFocus,
}: {
  data: T[];
  // Columns hold differently typed values; `unknown` would not accept them.
  columns: ColumnDef<T, any>[];
  rowId: (row: T) => string;
  selected?: string | null;
  onSelect?: (row: T) => void;
  /** Enter or double-click on a row. */
  onActivate?: (row: T) => void;
  rowClass?: (row: T) => string | false | null | undefined;
  /** Shown instead of rows when there are none. */
  empty?: React.ReactNode;
  /** Initial sort, e.g. `[{ id: "name", desc: false }]`. */
  sort?: SortingState;
  /** For screen readers: what the table lists. */
  label: string;
  className?: string;
  /** Scroll inside (the default: the table fills its pane) or grow with its rows. */
  scroll?: boolean;
  autoFocus?: boolean;
}) {
  const [sorting, setSorting] = useState<SortingState>(sort ?? []);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const columnVisibility = Object.fromEntries(columns.flatMap((c) => {
    const id = c.id ?? (c as { accessorKey?: string }).accessorKey;
    const below = c.meta?.hideBelow;
    return id && below && width > 0 && width < below ? [[id, false]] : [];
  }));
  const table = useReactTable({
    data, columns, state: { sorting, columnVisibility }, onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(),
    getRowId: (r) => rowId(r),
  });
  const rows = table.getRowModel().rows;
  const virtual = scroll && rows.length > VIRTUAL_OVER;
  const v = useVirtualizer({ count: virtual ? rows.length : 0, getScrollElement: () => box.current, estimateSize: () => ROW_HEIGHT, overscan: 12 });
  const items = v.getVirtualItems();
  // Positions in the sorted list, which is what the keyboard moves through.
  const shown = virtual ? items.map((i) => ({ r: rows[i.index], at: i.index })) : rows.map((r, at) => ({ r, at }));
  const padTop = virtual && items.length ? items[0].start : 0;
  const padBottom = virtual && items.length ? v.getTotalSize() - items[items.length - 1].end : 0;
  const leaves = table.getVisibleLeafColumns();

  useEffect(() => { if (autoFocus) box.current?.focus({ preventScroll: true }); }, [autoFocus]);

  /** Bring the selected row into view after the keyboard moved it. */
  const reveal = (index: number) => {
    if (virtual) v.scrollToIndex(index, { align: "auto" });
    else box.current?.querySelector<HTMLElement>(`tr[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea, select, button") && e.target !== box.current) return;
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.id === selected);
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(rows.length - 1, at + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, at < 0 ? 0 : at - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    else if (e.key === "PageDown") next = Math.min(rows.length - 1, Math.max(0, at) + 10);
    else if (e.key === "PageUp") next = Math.max(0, at - 10);
    else if (e.key === "Enter" && at >= 0 && onActivate) {
      e.preventDefault();
      onActivate(rows[at].original);
      return;
    } else return;
    e.preventDefault();
    if (onSelect) onSelect(rows[next].original);
    reveal(next);
  };

  // A double-click that started on a control is that control's business.
  const fromControl = (e: React.MouseEvent) => !!(e.target as HTMLElement).closest("button, input, select, textarea, a, [role=combobox]");

  return (
    <div ref={box} className={cx("dt", scroll ? "dt-scroll" : "dt-grow", className)} tabIndex={onSelect ? 0 : -1} onKeyDown={onKey}
         role="grid" aria-label={label} aria-rowcount={rows.length}>
      <table>
        <colgroup>{leaves.map((c) => <col key={c.id} style={{ width: c.columnDef.meta?.width }} />)}</colgroup>
        <thead>
          {table.getHeaderGroups().map((g) => (
            <tr key={g.id}>
              {g.headers.map((h) => {
                const meta = h.column.columnDef.meta;
                const can = h.column.getCanSort();
                const dir = h.column.getIsSorted();
                const head = h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext());
                return (
                  <th key={h.id} className={cx(meta?.align, meta?.className)} aria-sort={dir ? (dir === "asc" ? "ascending" : "descending") : undefined}>
                    {can && head ? (
                      <button className={cx("dt-sort", dir && "on")} onClick={h.column.getToggleSortingHandler()} tabIndex={-1}>
                        {head}
                        {dir === "asc" ? <ArrowUp size={11} strokeWidth={2} /> : dir === "desc" ? <ArrowDown size={11} strokeWidth={2} /> : null}
                      </button>
                    ) : head}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {padTop > 0 && <tr className="dt-pad" style={{ height: padTop }}><td colSpan={leaves.length} /></tr>}
          {shown.map(({ r, at }) => (
            <tr key={r.id} data-index={at} aria-selected={r.id === selected}
                className={cx(r.id === selected && "sel", (onSelect || onActivate) && "pick", rowClass?.(r.original))}
                onClick={() => onSelect?.(r.original)}
                onDoubleClick={(e) => { if (onActivate && !fromControl(e)) onActivate(r.original); }}>
              {r.getVisibleCells().map((c) => {
                const meta = c.column.columnDef.meta;
                return <td key={c.id} className={cx(meta?.align, meta?.className)}>{flexRender(c.column.columnDef.cell, c.getContext())}</td>;
              })}
            </tr>
          ))}
          {padBottom > 0 && <tr className="dt-pad" style={{ height: padBottom }}><td colSpan={leaves.length} /></tr>}
        </tbody>
      </table>
      {!rows.length && empty != null && <div className="dt-empty">{empty}</div>}
    </div>
  );
}
