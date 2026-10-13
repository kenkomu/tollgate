import {render, screen, waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, it, vi} from "vitest";
import * as owner from "../lib/owner.ts";
import {AddPayeeEditor} from "../components/PolicyEditors.tsx";

vi.mock("../lib/owner.ts", async () => (await import("./mocks.ts")).ownerWrites());
vi.mock("../lib/chain.ts", async () => (await import("./mocks.ts")).chainModule());

// The same forms, pointed at mainnet. The network is fixed at build time, so this file
// swaps it in before anything imports it.
vi.mock("@tollgate/shared", async (importOriginal) => {
  const shared = await importOriginal<typeof import("@tollgate/shared")>();
  return {...shared, activeChain: shared.arcMainnet};
});

const writes = vi.mocked(owner);

describe("on mainnet", () => {
  it("every write needs an explicit acknowledgement first", async () => {
    render(<AddPayeeEditor policyId={1n} />);
    await userEvent.type(screen.getByLabelText(/^address/i), "0x2222222222222222222222222222222222222222");

    const add = screen.getByRole("button", {name: /allowlist/i});
    expect(add).toBeDisabled();

    await userEvent.click(screen.getByLabelText(/real transaction on arc mainnet/i));
    expect(add).toBeEnabled();
    await userEvent.click(add);
    await waitFor(() => expect(writes.addPayee).toHaveBeenCalledOnce());
  });
});
