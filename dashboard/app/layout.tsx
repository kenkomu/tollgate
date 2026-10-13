import type {Metadata} from "next";
import {Sidebar} from "../components/Sidebar.tsx";
import {NetworkBanner} from "../components/NetworkBanner.tsx";
import {WalletBar} from "../components/WalletBar.tsx";
import "./globals.css";

// No webfonts. The design system uses a system stack deliberately — a font that has to
// load is a font that can fail to load, and the numbers on this page have to line up
// on the first paint.

export const metadata: Metadata = {
  title: "Tollgate — agent spend control",
  description: "On-chain spend policy for autonomous agents, on Arc.",
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <div className="shell">
          <Sidebar />
          <main className="content" id="main" tabIndex={-1}>
            <NetworkBanner />
            <WalletBar />
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
