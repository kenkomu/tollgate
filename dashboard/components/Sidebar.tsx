"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {ActivityIcon, PayeeIcon, PolicyIcon, ShieldIcon} from "./Icon.tsx";
import {LiveRefresh} from "./LiveRefresh.tsx";
import {NetworkPill} from "./NetworkBanner.tsx";

/**
 * Navigation.
 *
 * A rail rather than a top bar, because the sections are peers — none of them is a step
 * in a sequence, and any of them can be the reason you opened the page. The current
 * section is marked with a filled bar as well as a colour change; an owner checking a
 * spend limit should not have to distinguish two shades of the same brass to know where
 * they are.
 */

const LINKS = [
  {href: "/", label: "Overview", Icon: ShieldIcon},
  {href: "/activity", label: "Activity", Icon: ActivityIcon},
  {href: "/payees", label: "Payees", Icon: PayeeIcon},
  {href: "/policy", label: "Policy", Icon: PolicyIcon},
  {href: "/welcome", label: "About", Icon: ShieldIcon},
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="rail" aria-label="Sections">
      <div className="rail-top">
        <NetworkPill />
        <p className="wordmark">
          Tollgate<span className="wordmark-dot">.</span>
        </p>
      </div>

      <ul className="rail-links">
        {LINKS.map(({href, label, Icon}) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <li key={href}>
              <Link href={href} className={`rail-link${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
                <Icon size={15} />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="rail-foot">
        <LiveRefresh />
        <p className="rail-note">
          Every number on these pages is read from the contract at request time. Nothing is
          stored here.
        </p>
      </div>
    </nav>
  );
}
