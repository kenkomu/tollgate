import type {ReactNode} from "react";

/**
 * A word with its meaning attached.
 *
 * The product's vocabulary (budget, burst, allowance) is exact but not self-explanatory to
 * someone arriving cold. This keeps the precise word on the page and puts the plain-English
 * version one hover, focus or long-press away — `title` for assistive tech and the native
 * fallback, `data-tip` for the styled bubble.
 */
export function Term({tip, children}: {tip: string; children: ReactNode}) {
  return (
    <abbr className="term" title={tip} data-tip={tip} tabIndex={0}>
      {children}
    </abbr>
  );
}
