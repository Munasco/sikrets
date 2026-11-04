import { AGENT_ROLE, AWS_STACK, CLOUD, ENV } from "../constants.ts";

// Command specs are plain data (after the Vercel CLI's command.ts files): they drive parsing,
// help and typo suggestions without loading any implementation. Each command's code is imported
// only when that command runs, so `sikrets ls` never pays for the browser stack.

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

export const jsonOption: OptionSpec = { name: "json", type: "boolean", description: "Machine-readable output on stdout (for agents)" };

const dryRunOption: OptionSpec = { name: "dry-run", type: "boolean", description: "Show exactly what would change, and what it costs, without touching anything" };
const yesOption: OptionSpec = { name: "yes", type: "boolean", short: "y", description: "Skip the confirmation prompt" };
const agentOption: OptionSpec = { name: "agent", type: "string", argument: "NAME", description: "Hand keys to this agent: only its scope, refused once revoked (or set SIKRETS_AGENT)" };
const envOption: OptionSpec = { name: "env", type: "boolean", description: "Print export lines for eval \"$(…)\" instead of running a command (refused on a terminal)" };

export const commands: CommandSpec[] = [
  {
    name: "init",
    description: "Create sikrets.json for this project (name, vault, env file, IaC dir, default connections)",
    arguments: [],
    options: [
      { name: "project", type: "string", argument: "NAME", description: "Project name (default: directory name)" },
      { name: "vault", type: "string", argument: "ssm|keychain|aws", description: "Where secrets live (default: ssm; aws: your self-hosted stack, see sikrets cloud connect)" },
      jsonOption,
    ],
    examples: ["sikrets init", "sikrets init --project shop --vault keychain"],
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
    name: "env",
    description: "List which values this project has (names only), or `env pull` them into a git-ignored .env",
    arguments: [{ name: "pull", required: false }],
    options: [
      { name: "file", type: "string", argument: "FILE", description: "Where `env pull` writes (default: .env)" },
      { name: "real", type: "boolean", short: "r", description: "Write real secrets instead of stand-ins" },
      { name: "project-key", type: "boolean", description: "Also write SIKRETS_PROJECT_KEY, which lets a deployed app's SDK open this project's values" },
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
    name: "migrate",
    description: "Encrypt this project's existing plaintext values in SSM with your data key, in place (safe to re-run)",
    arguments: [{ name: "encrypt", required: true }],
    options: [
      dryRunOption,
      { name: "purge-history", type: "boolean", description: "Delete and recreate each parameter so SSM's version history drops the plaintext" },
      yesOption,
      jsonOption,
    ],
    examples: ["sikrets migrate encrypt --dry-run", "sikrets migrate encrypt", "sikrets migrate encrypt --purge-history --yes"],
    load: () => import("./migrate.ts"),
  },
  {
    name: "backup",
    description: "Encrypted backup of this project's values plus your logins and links: create, verify or restore",
    arguments: [
      { name: "create|verify|restore", required: true },
      { name: "file", required: false },
    ],
    options: [
      { name: "passphrase", type: "boolean", description: "Seal with a passphrase (Argon2id) instead of your data key, so it opens anywhere" },
      { name: "passphrase-stdin", type: "boolean", description: "Read the passphrase from stdin instead of prompting" },
      { name: "dir", type: "string", argument: "DIR", description: "create: write a timestamped file into this folder (for cron)" },
      { name: "keep", type: "string", argument: "N", description: "create --dir: keep the newest N backups there (default 14)" },
      { name: "no-logins", type: "boolean", description: "create: leave provider logins out" },
      { name: "force", type: "boolean", description: "restore: into a project with a different name" },
      dryRunOption,
      jsonOption,
    ],
    examples: [
      "sikrets backup create",
      "sikrets backup create backup.sikrets-backup --passphrase",
      "sikrets backup create --dir ~/Backups/sikrets --keep 30",
      "sikrets backup verify backup.sikrets-backup",
      "sikrets backup restore backup.sikrets-backup --dry-run",
    ],
    load: () => import("./backup.ts"),
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
    description: "Scoped identities for agents (add, list, revoke). With a cloud vault each gets its own cloud identity; `agent role` hands out its short-lived credentials",
    arguments: [{ name: "add|list|revoke|role", required: false }, { name: "name", required: false }],
    options: [
      { name: "key", type: "string", multiple: true, argument: "RESOURCE|KEY", description: "add: a resource or key name the agent may use (repeatable)" },
      { name: "expires", type: "string", argument: "DURATION", description: "add: the identity stops working after this, e.g. 7d" },
      { name: "allow", type: "string", multiple: true, argument: "ACTION[,ACTION]=RESOURCE", description: "add, role: extra cloud permissions for the agent, e.g. s3:GetObject=arn:aws:s3:::logs/* (repeatable; replaces earlier ones)" },
      { name: "ttl", type: "string", argument: "DURATION", description: `role: how long the credentials last, 15m to 60m (default ${AGENT_ROLE.defaultTtl})` },
      { name: "revoke", type: "boolean", description: "role: delete the agent's role" },
      { name: "profile", type: "string", argument: "PROFILE", description: "role: local CLI profile to issue the credentials with" },
      { name: "provider", type: "string", argument: "aws", description: "role: which cloud stack (default: the connected one)" },
      envOption,
      jsonOption,
    ],
    examples: [
      "sikrets agent add reviewer --key github-app --expires 7d",
      "sikrets agent add reporter --key warehouse --allow s3:GetObject=arn:aws:s3:::reports/*",
      "sikrets agent list",
      "sikrets agent revoke reviewer",
      "sikrets agent role reporter --allow s3:GetObject,s3:ListBucket=arn:aws:s3:::reports/* --ttl 30m -- aws s3 ls s3://reports",
      'eval "$(sikrets agent role reporter --env)"',
      "sikrets agent role reporter --revoke",
    ],
    passthrough: true,
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
    name: "cloud",
    description: "Self-host Sikrets in your own cloud account: `cloud connect` deploys the vault, agent guardrails and audit events; `cloud disconnect` removes them",
    arguments: [{ name: "connect|disconnect", required: true }],
    options: [
      { name: "provider", type: "string", argument: "aws", description: `Which cloud (default ${CLOUD.defaultProvider}; GCP is planned)` },
      { name: "region", type: "string", argument: "REGION", description: "Region for the stack (default: AWS_REGION or us-east-1)" },
      { name: "profile", type: "string", argument: "PROFILE", description: "Local CLI profile to deploy with (default: the connected one)" },
      { name: "stack", type: "string", argument: "NAME", description: `connect: stack name (default ${AWS_STACK.defaultName})` },
      { name: "github-repo", type: "string", argument: "OWNER/REPO", description: "connect: give this repo's GitHub Actions an agent identity via OIDC (\"\" removes it)" },
      { name: "github-oidc-exists", type: "boolean", description: "connect: the account already trusts GitHub's OIDC issuer" },
      { name: "broker-account", type: "string", argument: "ACCOUNT_ID", description: `connect: optional, off by default: let a Sikrets service in this account manage agents ("${AWS_STACK.noBroker}" removes it)` },
      { name: "link", type: "boolean", description: "connect: print a console link that deploys the stack, instead of deploying" },
      { name: "template-url", type: "string", argument: "URL", description: `connect --link: use a template published somewhere else (or set ${ENV.stackTemplateUrl})` },
      { ...yesOption, description: "disconnect: skip the confirmation prompt" },
      jsonOption,
    ],
    examples: [
      "sikrets cloud connect --provider aws",
      "sikrets cloud connect --provider aws --region eu-west-1 --profile admin --github-repo acme/api",
      "sikrets cloud connect --provider aws --link",
      "sikrets cloud disconnect --yes",
    ],
    load: () => import("./cloud.ts"),
  },
  {
    name: "aws",
    description: "`aws connect|disconnect`: same as `cloud connect|disconnect --provider aws`; `aws session`: 15–60 minute AWS credentials from a stored key or the connected profile",
    arguments: [{ name: "connect|disconnect|session", required: true }],
    options: [
      { name: "role", type: "string", argument: "ARN", description: "session: assume this role (AssumeRole) instead of a session for the key itself" },
      { name: "for", type: "string", argument: "DURATION", description: "session: 15m to 60m (default 60m)" },
      { name: "key", type: "string", argument: "NAME", description: "session: which stored aws/access-key (default: the only one, else the connected profile)" },
      { name: "region", type: "string", argument: "REGION", description: "Region for STS or the stack (default: AWS_REGION or us-east-1)" },
      { name: "profile", type: "string", argument: "PROFILE", description: "connect/disconnect: AWS CLI profile to deploy with" },
      { name: "stack", type: "string", argument: "NAME", description: `connect: stack name (default ${AWS_STACK.defaultName})` },
      { name: "github-repo", type: "string", argument: "OWNER/REPO", description: "connect: give this repo's GitHub Actions an agent role via OIDC" },
      { name: "github-oidc-exists", type: "boolean", description: "connect: the account already has GitHub's OIDC provider" },
      { name: "broker-account", type: "string", argument: "ACCOUNT_ID", description: "connect: optional cross-account broker (off by default)" },
      { name: "link", type: "boolean", description: "connect: print a CloudFormation quick-create link instead of deploying" },
      { name: "template-url", type: "string", argument: "URL", description: `connect --link: use a template published somewhere else (or set ${ENV.stackTemplateUrl})` },
      { ...yesOption, description: "disconnect: skip the confirmation prompt" },
      envOption,
      agentOption,
      jsonOption,
    ],
    examples: [
      "sikrets aws connect",
      "sikrets aws disconnect --yes",
      "sikrets aws session -- aws s3 ls",
      'eval "$(sikrets aws session --for 15m --env)"',
      "sikrets aws session --role arn:aws:iam::123456789012:role/deploy -- terraform plan",
    ],
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
