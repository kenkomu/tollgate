import {render, screen, waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {usdc, type PolicyWithId as Policy} from "@tollgate/shared";
import {describe, expect, it, vi} from "vitest";
import * as owner from "../lib/owner.ts";
import {
  AddPayeeEditor,
  AgentEditor,
  AllowanceEditor,
  CapsEditor,
  ExpiryEditor,
  RevokeEditor,
  VelocityEditor,
} from "../components/PolicyEditors.tsx";
import {AGENT, ENGINE, OWNER} from "./mocks.ts";

vi.mock("../lib/owner.ts", async () => (await import("./mocks.ts")).ownerWrites());
vi.mock("../lib/chain.ts", async () => (await import("./mocks.ts")).chainModule());

const writes = vi.mocked(owner);

const ID = 4n;

const policy: Policy = {
  id: ID,
  owner: OWNER,
  agent: AGENT,
  expiry: 0n,
  paused: false,
  exists: true,
  budgetCap: usdc("10"),
  spent: usdc("3"),
  perTxCap: usdc("2"),
  bucketCapacity: usdc("4"),
  refillPerSecond: usdc("96") / 86_400n,
  available: usdc("4"),
  lastRefill: 0n,
};

/** Replace a field's contents the way a person would: select all, type over it. */
async function retype(label: RegExp | string, value: string) {
  const input = screen.getByLabelText(label);
  await userEvent.clear(input);
  if (value) await userEvent.type(input, value);
  return input;
}

/** The message attached to an input, as assistive technology would read it. */
function description(input: HTMLElement): string {
  const id = input.getAttribute("aria-describedby");
  return id ? (document.getElementById(id)?.textContent ?? "") : "";
}

const save = (name: RegExp | string = /save/i) => screen.getByRole("button", {name});

describe("CapsEditor", () => {
  it("does not offer to save values that are already on chain", () => {
    render(<CapsEditor policy={policy} />);
    expect(save()).toBeDisabled();
    expect(screen.getByText("No changes")).toBeTruthy();
  });

  it("sends 6-decimal base units, never the typed number", async () => {
    render(<CapsEditor policy={policy} />);
    await retype(/lifetime budget/i, "12.5");
    await retype(/per payment/i, "0.000001");
    await userEvent.click(save());

    await waitFor(() => expect(writes.setCaps).toHaveBeenCalledOnce());
    expect(writes.setCaps).toHaveBeenCalledWith(ID, 12_500_000n, 1n);
    expect(await screen.findByText(/written to chain/i)).toBeTruthy();
  });

  it("blocks a budget below what has already been spent", async () => {
    render(<CapsEditor policy={policy} />);
    const input = await retype(/lifetime budget/i, "2");
    expect(save()).toBeDisabled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(description(input)).toMatch(/below the 3 USDC already spent/i);
  });

  it.each(["abc", "1.1234567", "-5", "1e6"])("refuses %s as an amount", async (typed) => {
    render(<CapsEditor policy={policy} />);
    await retype(/per payment/i, typed);
    expect(save()).toBeDisabled();
    expect(screen.getByText(/needs a number/i)).toBeTruthy();
  });

  it("warns, but allows, a per-payment cap larger than the budget", async () => {
    render(<CapsEditor policy={policy} />);
    await retype(/per payment/i, "50");
    expect(screen.getByText(/budget is what will bind/i)).toBeTruthy();
    expect(save()).toBeEnabled();
  });
});

describe("VelocityEditor", () => {
  it("converts a daily rate to per-second, rounding down", async () => {
    render(<VelocityEditor policy={policy} />);
    await retype(/refill per day/i, "10");
    // 10 USDC / 86,400 s = 115.74 base units a second, stored as 115.
    expect(screen.getByText(/realised rate is 9\.936 a day/i)).toBeTruthy();
    await userEvent.click(save());
    await waitFor(() => expect(writes.setVelocity).toHaveBeenCalledWith(ID, usdc("4"), 115n));
  });

  it("blocks a refill so small it would be stored as zero", async () => {
    render(<VelocityEditor policy={policy} />);
    await retype(/refill per day/i, "0.05");
    expect(screen.getByText(/rounds to zero/i)).toBeTruthy();
    expect(save()).toBeDisabled();
  });

  it("allows an explicit zero refill, with a warning", async () => {
    render(<VelocityEditor policy={policy} />);
    await retype(/refill per day/i, "0");
    expect(screen.getByText(/never comes back/i)).toBeTruthy();
    expect(save()).toBeEnabled();
  });
});

describe("ExpiryEditor", () => {
  it("treats empty as never", async () => {
    render(<ExpiryEditor policy={{...policy, expiry: 2_000_000_000n}} />);
    await retype(/expires at/i, "");
    expect(screen.getByText(/empty means never/i)).toBeTruthy();
    await userEvent.click(save());
    await waitFor(() => expect(writes.setExpiry).toHaveBeenCalledWith(ID, 0n));
  });

  it("warns that a past date stops the agent now", async () => {
    render(<ExpiryEditor policy={policy} />);
    await retype(/expires at/i, "2020-01-01T00:00");
    expect(screen.getByText(/stops the agent immediately/i)).toBeTruthy();
    expect(save()).toBeEnabled();
  });
});

describe("AgentEditor", () => {
  const rotate = () => screen.getByRole("button", {name: /rotate key/i});

  it("rotates to a fresh address", async () => {
    render(<AgentEditor policy={policy} />);
    const next = "0x1111111111111111111111111111111111111111";
    await retype(/new agent address/i, next);
    await userEvent.click(rotate());
    await waitFor(() => expect(writes.setAgent).toHaveBeenCalledWith(ID, next));
  });

  it("refuses the owner's own wallet as the agent key", async () => {
    render(<AgentEditor policy={policy} />);
    await retype(/new agent address/i, OWNER.toUpperCase().replace("0X", "0x"));
    expect(screen.getByText(/your own wallet/i)).toBeTruthy();
    expect(rotate()).toBeDisabled();
  });

  it("refuses the key that is already bound", async () => {
    render(<AgentEditor policy={policy} />);
    await retype(/new agent address/i, AGENT);
    expect(rotate()).toBeDisabled();
  });

  it("refuses something that is not an address", async () => {
    render(<AgentEditor policy={policy} />);
    await retype(/new agent address/i, "0x1234");
    expect(screen.getByText(/not a valid address/i)).toBeTruthy();
    expect(rotate()).toBeDisabled();
  });
});

describe("AllowanceEditor", () => {
  const set = () => screen.getByRole("button", {name: /set allowance/i});

  it("cuts the allowance to zero, the owner's exit", async () => {
    render(<AllowanceEditor allowance={usdc("7")} needed={usdc("7")} />);
    await retype(/approved amount/i, "0");
    await userEvent.click(set());
    await waitFor(() => expect(writes.setAllowance).toHaveBeenCalledWith(0n));
  });

  it("warns when the allowance exceeds what the policy can still spend", async () => {
    render(<AllowanceEditor allowance={usdc("7")} needed={usdc("7")} />);
    await retype(/approved amount/i, "1000");
    expect(screen.getByText(/protects nothing/i)).toBeTruthy();
  });

  it("refuses an amount beyond what the contract can store", async () => {
    render(<AllowanceEditor allowance={0n} needed={usdc("10")} />);
    await retype(/approved amount/i, "9".repeat(40));
    expect(set()).toBeDisabled();
  });
});

describe("AddPayeeEditor", () => {
  const add = () => screen.getByRole("button", {name: /allowlist/i});

  it("allowlists a valid address", async () => {
    render(<AddPayeeEditor policyId={ID} />);
    const payee = "0x2222222222222222222222222222222222222222";
    await retype(/address/i, payee);
    await userEvent.click(add());
    await waitFor(() => expect(writes.addPayee).toHaveBeenCalledWith(ID, payee));
  });

  it("refuses the policy contract itself", async () => {
    render(<AddPayeeEditor policyId={ID} />);
    await retype(/address/i, ENGINE);
    expect(screen.getByText(/destroys the funds/i)).toBeTruthy();
    expect(add()).toBeDisabled();
  });

  it("refuses the zero address", async () => {
    render(<AddPayeeEditor policyId={ID} />);
    await retype(/address/i, `0x${"0".repeat(40)}`);
    expect(add()).toBeDisabled();
  });
});

describe("RevokeEditor", () => {
  it("needs the confirmation phrase before it will delete", async () => {
    render(<RevokeEditor policyId={ID} />);
    const button = screen.getByRole("button", {name: /delete policy/i});
    expect(button).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/to confirm/i), "delet");
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/to confirm/i), "e");
    expect(button).toBeEnabled();

    await userEvent.click(button);
    await waitFor(() => expect(writes.revokePolicy).toHaveBeenCalledWith(ID));
  });
});

describe("a failed write", () => {
  it("shows the reason and does not claim success", async () => {
    writes.setCaps.mockResolvedValueOnce({ok: false, error: "You declined the signature. Nothing was changed."});
    render(<CapsEditor policy={policy} />);
    await retype(/lifetime budget/i, "20");
    await userEvent.click(save());
    expect(await screen.findByText(/you declined the signature/i)).toBeTruthy();
    expect(screen.queryByText(/written to chain/i)).toBeNull();
  });
});
