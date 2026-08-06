/**
 * Placeholders for the parts that stream in.
 *
 * These exist to hold the exact space the real content will take, so nothing jumps when
 * the log walk lands. A skeleton that is the wrong height is worse than no skeleton — it
 * trades a blank area for a layout shift.
 *
 * They shimmer, but slowly, and not at all under `prefers-reduced-motion`. Restless
 * loading states make software feel anxious, which is the opposite of what a page about
 * spending limits should feel like.
 */

export function SkeletonFeed() {
  return (
    <section className="card" aria-busy="true" aria-live="polite">
      <h2 className="card-title">Activity</h2>
      <p className="card-note">Reading the log from Arc&hellip;</p>
      <div className="feed">
        {[0, 1, 2, 3, 4].map((row) => (
          <div className="feed-row neutral" key={row}>
            <div className="feed-stripe" />
            <div className="feed-body">
              <div className="feed-top">
                <span className="shimmer" style={{width: 150, height: 14}} />
                <span className="shimmer" style={{marginLeft: "auto", width: 58, height: 14}} />
              </div>
              <div className="feed-sub">
                <span className="shimmer" style={{width: 220, height: 11}} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The KPI strip and the chart, which arrive together with the log walk. */
export function SkeletonTiles() {
  return (
    <>
      <div className="tiles" aria-busy="true" aria-live="polite">
        {[0, 1, 2, 3].map((tile) => (
          <div className="tile" key={tile}>
            <span className="shimmer" style={{width: 84, height: 10}} />
            <span className="shimmer" style={{width: 64, height: 24, margin: "10px 0 8px"}} />
            <span className="shimmer" style={{width: 120, height: 10}} />
          </div>
        ))}
      </div>
      <section className="card" aria-busy="true">
        <h2 className="card-title">Spend against the ceiling</h2>
        <p className="card-note">Reading the log from Arc&hellip;</p>
        <span className="shimmer" style={{width: "100%", height: 200}} />
      </section>
      <SkeletonFeed />
    </>
  );
}

/** The two facts on the leash card that can only come from the log walk. */
export function SkeletonFacts() {
  return (
    <>
      <dt>approved payees</dt>
      <dd>
        <span className="shimmer" style={{width: 18, height: 12, display: "inline-block"}} />
      </dd>
      <dt>payments made</dt>
      <dd>
        <span className="shimmer" style={{width: 18, height: 12, display: "inline-block"}} />
      </dd>
    </>
  );
}
