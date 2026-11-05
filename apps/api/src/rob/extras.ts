/**
 * Rob the Agent: the sections around the cards (Hire him, the claim and Hall of thieves, Rug O'Clock).
 * Each lives in its own module and registers its routes here, after the cards' routes.
 */
import type { Hono } from "hono";

import type { RobLimiters } from "./routes.js";
import type { RobService } from "./service.js";

export type RobExtrasContext = { rob: RobService; limiters: RobLimiters; trustProxy: boolean };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerRobExtras(_app: Hono<any>, _context: RobExtrasContext) {
  // registerHireRoutes(app, context);
  // registerHallRoutes(app, context);
  // registerRugOClockRoutes(app, context);
}
