import { createPrivateKey, createSign } from "node:crypto";
import { redact, Secret } from "./secret.ts";
import { GITHUB, USER_AGENT } from "../constants.ts";

// GitHub App installation tokens: the App's long-lived private key stays in the vault and signs a
// ten-minute JWT, which GitHub exchanges for an installation token that expires in an hour. The
// token can be narrowed further to some repositories and permissions.

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** Throws unless `pem` is an RSA private key (GitHub issues PKCS#1 PEM; PKCS#8 works too). */
export function checkAppKey(pem: Secret) {
  let type: string | undefined;
  try {
    type = createPrivateKey(pem.reveal()).asymmetricKeyType;
  } catch {
    throw new Error("That isn't a readable private key; paste the whole .pem file GitHub downloaded");
  }
  if (type !== "rsa") throw new Error(`GitHub App keys are RSA; this one is ${type}`);
}

/** RS256 JWT identifying the App itself. */
export function appJwt(appId: string, pem: Secret, now = Date.now()): Secret {
  const iat = Math.floor(now / 1000) - GITHUB.jwtBackdateSeconds;
  const body = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat, exp: iat + GITHUB.jwtLifetimeSeconds, iss: appId }))}`;
  const signature = createSign("RSA-SHA256").update(body).sign(createPrivateKey(pem.reveal()));
  return Secret.of(`${body}.${b64url(signature)}`);
}

export interface InstallationToken {
  token: Secret;
  expiresAt: string;
  permissions: Record<string, string>;
  repositories: "all" | "selected";
}

export async function installationToken(o: {
  appId: string;
  installationId: string;
  key: Secret;
  repositories?: readonly string[];
  permissions?: Readonly<Record<string, string>>;
}): Promise<InstallationToken> {
  const jwt = appJwt(o.appId, o.key);
  const body = { ...(o.repositories?.length ? { repositories: o.repositories } : {}), ...(o.permissions && Object.keys(o.permissions).length ? { permissions: o.permissions } : {}) };
  const res = await fetch(`${GITHUB.api}/app/installations/${encodeURIComponent(o.installationId)}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt.reveal()}`, Accept: GITHUB.accept, "X-GitHub-Api-Version": GITHUB.apiVersion, "User-Agent": USER_AGENT, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) throw new Error("GitHub rejected the App's JWT (401): check the app id and that the private key hasn't been deleted");
  if (res.status === 404) throw new Error(`GitHub has no installation ${o.installationId} for app ${o.appId} (404)`);
  if (!res.ok) {
    const text = redact(await res.text().catch(() => ""), [jwt, o.key]);
    const message = (() => {
      try {
        return (JSON.parse(text) as { message?: string }).message;
      } catch {
        return undefined;
      }
    })();
    throw new Error(`GitHub refused the token request: HTTP ${res.status}${message ? ` (${message})` : ""}`);
  }
  const out = (await res.json()) as { token?: string; expires_at?: string; permissions?: Record<string, string>; repository_selection?: "all" | "selected" };
  if (!out.token || !out.expires_at) throw new Error("GitHub's response had no token");
  return { token: Secret.of(out.token), expiresAt: out.expires_at, permissions: out.permissions ?? {}, repositories: out.repository_selection ?? "all" };
}
