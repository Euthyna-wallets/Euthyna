/** « Now make it yours. »: the wallet, asked for only here, signs the score and claims the $LEASH trophy. Handoff: section CLAIM + FORK, left column. */
import { BRAND } from "./shared.js";
import type { Throwaway } from "./shared.js";

export function RobClaim(_props: { throwaway: Throwaway | null }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <span className="kick" style={{ color: "#F2B544" }}>You lost. Fairly.</span>
      <h2 style={{ margin: 0, font: `900 clamp(34px,4.2vw,58px)/1.02 ${BRAND}`, letterSpacing: ".04em", color: "#F3EFE6" }}>
        NOW MAKE IT <span className="leaf">YOURS.</span>
      </h2>
      <p style={{ margin: 0, fontSize: 17, lineHeight: 1.6, color: "#A9B6D6" }}>
        The law that just beat you is a role in a vault, voted by a DAO. Give your own agents the same one: they can be hacked, the money
        still follows the law.
      </p>
    </div>
  );
}
