// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Markdown } from "./markdown.js";
import { tokenAmount } from "./market.js";

describe("report markdown", () => {
  it("renders sections, lists, tables and links", () => {
    const { container } = render(<Markdown source={"## 1. Executive Summary\n\nAave is **large**, see [DeFiLlama](https://defillama.com/protocol/aave-v3).\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |"} />);
    expect(container.querySelector("h3")?.textContent).toBe("1. Executive Summary");
    expect(container.querySelector("strong")?.textContent).toBe("large");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://defillama.com/protocol/aave-v3");
    expect(container.querySelector("a")?.getAttribute("rel")).toContain("noopener");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelectorAll("td")).toHaveLength(2);
  });

  it("never injects HTML or script links from a seller's report", () => {
    const { container } = render(<Markdown source={'<img src=x onerror="alert(1)"> [click](javascript:alert(1)) <script>alert(2)</script>'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
  });

  it("formats token amounts exactly", () => {
    expect(tokenAmount("2000000")).toBe("2");
    expect(tokenAmount("2500001")).toBe("2.500001");
    expect(tokenAmount(null)).toBe("—");
  });
});
