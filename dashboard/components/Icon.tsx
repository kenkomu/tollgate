/**
 * Icons.
 *
 * Inline SVG, stroked in `currentColor`, drawn on a 24-unit grid. Inline because this page
 * must render with no network beyond the RPC — an icon font or a sprite sheet is one more
 * thing that can fail to load in front of a judge. `currentColor` because the palette rule
 * (red means stopped, and appears nowhere else) has to hold for icons too, and it only
 * holds if colour is inherited rather than baked into the path.
 *
 * Decorative by default: every icon here sits next to a text label, so it is hidden from
 * screen readers rather than announced twice. Pass a `title` only where an icon stands
 * alone.
 */

interface IconProps {
  size?: number;
  className?: string;
  title?: string;
}

function Svg({size = 14, className, title, children}: IconProps & {children: React.ReactNode}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/** Leaves the page. Always trails a link, never leads it. */
export function ExternalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 17 17 7" />
      <path d="M9 7h8v8" />
    </Svg>
  );
}

/** The leash. Used for the policy card and the verdict when nothing got past it. */
export function ShieldIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </Svg>
  );
}

/** Stopped. Only ever rendered in `--stop`. */
export function StopIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8" />
    </Svg>
  );
}

/** A payment that the contract let through. */
export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4 12.5 5 5L20 6.5" />
    </Svg>
  );
}

/** Waiting on the owner. */
export function HandIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4.5" />
      <path d="M12 16h.01" />
    </Svg>
  );
}

/** Policy changed by the owner rather than a payment made by the agent. */
export function SlidersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 20v-7M5 9V4M12 20v-9M12 7V4M19 20v-4M19 12V4" />
      <path d="M2.5 13h5M9.5 7h5M16.5 16h5" />
    </Svg>
  );
}

/** The live indicator's companion. */
export function PulseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </Svg>
  );
}
