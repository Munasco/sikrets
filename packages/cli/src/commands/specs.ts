// Command specs are plain data (after the Vercel CLI's command.ts files): they drive parsing,
// help and typo suggestions without loading any implementation. Each command's code is imported
// only when that command runs, so `sikrets ls` never pays for the browser stack.

import { ENV, REVEAL, SERVER } from "../constants.ts";

export interface OptionSpec {
  name: string;
  type: "string" | "boolean";
  /** Repeatable flag, collected into an array. */
  multiple?: boolean;
  short?: string;
  argument?: string;
  description: string;
}

export interface CommandSpec {
  name: string;
  aliases?: string[];
  description: string;
  arguments: { name: string; required: boolean }[];
  options: OptionSpec[];
  examples: string[];
  /** Everything after `--` is passed through untouched (for `run`). */
  passthrough?: boolean;
  load: () => Promise<{ run: (args: string[], opts: Record<string, unknown>) => Promise<void> }>;
}

/** Every command that talks to the Sikrets server takes it (index.ts adds it unless the command has its own --server). */
export const serverOption: OptionSpec = { name: "server", type: "string", argument: "URL", description: `Sikrets server for this run (default: ${ENV.server}, then sikrets.json, then the one you signed in to)` };

export const jsonOption: OptionSpec = { name: "json", type: "boolean", description: "Machine-readable output on stdout (for agents)" };

const dryRunOption: OptionSpec = { name: "dry-run", type: "boolean", description: "Show exactly what would change, and what it costs, without touching anything" };
const yesOption: OptionSpec = { name: "yes", type: "boolean", short: "y", description: "Skip the confirmation prompt" };
const agentOption: OptionSpec = { name: "agent", type: "string", argument: "NAME", description: "Hand keys to this agent: only its scope, refused once revoked (or set SIKRETS_AGENT)" };
const envOption: OptionSpec = { name: "env", type: "boolean", description: "Print export lines for eval \"$(…)\" instead of running a command (refused on a terminal)" };

export const commands: CommandSpec[] = [
  {
    name: "init",
    description: "Create sikrets.json for this project (name, server, env file, IaC dir, default connections)",
    arguments: [],
    options: [
      { name: "project", type: "string", argument: "NAME", description: "Project name (default: directory name)" },
      { name: "server", type: "string", argument: "URL", description: "A custom Sikrets server for this project (default: ours)" },
      jsonOption,
    ],
    examples: ["sikrets init", "sikrets init --project shop --server https://sikrets.acme.dev"],
    load: () => import("./init.ts"),
  },
  {
    name: "connect",
    description: "Link a provider account. Opens a visible browser; without --email you sign in and Sikrets saves the login to your keychain",
    arguments: [{ name: "provider", required: true }],
    options: [
      { name: "email", type: "string", argument: "EMAIL", description: "Sign in for me with this email (password is prompted)" },
      { name: "password-stdin", type: "boolean", description: "Read the password from stdin instead of prompting" },
      { name: "renew", type: "boolean", description: "Mint a fresh API key even if one is already stored" },
      { name: "profile", type: "string", argument: "PROFILE", description: "AWS only: which AWS CLI profile to use" },
      jsonOption,
    ],
    examples: ["sikrets connect openai", "sikrets connect openai --email me@acme.dev", "printf %s \"$PW\" | sikrets connect openai --email me@acme.dev --password-stdin --json"],
    load: () => import("./connect.ts"),
  },
  {
    name: "add",
    description: "Add a service to this project: plans it, provisions or declares it, and records how to undo it",
    arguments: [{ name: "provider/service", required: true }],
    options: [
      { name: "name", type: "string", argument: "NAME", description: "Resource name (default: the service name)" },
      { name: "set", type: "string", multiple: true, argument: "KEY=VALUE", description: "Set a recipe input, e.g. --set region=eu-west-1" },
      { name: "use", type: "string", multiple: true, argument: "NEED=NAME", description: "Satisfy a dependency with an existing resource" },
      { name: "value-stdin", type: "boolean", description: "Read a pasted credential from stdin instead of a hidden prompt" },
      dryRunOption,
      yesOption,
      jsonOption,
    ],
    examples: ["sikrets add anthropic/api-key", "sikrets add upstash/redis --dry-run", "sikrets add aws/ec2 --name web --set size=t4g.micro", "sikrets add aws/ec2 --name worker --use network=main --yes --json"],
    load: () => import("./add.ts"),
  },
  {
    name: "apply",
    description: "Create everything declared in iac/terraform, then publish its outputs to the vault",
    arguments: [],
    options: [{ ...dryRunOption, description: "Run terraform plan only" }, { ...yesOption, description: "Don't ask terraform for approval" }, jsonOption],
    examples: ["sikrets apply --dry-run", "sikrets apply --yes"],
    load: () => import("./apply.ts"),
  },
  {
    name: "run",
    description: "Run a command with this project's values as environment variables (nothing written, nothing printed)",
    arguments: [{ name: "command", required: true }],
    options: [{ name: "providers", type: "boolean", description: "Also inject provider admin credentials (for terraform)" }, agentOption],
    examples: ["sikrets run -- bun dev", "sikrets run --providers -- terraform plan", "sikrets run --agent reviewer -- claude"],
    passthrough: true,
    load: () => import("./run.ts"),
  },
  {
    name: "mcp",
    description: "Serve this project to an AI agent over MCP (stdio): it can run commands with secrets but never sees them",
    arguments: [],
    options: [
      { name: "allow", type: "string", multiple: true, argument: "PROGRAM", description: "Only let the agent run these programs (repeatable; default: any)" },
      { name: "root", type: "string", argument: "DIR", description: "Project directory (default: current directory)" },
      { name: "agent", type: "string", argument: "NAME", description: "Name this agent for login approvals (default: the name its client reports)" },
      { name: "browser", type: "string", argument: "URL", description: "DevTools endpoint of the agent's Chrome for `login` (default: http://127.0.0.1:9222)" },
    ],
    examples: ["sikrets mcp", "sikrets mcp --allow bun --allow terraform", "claude mcp add sikrets -- sikrets mcp"],
    load: () => import("./mcp.ts"),
  },
  {
    name: "logins",
    description: "Website logins agents can sign in with but never see (add, ls, rm, grants, revoke)",
    arguments: [{ name: "add|ls|rm|grants|revoke", required: false }, { name: "name", required: false }, { name: "url", required: false }],
    options: [
      { name: "username", type: "string", argument: "USER", description: "add: the username or email (prompted when missing)" },
      { name: "totp", type: "boolean", description: "add: also store a 2FA secret (otpauth:// URI or base32), prompted hidden" },
      { name: "password-stdin", type: "boolean", description: "add: read the password from stdin instead of a hidden prompt" },
      { name: "agent", type: "string", argument: "NAME", description: "revoke: only this agent's grant (default: every agent's)" },
      jsonOption,
    ],
    examples: [
      "sikrets logins add github https://github.com --username me@acme.dev --totp",
      "sikrets logins ls",
      "sikrets logins grants",
      "sikrets logins revoke github --agent claude-code",
      "sikrets logins rm github",
    ],
    load: () => import("./logins.ts"),
  },
  {
    name: "get",
    description: "Print a key's stand-in (safe to script and share); --real or --copy reveal the value after Touch ID",
    arguments: [{ name: "KEY", required: true }],
    options: [
      { name: "real", type: "boolean", description: "Print the real value, after you authenticate with Touch ID or your Mac password" },
      { name: "copy", type: "boolean", description: `Copy the real value to the clipboard after you authenticate; cleared after ${REVEAL.clipboardClearSeconds}s` },
      jsonOption,
    ],
    examples: ["sikrets get ANTHROPIC_API_KEY", "export ANTHROPIC_API_KEY=$(sikrets get ANTHROPIC_API_KEY)", "sikrets get ANTHROPIC_API_KEY --copy"],
    load: () => import("./get.ts"),
  },
  {
    name: "env",
    description: "List which values this project has (names only), or `env pull` them into a git-ignored .env",
    arguments: [{ name: "pull", required: false }],
    options: [
      { name: "file", type: "string", argument: "FILE", description: "Where `env pull` writes (default: .env)" },
      { name: "real", type: "boolean", short: "r", description: "Write real secrets instead of stand-ins, after you authenticate with Touch ID or your Mac password" },
      { name: "project-key", type: "boolean", description: "Also write SIKRETS_PROJECT_KEY, which lets a deployed app's SDK open this project's sealed values (after Touch ID)" },
      jsonOption,
    ],
    examples: ["sikrets env", "sikrets env pull", "sikrets env pull --real --file .env.local", "sikrets env pull --project-key --file .env.production"],
    load: () => import("./env.ts"),
  },
  {
    name: "catalog",
    description: "Search the provider catalog and see what can be added",
    arguments: [{ name: "query", required: false }],
    options: [jsonOption],
    examples: ["sikrets catalog", "sikrets catalog redis", "sikrets catalog --json"],
    load: () => import("./catalog.ts"),
  },
  {
    name: "rotate",
    description: "Replace a resource's credential with a new one; stand-ins in the project stay the same",
    arguments: [{ name: "resource", required: true }],
    options: [
      { name: "value-stdin", type: "boolean", description: "Manual recipes: read the replacement credential from stdin" },
      dryRunOption,
      yesOption,
      jsonOption,
    ],
    examples: ["sikrets rotate cache --dry-run", "sikrets rotate cache --yes", "pbpaste | sikrets rotate anthropic --value-stdin"],
    load: () => import("./rotate.ts"),
  },
  {
    name: "approvals",
    description: "Rotation requests waiting for a person: list, request, approve (Touch ID or a dialog) or deny",
    arguments: [
      { name: "list|request|approve|deny", required: false },
      { name: "resource|id", required: false },
    ],
    options: [
      { name: "reason", type: "string", argument: "exposed|expired|requested", description: "request: why the key should rotate (default: requested)" },
      { name: "queue", type: "boolean", description: "request: file it without asking now" },
      { name: "all", type: "boolean", description: "list: include decided and expired requests" },
      jsonOption,
    ],
    examples: ["sikrets approvals", "sikrets approvals request cache --reason exposed", "sikrets approvals request cache --queue --json", "sikrets approvals approve apr_1a2b3c4d", "sikrets approvals deny apr_1a2b3c4d"],
    load: () => import("./approvals.ts"),
  },
  {
    name: "recovery",
    description: "Recovery code for your vault's data key: setup shows it once, restore uses it on a new device, rotate replaces it",
    arguments: [{ name: "status|setup|restore|rotate", required: false }],
    options: [
      { name: "split", type: "boolean", description: "setup/rotate: split the code into 3 shares, any 2 restore (for emergency contacts)" },
      { name: "file", type: "string", argument: "FILE", description: "restore: the recovery record you kept (default: ~/.sikrets/recovery.json)" },
      { name: "code-stdin", type: "boolean", description: "restore: read the code, or shares one per line, from stdin" },
      { name: "force", type: "boolean", description: "restore: replace a different data key already on this device" },
      jsonOption,
    ],
    examples: ["sikrets recovery setup", "sikrets recovery setup --split", "sikrets recovery restore --file ./recovery.json", "sikrets recovery rotate"],
    load: () => import("./recovery.ts"),
  },
  {
    name: "login",
    description: "Sign this device in: registers its key (Secure Enclave on a Mac) after you approve in the browser; requests are then signed by the device",
    arguments: [],
    options: [
      { name: "server", type: "string", argument: "URL", description: `Sign in to this server and remember it (default: ${ENV.server}, sikrets.json, the remembered one, then ours)` },
      { name: "no-browser", type: "boolean", description: "Print the approval link instead of opening it" },
      jsonOption,
    ],
    examples: ["sikrets login", `sikrets login --server http://${SERVER.localHost}:${SERVER.localPort} --no-browser`],
    load: () => import("./login.ts"),
  },
  {
    name: "logout",
    description: "Revoke this device on the server and forget the sign-in (the device key stays, it also protects your vault)",
    arguments: [],
    options: [jsonOption],
    examples: ["sikrets logout"],
    load: () => import("./logout.ts"),
  },
  {
    name: "devices",
    description: "This device's key (hardware-bound or not) and every device signed in to your account; revoke one",
    arguments: [
      { name: "list|revoke", required: false },
      { name: "id", required: false },
    ],
    options: [jsonOption],
    examples: ["sikrets devices", "sikrets devices revoke dev_1a2b3c", "sikrets devices --json"],
    load: () => import("./devices.ts"),
  },
  {
    name: "server",
    description: "Run a local development server on this machine (SQLite in ~/.sikrets, not for production): it stores only ciphertext and signs you in automatically",
    arguments: [],
    options: [
      { name: "port", type: "string", argument: "PORT", description: `Port on ${SERVER.localHost} (default: ${SERVER.localPort})` },
      { name: "data", type: "string", argument: "DIR", description: `Where the database lives (default: ~/.sikrets/${SERVER.dataDir})` },
    ],
    examples: ["sikrets server", "sikrets server --port 4900 --data ./sikrets-data", `sikrets login --server http://${SERVER.localHost}:${SERVER.localPort}`],
    load: () => import("./server.ts"),
  },
  {
    name: "migrate",
    description: "Move values from the old SSM or keychain vault to the Sikrets server (dry run unless --apply; names only)",
    arguments: [],
    options: [
      { name: "from", type: "string", argument: "ssm|keychain", description: `Where the values are now (default: "vault" in sikrets.json, else ssm)` },
      { name: "apply", type: "boolean", description: "Upload them; without it nothing changes" },
      jsonOption,
    ],
    examples: ["sikrets migrate", "sikrets migrate --apply", "sikrets migrate --from keychain --apply --json"],
    load: () => import("./migrate.ts"),
  },
  {
    name: "unlock",
    description: "Sign in to a password manager CLI (Bitwarden/Vaultwarden or 1Password) and keep the session in your keychain",
    arguments: [{ name: "manager", required: true }],
    options: [
      { name: "server", type: "string", argument: "URL", description: "Bitwarden only: a self-hosted server such as Vaultwarden" },
      { name: "email", type: "string", argument: "EMAIL", description: "Account to sign in as" },
      { name: "password-stdin", type: "boolean", description: "Read the master password from stdin instead of prompting" },
      { name: "lock", type: "boolean", description: "Lock the manager and forget the session instead" },
      { name: "status", type: "boolean", description: "Show whether the manager is unauthenticated, locked, expired or unlocked" },
      jsonOption,
    ],
    examples: ["sikrets unlock bitwarden", "sikrets unlock vaultwarden --server https://vault.acme.dev --email me@acme.dev", "sikrets unlock 1password", "sikrets unlock bitwarden --lock", "sikrets unlock bitwarden --status --json"],
    load: () => import("./unlock.ts"),
  },
  {
    name: "link",
    description: "Link a key to a password manager item: copies its value into the vault, and rotations write back to it",
    arguments: [{ name: "key", required: false }, { name: "ref", required: false }],
    options: [
      { name: "remove", type: "boolean", description: "Unlink the key (its value stays in the vault)" },
      { name: "push", type: "boolean", description: "Retry write-backs that failed after a rotation" },
      { name: "force", type: "boolean", description: "With --remove: unlink even though a write-back is pending" },
      jsonOption,
    ],
    examples: ["sikrets link", "sikrets link STRIPE_KEY op://Dev/Stripe/credential", "sikrets link GITHUB_TOKEN bw://<item id>/password", "sikrets link --push", "sikrets link GITHUB_TOKEN --remove"],
    load: () => import("./link.ts"),
  },
  {
    name: "import",
    description: "Import values from a .env file, a password manager or browser export, or straight from Bitwarden/1Password (names shown, never values)",
    arguments: [{ name: "file|manager", required: true }],
    options: [
      { name: "format", type: "string", argument: "FORMAT", description: "Skip detection: dotenv, apple, chrome, firefox, 1password-csv, bitwarden-csv, bitwarden-json, 1pux" },
      { name: "prefix", type: "string", argument: "PREFIX", description: "Prepend to every imported key name" },
      { name: "expect", type: "string", argument: "DIGEST", description: "Import only if the list still matches this --dry-run --json digest" },
      dryRunOption,
      yesOption,
      jsonOption,
    ],
    examples: ["sikrets import .env", "sikrets import ~/Downloads/Passwords.csv --dry-run", "sikrets import bitwarden --prefix BW", "sikrets import export.1pux --yes"],
    load: () => import("./import.ts"),
  },
  {
    name: "rollback",
    description: "Undo an add: delete what it created, remove its credentials and generated files",
    arguments: [{ name: "operation", required: false }],
    options: [dryRunOption, yesOption, jsonOption],
    examples: ["sikrets rollback --dry-run", "sikrets rollback op_m2x7k1 --yes"],
    load: () => import("./rollback.ts"),
  },
  {
    name: "cost",
    description: "Spend for everything in this project: live where the provider reports it, otherwise estimated",
    arguments: [],
    options: [jsonOption],
    examples: ["sikrets cost", "sikrets cost --json"],
    load: () => import("./cost.ts"),
  },
  {
    name: "status",
    description: "Every resource in this project: state, when its keys were last used, and cost",
    arguments: [],
    options: [jsonOption],
    examples: ["sikrets status", "sikrets status --json"],
    load: () => import("./status.ts"),
  },
  {
    name: "activity",
    aliases: ["log"],
    description: "What happened in this project and who did it (key names only, never values)",
    arguments: [],
    options: [{ name: "limit", type: "string", argument: "N", description: "How many entries (default 20)" }, jsonOption],
    examples: ["sikrets activity", "sikrets activity --limit 100 --json"],
    load: () => import("./activity.ts"),
  },
  {
    name: "inventory",
    description: "Every stored key: age, last rotated, last used, which apps and agents used it; flags stale and over-scoped keys",
    arguments: [],
    options: [{ name: "offline", type: "boolean", description: "Skip checks that call a provider (GitHub token scopes)" }, jsonOption],
    examples: ["sikrets inventory", "sikrets inventory --offline --json"],
    load: () => import("./inventory.ts"),
  },
  {
    name: "agent",
    aliases: ["agents"],
    description: "Scoped identities for agents (add, list, revoke): which keys each may use, and until when",
    arguments: [{ name: "add|list|revoke", required: false }, { name: "name", required: false }],
    options: [
      { name: "key", type: "string", multiple: true, argument: "RESOURCE|KEY", description: "add: a resource or key name the agent may use (repeatable)" },
      { name: "expires", type: "string", argument: "DURATION", description: "add: the identity stops working after this, e.g. 7d" },
      jsonOption,
    ],
    examples: ["sikrets agent add reviewer --key github-app --expires 7d", "sikrets agent list", "sikrets agent revoke reviewer"],
    load: () => import("./agent.ts"),
  },
  {
    name: "offboard",
    description: "Rotate every key a person or agent was handed (from the local usage log), one at a time",
    arguments: [{ name: "person-or-agent", required: true }],
    options: [{ ...dryRunOption, description: "List the keys and what would be rotated, without changing anything" }, { ...yesOption, description: "Rotate all without asking for each" }, jsonOption],
    examples: ["sikrets offboard reviewer --dry-run", "sikrets offboard alice"],
    load: () => import("./offboard.ts"),
  },
  {
    name: "aws",
    description: "`aws session`: 15–60 minute AWS credentials from a stored key or the connected profile",
    arguments: [{ name: "session", required: true }],
    options: [
      { name: "role", type: "string", argument: "ARN", description: "Assume this role (AssumeRole) instead of a session for the key itself" },
      { name: "for", type: "string", argument: "DURATION", description: "15m to 60m (default 60m)" },
      { name: "key", type: "string", argument: "NAME", description: "Which stored aws/access-key (default: the only one, else the connected profile)" },
      { name: "region", type: "string", argument: "REGION", description: "STS region (default: AWS_REGION or us-east-1)" },
      envOption,
      agentOption,
    ],
    examples: ["sikrets aws session -- aws s3 ls", 'eval "$(sikrets aws session --for 15m --env)"', "sikrets aws session --role arn:aws:iam::123456789012:role/deploy -- terraform plan"],
    passthrough: true,
    load: () => import("./aws.ts"),
  },
  {
    name: "github",
    description: "`github token`: a one-hour GitHub App installation token from a stored App private key",
    arguments: [{ name: "token", required: true }],
    options: [
      { name: "repo", type: "string", multiple: true, argument: "NAME", description: "Limit the token to this repository (repeatable)" },
      { name: "permission", type: "string", multiple: true, argument: "NAME=LEVEL", description: "Limit the token's permissions, e.g. contents=read (repeatable)" },
      { name: "installation", type: "string", argument: "ID", description: "Installation id (default: the one stored with the key)" },
      { name: "key", type: "string", argument: "NAME", description: "Which stored github/app-key (default: the only one)" },
      envOption,
      agentOption,
    ],
    examples: ["sikrets github token --repo api --permission contents=read -- gh pr list", 'eval "$(sikrets github token --env)"'],
    passthrough: true,
    load: () => import("./github.ts"),
  },
  {
    name: "ls",
    aliases: ["list"],
    description: "List connected providers",
    arguments: [],
    options: [jsonOption],
    examples: ["sikrets ls", "sikrets ls --json"],
    load: () => import("./ls.ts"),
  },
];

export const findCommand = (name: string) => commands.find((c) => c.name === name || c.aliases?.includes(name));
