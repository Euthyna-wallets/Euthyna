import type { ButtonHTMLAttributes, ReactNode } from "react";

export const SECONDARY_BUTTON_COLORS = {
  fg: "#0f172a",
  bg: "#ffffff",
  border: "#cbd2da",
} as const;

export function SecondaryButton({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      {...props}
      className="secondary"
      style={{
        color: SECONDARY_BUTTON_COLORS.fg,
        background: SECONDARY_BUTTON_COLORS.bg,
        border: `1px solid ${SECONDARY_BUTTON_COLORS.border}`,
      }}
    >
      {children}
    </button>
  );
}
