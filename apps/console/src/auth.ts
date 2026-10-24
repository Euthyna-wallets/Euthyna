import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";
import { emailOTPClient, organizationClient } from "better-auth/client/plugins";

import { API_BASE } from "./api.js";

export const authClient = createAuthClient({
  baseURL: API_BASE,
  plugins: [passkeyClient(), emailOTPClient(), organizationClient()],
});
