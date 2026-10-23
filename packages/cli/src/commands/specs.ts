// Command specs are plain data (after the Vercel CLI's command.ts files): they drive parsing,
// help and typo suggestions without loading any implementation. Each command's code is imported
// only when that command runs, so `sikrets ls` never pays for the browser stack.

export interface OptionSpec {
  name: string;
  type: "string" | "boolean";
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
  load: () => Promise<{ run: (args: string[], opts: Record<string, string | boolean | undefined>) => Promise<void> }>;
}

export const jsonOption: OptionSpec = { name: "json", type: "boolean", description: "Machine-readable output on stdout (for agents)" };

const dryRunOption: OptionSpec = { name: "dry-run", type: "boolean", description: "Show exactly what would change, and what it costs, without touching anything" };
const yesOption: OptionSpec = { name: "yes", type: "boolean", short: "y", description: "Skip the confirmation prompt" };

export const commands: CommandSpec[] = [
  {
    name: "connect",
    description: "Link a provider account. Opens a visible browser; without --email you sign in and Sikrets saves the login to your keychain",
    arguments: [{ name: "provider", required: true }],
    options: [
      { name: "email", type: "string", argument: "EMAIL", description: "Sign in for me with this email (password is prompted)" },
      { name: "password-stdin", type: "boolean", description: "Read the password from stdin instead of prompting" },
      jsonOption,
    ],
    examples: ["sikrets connect openai", "sikrets connect openai --email me@acme.dev", "printf %s \"$PW\" | sikrets connect openai --email me@acme.dev --password-stdin --json"],
    load: () => import("./connect.ts"),
  },
  {
    name: "add",
    description: "Provision a service for this project, store its credentials and generate its IaC",
    arguments: [{ name: "provider/service", required: true }],
    options: [
      { name: "name", type: "string", argument: "NAME", description: "Resource name (default: cache)" },
      { name: "region", type: "string", argument: "REGION", description: "Primary region (default: us-east-1)" },
      { name: "plan", type: "string", argument: "PLAN", description: "free, payg, fixed_250mb, … (default: free)" },
      { name: "budget", type: "string", argument: "USD", description: "Monthly spend cap for pay-as-you-go plans" },
      dryRunOption,
      yesOption,
      jsonOption,
    ],
    examples: ["sikrets add upstash/redis --dry-run", "sikrets add upstash/redis --name cache --plan payg --budget 20 --yes --json"],
    load: () => import("./add.ts"),
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
    description: "Month-to-date spend for everything Sikrets provisioned in this project",
    arguments: [],
    options: [jsonOption],
    examples: ["sikrets cost", "sikrets cost --json"],
    load: () => import("./cost.ts"),
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
