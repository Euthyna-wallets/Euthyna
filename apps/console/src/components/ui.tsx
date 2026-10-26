import type { ReactNode } from "react";

export function PageState({ loading, error, empty, emptyContent, children }: {
  loading?: boolean;
  error?: unknown;
  empty?: boolean;
  emptyContent?: ReactNode;
  children: ReactNode;
}) {
  if (loading) return <div className="state">Loading…</div>;
  if (error) return <div className="state error">Error: {error instanceof Error ? error.message : String(error)}</div>;
  if (empty) return <>{emptyContent ?? <div className="state">Nothing here yet.</div>}</>;
  return <>{children}</>;
}

export function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Status({ value }: { value: string }) {
  return <span className={`status status-${value.toLowerCase().replaceAll("_", "-")}`}>{value}</span>;
}

export function short(value: string | null | undefined, size = 8): string {
  if (!value) return "—";
  return value.length > size * 2 ? `${value.slice(0, size)}…${value.slice(-6)}` : value;
}

/** "every day", "every 7 days". */
export function everyDays(days: number | null | undefined): string {
  if (!days) return "refill period unknown";
  return days === 1 ? "every day" : `every ${days} days`;
}
