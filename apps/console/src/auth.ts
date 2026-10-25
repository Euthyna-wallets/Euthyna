import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

import { API_BASE } from "./api.js";

export const authClient = createAuthClient({
  baseURL: API_BASE,
  plugins: [organizationClient()],
});
