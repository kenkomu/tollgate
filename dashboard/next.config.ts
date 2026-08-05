import type {NextConfig} from "next";

const nextConfig: NextConfig = {
  // @tollgate/shared ships TypeScript source rather than a build artifact, so the contract
  // ABI, reason codes and chain config have exactly one representation in the repo. Next
  // has to compile it as if it were first-party code.
  transpilePackages: ["@tollgate/shared"],

  // Don't generate AGENTS.md / CLAUDE.md into this package — repo-level guidance lives
  // at the root, and duplicating it per-workspace invites the two to drift.
  agentRules: false,
};

export default nextConfig;
