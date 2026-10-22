# Sikrets

A home for your projects' secrets and connections. Provision access, connect services, and rotate credentials—all in one place.

Sikrets is a Tennant product served at **sikrets.usetennant.com**. It has its own frontend but shares Tennant's backend: accounts, workspaces, the vault, and connected services all live in the shared Convex deployment (`@tennantcloud/convex`).

## How it fits together

- **Sign-in** uses Tennant's Better Auth server on Convex via the `crossDomain` plugin, so the same Tennant account works here without shared cookies.
- **Secrets** are end-to-end encrypted in the browser (`lib/vault.ts`, a port of the Tennant CLI's vault). A password-derived key (PBKDF2, 600k iterations) unwraps the workspace master key (AES-256-GCM); Convex only stores ciphertext and plaintext metadata.
- **Projects** are derived from the `product` field on vault secrets (`<project>/<resource>`), so anything synced by `tennant link` shows up automatically.
- **Connections** are read from the workspace's connected accounts.

## Development

```bash
bun install
cp .env.example .env.local   # point at the shared Tennant Convex deployment
bun dev --port 3001
```

### Backend setup (in the Tennant Convex repo)

Add Sikrets' origins to the auth allow list so sign-in redirects back here:

```bash
npx convex env set AUTH_ALLOWED_ORIGINS "https://sikrets.usetennant.com,http://localhost:3001"
```

(Append to the existing value if other frontends are already listed.)
