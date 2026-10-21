// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FourEyesActions } from "./FourEyesActions.js";

afterEach(cleanup);

describe("FourEyesActions", () => {
  it("disables approve and reject for the author", () => {
    render(<FourEyesActions authorId="user-1" currentUserId="user-1" pending={false} onDecide={() => undefined} />);
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Waiting for another member")).toBeTruthy();
  });

  it("enables decisions for another member", () => {
    render(<FourEyesActions authorId="user-1" currentUserId="user-2" pending={false} onDecide={() => undefined} />);
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
