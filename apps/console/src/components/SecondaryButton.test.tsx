import { describe, expect, it } from "vitest";

import { SECONDARY_BUTTON_COLORS } from "./SecondaryButton.js";

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

describe("secondary button contrast", () => {
  it("meets WCAG AA (>= 4.5:1)", () => {
    expect(contrast(SECONDARY_BUTTON_COLORS.fg, SECONDARY_BUTTON_COLORS.bg)).toBeGreaterThanOrEqual(4.5);
  });
});
