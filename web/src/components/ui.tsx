/** Small presentational pieces shared by the pages. */

import type { ReactNode } from "react";

export function PageHeader({ eyebrow, title, children }: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      {children !== undefined && <p className="lede">{children}</p>}
    </header>
  );
}

export interface StatItem {
  label: string;
  value: string;
  note?: string | undefined;
  tone?: "warn" | undefined;
}

export function Stats({ items }: { items: StatItem[] }) {
  return (
    <div className="stats">
      {items.map((s) => (
        <div className="stat" key={s.label}>
          <div className="stat-label">{s.label}</div>
          <div className="stat-value">{s.value}</div>
          {s.note !== undefined && (
            <div className={s.tone === "warn" ? "stat-note stat-warn" : "stat-note"}>{s.note}</div>
          )}
        </div>
      ))}
    </div>
  );
}

export function Card({ title, note, children, wide }: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={wide === true ? "card card-wide" : "card"}>
      <h2 className="card-title">{title}</h2>
      {children}
      {note !== undefined && <p className="card-note">{note}</p>}
    </section>
  );
}

export interface Column<Row> {
  label: string;
  value: (row: Row) => ReactNode;
  numeric?: boolean;
}

export function Table<Row>({ rows, columns, rowKey, maxHeight }: {
  rows: readonly Row[];
  columns: readonly Column<Row>[];
  rowKey: (row: Row, index: number) => string;
  maxHeight?: number;
}) {
  return (
    <div className="table-wrap" style={maxHeight !== undefined ? { maxHeight } : undefined}>
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label} className={c.numeric === true ? "num" : undefined}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey(row, i)}>
              {columns.map((c) => (
                <td key={c.label} className={c.numeric === true ? "num" : undefined}>{c.value(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="empty">
      <div className="spinner" />
      <span>{label}</span>
    </div>
  );
}

/** Fitness to four decimals, or a dash. */
export const fmt = (value: number | null | undefined, digits = 4) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits);
