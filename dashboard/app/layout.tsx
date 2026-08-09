import type {Metadata} from "next";
import {Sidebar} from "../components/Sidebar.tsx";
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
        <div className="shell">
          <Sidebar />
          <div className="content">
            <WalletBar />
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
