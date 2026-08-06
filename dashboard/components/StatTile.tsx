/**
 * A number and what it means.
 *
 * The KPI strip is the one place where a figure appears with no chart around it, so each
 * tile carries its own context line — a bare number with a label is a trivia question.
 * `tone` is for state, never for emphasis: red here means the same thing it means
 * everywhere else on this page, which is that something was stopped.
 */
export function StatTile({
  label,
  value,
  context,
  tone,
}: {
  label: string;
  value: string;
  context?: string;
  tone?: "ok" | "stop";
}) {
  return (
    <div className="tile">
      <p className="tile-label">{label}</p>
      <p className={`tile-value${tone ? ` ${tone}` : ""}`}>{value}</p>
      {context ? <p className="tile-context">{context}</p> : null}
    </div>
  );
}
