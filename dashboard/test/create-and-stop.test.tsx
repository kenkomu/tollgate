import {render, screen, waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {usdc} from "@tollgate/shared";
import {describe, expect, it, vi} from "vitest";
import * as owner from "../lib/owner.ts";
import {CreatePolicy, TEMPLATES} from "../components/CreatePolicy.tsx";
import {FleetSwitch, KillSwitch} from "../components/KillSwitch.tsx";
import {ApprovalQueue} from "../components/ApprovalQueue.tsx";
import {OWNER} from "./mocks.ts";

vi.mock("../lib/owner.ts", async () => (await import("./mocks.ts")).ownerWrites());
vi.mock("../lib/chain.ts", async () => (await import("./mocks.ts")).chainModule());

const writes = vi.mocked(owner);
const AGENT = "0x3333333333333333333333333333333333333333";
const create = () => screen.getByRole("button", {name: /approve and create/i});

describe("CreatePolicy", () => {
  it("waits for an agent address before it can submit", () => {
    render(<CreatePolicy />);
    expect(create()).toBeDisabled();
  });

  it("creates with the typed limits, in base units, never expiring", async () => {
    render(<CreatePolicy />);
    await userEvent.type(screen.getByLabelText(/agent address/i), AGENT);
    await userEvent.click(create());

    await waitFor(() => expect(writes.createPolicy).toHaveBeenCalledOnce());
    expect(writes.createPolicy).toHaveBeenCalledWith({
      agent: AGENT,
      budgetCap: usdc("10"),
      perTxCap: usdc("2"),
      bucketCapacity: usdc("4"),
      refillPerSecond: usdc("96") / 86_400n,
      expiry: 0n,
    });
  });

  it.each(TEMPLATES.map((t) => [t.name, t] as const))("the %s template fills every limit", async (_name, template) => {
    render(<CreatePolicy />);
    const button = screen.getByRole("button", {name: new RegExp(template.name)});
    await userEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");

    await userEvent.type(screen.getByLabelText(/agent address/i), AGENT);
    await userEvent.click(create());

    await waitFor(() => expect(writes.createPolicy).toHaveBeenCalledOnce());
    const sent = writes.createPolicy.mock.calls[0]![0];
    expect(sent.budgetCap).toBe(usdc(template.budget));
    expect(sent.perTxCap).toBe(usdc(template.perTx));
    expect(sent.bucketCapacity).toBe(usdc(template.burst));
    expect(sent.refillPerSecond).toBe(usdc(template.perDay) / 86_400n);
  });

  it("every template is something the form would accept on its own", () => {
    for (const t of TEMPLATES) {
      // A template whose refill rounds to zero would ship a policy that never recovers.
      expect(usdc(t.perDay) / 86_400n).toBeGreaterThan(0n);
      expect(usdc(t.perTx) <= usdc(t.budget)).toBe(true);
      expect(usdc(t.burst) <= usdc(t.budget)).toBe(true);
    }
  });

  it("refuses the owner's own wallet as the agent", async () => {
    render(<CreatePolicy />);
    await userEvent.type(screen.getByLabelText(/agent address/i), OWNER);
    expect(screen.getByText(/your own wallet/i)).toBeTruthy();
    expect(create()).toBeDisabled();
  });

  it("refuses a refill that would be stored as zero", async () => {
    render(<CreatePolicy />);
    await userEvent.type(screen.getByLabelText(/agent address/i), AGENT);
    const perDay = screen.getByLabelText(/refill per day/i);
    await userEvent.clear(perDay);
    await userEvent.type(perDay, "0.01");
    expect(create()).toBeDisabled();
  });
});

describe("KillSwitch", () => {
  it("stops a running agent in one click", async () => {
    render(<KillSwitch policyId={2n} paused={false} />);
    await userEvent.click(screen.getByRole("button", {name: /stop everything/i}));
    await waitFor(() => expect(writes.setPaused).toHaveBeenCalledWith(2n, true));
    expect(await screen.findByText(/view transaction/i)).toBeTruthy();
  });

  it("resumes a stopped agent", async () => {
    render(<KillSwitch policyId={2n} paused />);
    expect(screen.getByText(/every payment from the agent is being refused/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", {name: /resume agent/i}));
    await waitFor(() => expect(writes.setPaused).toHaveBeenCalledWith(2n, false));
  });

  it("says so when the stop did not happen", async () => {
    writes.setPaused.mockResolvedValueOnce({ok: false, error: "You declined the signature. Nothing was changed."});
    render(<KillSwitch policyId={2n} paused={false} />);
    await userEvent.click(screen.getByRole("button", {name: /stop everything/i}));
    expect(await screen.findByText(/you declined the signature/i)).toBeTruthy();
    expect(screen.queryByText(/view transaction/i)).toBeNull();
  });
});

describe("FleetSwitch", () => {
  it("stops every agent in one transaction", async () => {
    render(<FleetSwitch paused={false} agents={3} />);
    expect(screen.getByText(/all 3 agents/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", {name: /stop every agent/i}));
    await waitFor(() => expect(writes.setOwnerPaused).toHaveBeenCalledWith(true));
  });

  it("resumes the fleet", async () => {
    render(<FleetSwitch paused agents={3} />);
    await userEvent.click(screen.getByRole("button", {name: /resume all agents/i}));
    await waitFor(() => expect(writes.setOwnerPaused).toHaveBeenCalledWith(false));
  });
});

describe("ApprovalQueue", () => {
  const request = {
    id: "1",
    serviceId: "weather",
    serviceName: "Weather API",
    payee: "0x4444444444444444444444444444444444444444" as const,
    amount: "$0.05",
    why: "Forecast for the trip",
    policyId: "3",
    requestedAt: 0,
  };

  it("approving allowlists the payee for the agent that asked", async () => {
    render(<ApprovalQueue requests={[request]} agents={[1n, 3n]} />);
    expect(screen.getByText(/for agent 3/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", {name: /approve payee/i}));
    await waitFor(() => expect(writes.approvePayee).toHaveBeenCalledWith(3n, request.payee, "1"));
  });

  it("declining writes nothing on chain", async () => {
    render(<ApprovalQueue requests={[request]} agents={[3n]} />);
    await userEvent.click(screen.getByRole("button", {name: /decline/i}));
    await waitFor(() => expect(writes.declineRequest).toHaveBeenCalledWith(request.payee, 3n, "1"));
    expect(writes.approvePayee).not.toHaveBeenCalled();
  });

  it("a request that names no agent waits for the owner to pick one", async () => {
    render(<ApprovalQueue requests={[{...request, policyId: null}]} agents={[1n, 3n]} />);
    const approve = screen.getByRole("button", {name: /approve payee/i});
    expect(approve).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText(/which agent/i), "1");
    expect(approve).toBeEnabled();
    await userEvent.click(approve);
    await waitFor(() => expect(writes.approvePayee).toHaveBeenCalledWith(1n, request.payee, "1"));
  });

  it("with a single agent, an unnamed request goes to it", async () => {
    render(<ApprovalQueue requests={[{...request, policyId: null}]} agents={[5n]} />);
    expect(screen.queryByLabelText(/which agent/i)).toBeNull();
    await userEvent.click(screen.getByRole("button", {name: /approve payee/i}));
    await waitFor(() => expect(writes.approvePayee).toHaveBeenCalledWith(5n, request.payee, "1"));
  });

  it("shows an empty queue as nothing waiting", () => {
    render(<ApprovalQueue requests={[]} />);
    expect(screen.getByText(/nothing waiting on you/i)).toBeTruthy();
  });
});
