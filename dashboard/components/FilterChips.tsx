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
export function FilterChips({
  active,
  counts,
  agent,
}: {
  active: FilterId;
  counts: Record<FilterId, number>;
  /** Kept in every link, so filtering does not drop the agent being looked at. */
  agent?: string | undefined;
}) {
  const href = (id: FilterId) => {
    const query = new URLSearchParams();
    if (agent) query.set("agent", agent);
    if (id !== "all") query.set("filter", id);
    const text = query.toString();
    return text ? `/activity?${text}` : "/activity";
  };
  return (
    <nav className="chips" aria-label="Filter activity">
      {FILTERS.map(({id, label}) => (
        <Link
          key={id}
          href={href(id)}
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
