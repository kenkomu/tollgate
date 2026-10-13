import {render, screen, waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, it, vi} from "vitest";
import * as owner from "../lib/owner.ts";
import {ApprovalCard} from "../components/ApprovalCard.tsx";
import {ENGINE} from "./mocks.ts";

vi.mock("../lib/owner.ts", async () => (await import("./mocks.ts")).ownerWrites());
vi.mock("../lib/chain.ts", async () => (await import("./mocks.ts")).chainModule());

const writes = vi.mocked(owner);

/** Exactly what the SDK's approve_payee_inline tool pushes into a chat host. */
const pushed = {
  requestId: "42",
  payee: "0x5555555555555555555555555555555555555555" as const,
  amount: "$1.20",
  why: "Buy the dataset the user asked for",
};

const approve = () => screen.getByRole("button", {name: /approve payee/i});
const decline = () => screen.getByRole("button", {name: /decline/i});

describe("ApprovalCard", () => {
  it("renders the request the agent sent", () => {
    render(<ApprovalCard request={pushed} />);
    expect(screen.getByText("$1.20")).toBeTruthy();
    expect(screen.getByText(/buy the dataset/i)).toBeTruthy();
    expect(screen.getByRole("link", {name: new RegExp(pushed.payee)})).toBeTruthy();
  });

  it("answers the host with approved only after setPayee landed", async () => {
    const onDecide = vi.fn();
    render(<ApprovalCard request={pushed} onDecide={onDecide} />);
    await userEvent.click(approve());

    await waitFor(() => expect(onDecide).toHaveBeenCalledWith({decision: "approved"}));
    expect(writes.approvePayee).toHaveBeenCalledWith(pushed.payee);
    expect(screen.getByRole("status").textContent).toMatch(/allowlisted on chain/i);
    expect(screen.queryByRole("button", {name: /approve payee/i})).toBeNull();
  });

  it("does not answer the host when the signature fails", async () => {
    writes.approvePayee.mockResolvedValueOnce({ok: false, error: "You declined the signature. Nothing was changed."});
    const onDecide = vi.fn();
    render(<ApprovalCard request={pushed} onDecide={onDecide} />);
    await userEvent.click(approve());

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onDecide).not.toHaveBeenCalled();
    // Still open: the owner can try again.
    expect(approve()).toBeEnabled();
  });

  it("declines without touching the chain", async () => {
    const onDecide = vi.fn();
    render(<ApprovalCard request={pushed} onDecide={onDecide} />);
    await userEvent.click(decline());

    await waitFor(() => expect(onDecide).toHaveBeenCalledWith({decision: "declined"}));
    expect(writes.declineRequest).toHaveBeenCalledWith(pushed.payee);
    expect(writes.approvePayee).not.toHaveBeenCalled();
  });

  it("will not ask the owner to sign for the policy contract itself", () => {
    render(<ApprovalCard request={{...pushed, payee: ENGINE}} />);
    expect(screen.getByText(/destroys the funds/i)).toBeTruthy();
    expect(approve()).toBeDisabled();
    expect(decline()).toBeEnabled();
  });

  it("shows an answered request as answered, with nothing to click", () => {
    render(<ApprovalCard request={pushed} settled="declined" />);
    expect(screen.getByRole("status").textContent).toMatch(/declined/i);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
