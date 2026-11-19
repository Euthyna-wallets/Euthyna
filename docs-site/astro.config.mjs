// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://docs.euthyna.io",
  integrations: [
    starlight({
      title: "Euthyna Docs",
      description: "Give AI agents money. Never the keys. How Euthyna's vault, roles, bank account and proofs work.",
      logo: {
        light: "./src/assets/euthyna-mark-on-light.svg",
        dark: "./src/assets/euthyna-mark-on-dark.svg",
      },
      favicon: "/favicon.svg",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/Euthyna-wallets/Euthyna" },
        { icon: "x.com", label: "X", href: "https://x.com/Euthyna_io" },
      ],
      customCss: ["./src/styles/euthyna.css"],
      lastUpdated: false,
      sidebar: [
        { label: "Start here", items: [{ label: "Overview", link: "/" }] },
        { label: "Concepts", items: [{ slug: "concepts/architecture", label: "Architecture" }] },
        {
          label: "Features",
          items: [
            { slug: "features/bank", label: "Euro bank account" },
            { slug: "features/shares", label: "Shares" },
            { slug: "features/recovery", label: "Seat recovery" },
            { slug: "features/sealed-orders", label: "Sealed orders" },
            { slug: "features/sponsored-gas", label: "Sponsored gas" },
            { slug: "features/market", label: "Market" },
            { slug: "features/registry", label: "Public directory" },
          ],
        },
        {
          label: "Security",
          items: [
            { slug: "security/attacks", label: "Attack suite" },
            { slug: "security/rob-the-agent", label: "Rob the Agent" },
            { slug: "security/evidence", label: "Evidence" },
            { slug: "security/claims", label: "Claims and proof" },
          ],
        },
        { label: "Reference", items: [{ slug: "reference/api", label: "API" }] },
      ],
    }),
  ],
});
