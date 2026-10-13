import Link from "next/link";

export const FILTERS = [
  {id: "all", label: "All"},
  {id: "paid", label: "Payments"},
  {id: "refused", label: "Refused"},
  {id: "changes", label: "Policy changes"},
] as const;

export type FilterId = (typeof FILTERS)[number]["id"];

export function parseFilter(value: string | string[] | undefined): FilterId {
  const raw = Array.isArray(value) ? value[0] : value;
  return FILTERS.some((f) => f.id === raw) ? (raw as FilterId) : "all";
}

/** Pill filters, as links: the chosen view survives a reload and can be shared. */
export function FilterChips({active, counts}: {active: FilterId; counts: Record<FilterId, number>}) {
  return (
    <nav className="chips" aria-label="Filter activity">
      {FILTERS.map(({id, label}) => (
        <Link
          key={id}
          href={id === "all" ? "/activity" : `/activity?filter=${id}`}
          className={`chip-link${active === id ? " active" : ""}`}
          aria-current={active === id ? "true" : undefined}
          scroll={false}
        >
          {label}
          <span className="chip-count">{counts[id]}</span>
        </Link>
      ))}
    </nav>
  );
}
