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

export const commands: CommandSpec[] = [
  {
    name: "init",
    description: "Create sikrets.json for this project (name, vault, env file, IaC dir, default connections)",
    arguments: [],
    options: [
      { name: "project", type: "string", argument: "NAME", description: "Project name (default: directory name)" },
      { name: "vault", type: "string", argument: "ssm|keychain", description: "Where secrets live (default: ssm)" },
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
    options: [{ name: "providers", type: "boolean", description: "Also inject provider admin credentials (for terraform)" }],
    examples: ["sikrets run -- bun dev", "sikrets run --providers -- terraform plan"],
    passthrough: true,
    load: () => import("./run.ts"),
  },
  {
    name: "mcp",
    description: "Serve this project to AI agents over MCP (stdio or HTTP): they run commands with secrets but never see them. Also: config, install, clients",
    arguments: [{ name: "config|install|clients", required: false }, { name: "app|add|rm|token", required: false }, { name: "name", required: false }],
    options: [
      { name: "allow", type: "string", multiple: true, argument: "PROGRAM", description: "Only let agents run these programs (repeatable; default: any, except over a public URL)" },
      { name: "root", type: "string", argument: "DIR", description: "Project directory (default: current directory)" },
      { name: "agent", type: "string", argument: "NAME", description: "stdio: label this agent in login approvals (default: the name its client reports; grants are bound to the program that started the server)" },
      { name: "browser", type: "string", argument: "URL", description: "DevTools endpoint of the agent's Chrome for `login` (default: http://127.0.0.1:9222)" },
      { name: "http", type: "boolean", description: "Serve Streamable HTTP instead of stdio; every client needs a token (sikrets mcp clients add)" },
      { name: "port", type: "string", argument: "PORT", description: "--http: port (default: 7787)" },
      { name: "host", type: "string", argument: "HOST", description: "--http: address to listen on (default: 127.0.0.1, this machine only)" },
      { name: "public-url", type: "string", argument: "URL", description: "--http: the https URL your tunnel forwards here (needed for ChatGPT and Claude.ai)" },
      { name: "oauth", type: "boolean", description: "--http: let apps sign in with OAuth 2.1; you approve each one on this Mac" },
      { name: "allow-any", type: "boolean", description: "--http with --public-url: allow any program (not recommended)" },
      { name: "url", type: "string", argument: "URL", description: "config/install: the MCP URL to put in the snippet" },
      yesOption,
      jsonOption,
    ],
    examples: [
      "sikrets mcp",
      "sikrets mcp --allow bun --allow terraform",
      "sikrets mcp install claude-desktop",
      "sikrets mcp config cursor --http",
      "sikrets mcp clients add cursor",
      "sikrets mcp --http --oauth --public-url https://name.trycloudflare.com --allow bun",
    ],
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
    name: "env",
    description: "List which values this project has (names only), or `env pull` them into a git-ignored .env",
    arguments: [{ name: "pull", required: false }],
    options: [
      { name: "file", type: "string", argument: "FILE", description: "Where `env pull` writes (default: .env)" },
      { name: "real", type: "boolean", short: "r", description: "Write real secrets instead of stand-ins" },
      jsonOption,
    ],
    examples: ["sikrets env", "sikrets env pull", "sikrets env pull --real --file .env.local"],
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
