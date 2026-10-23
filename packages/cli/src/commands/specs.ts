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
