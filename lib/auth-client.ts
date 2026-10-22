import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import { convexClient, crossDomainClient } from "@convex-dev/better-auth/client/plugins";

// Sikrets signs in against the shared Tennant auth server (Better Auth on Convex).
// crossDomainClient keeps the session in a header instead of a cookie, so
// sikrets.usetennant.com works without sharing cookies with the main app.
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_CONVEX_SITE_URL,
  plugins: [convexClient(), crossDomainClient(), emailOTPClient(), passkeyClient()],
});
