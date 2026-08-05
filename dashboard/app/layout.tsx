import type {Metadata} from "next";
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
      <body>{children}</body>
    </html>
  );
}
