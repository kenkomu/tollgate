import type {NextConfig} from "next";

const nextConfig: NextConfig = {
  // @tollgate/shared ships TypeScript source rather than a build artifact, so the contract
  // ABI, reason codes and chain config have exactly one representation in the repo. Next
  // has to compile it as if it were first-party code.
  transpilePackages: ["@tollgate/shared"],

  // Don't generate AGENTS.md / CLAUDE.md into this package — repo-level guidance lives
  // at the root, and duplicating it per-workspace invites the two to drift.
  agentRules: false,

  // No floating dev badge. This page gets demoed and screenshotted from the dev server,
  // and a framework logo in the corner is the one pixel nobody meant to show.
  devIndicators: false,

  // The owner signs in their own browser, so the client bundle needs to know which contract
  // and which policy it is talking about. Both are public information — an address on a
  // block explorer — and neither is a secret being leaked.
  //
  // Mapped from the existing names rather than renaming them in `.env`, because the agent
  // and the Foundry scripts read the same file and would not follow a rename.
  env: {
    NEXT_PUBLIC_POLICY_ENGINE_ADDRESS: process.env.POLICY_ENGINE_ADDRESS ?? "",
    NEXT_PUBLIC_OWNER_ADDRESS: process.env.OWNER_ADDRESS ?? "",
    NEXT_PUBLIC_ARC_CHAIN_ID: process.env.ARC_CHAIN_ID ?? "",
    // Where the live stream comes from. Public: it serves only "something changed".
    NEXT_PUBLIC_TOLLGATE_SERVICE_URL: process.env.TOLLGATE_SERVICE_URL ?? "http://localhost:8080",
  },
};

export default nextConfig;
