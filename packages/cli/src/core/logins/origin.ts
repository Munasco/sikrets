import { LOGINS } from "../../constants.ts";

// The anti-phishing check. A login is bound to one origin (scheme, host, port), and Sikrets fills
// it only into a page whose origin is exactly that one. No subdomain, parent domain, other scheme
// or other port matches. The URL parser does the normalizing: it lowercases, turns Unicode hosts
// into punycode (so a Cyrillic "а" can't pass for a Latin "a") and drops default ports.

/** The origin a stored login is bound to, e.g. "https://github.com". Throws on anything else. */
export function loginOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    throw new Error(`"${input}" isn't a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Logins are for websites (https://…), not ${url.protocol}`);
  if (url.username || url.password) throw new Error("The URL can't contain a username or password");
  if (url.protocol === "http:" && !(LOGINS.loopbackHosts as readonly string[]).includes(url.hostname)) {
    throw new Error(`${url.origin} isn't https. Only local servers (localhost, 127.0.0.1) may use http`);
  }
  return url.origin;
}

/** True only when `pageUrl` is on exactly `origin`. Opaque pages (about:, data:, file:) never match. */
export function sameOrigin(pageUrl: string, origin: string): boolean {
  try {
    const page = new URL(pageUrl).origin;
    return page !== "null" && page === new URL(origin).origin;
  } catch {
    return false;
  }
}
