#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { commands, findCommand, type CommandSpec } from "./commands/specs.ts";

const usage = (c: CommandSpec) => `sikrets ${c.name}${c.arguments.map((a) => (a.required ? ` <${a.name}>` : ` [${a.name}]`)).join("")}`;

function help(c?: CommandSpec) {
  if (!c) {
    const width = Math.max(...commands.map((x) => x.name.length));
    return `sikrets — connect providers, provision and rotate credentials\n\nCommands\n${commands
      .map((x) => `  ${x.name.padEnd(width)}  ${x.description}`)
      .join("\n")}\n\nRun sikrets <command> --help for details.`;
  }
  const opts = c.options.map((o) => `  --${o.name}${o.argument ? ` <${o.argument}>` : ""}`);
  const width = Math.max(0, ...opts.map((o) => o.length));
  return [
    `${usage(c)}${c.options.length ? " [options]" : ""}`,
    "",
    c.description,
    c.options.length ? `\nOptions\n${c.options.map((o, i) => `${opts[i]!.padEnd(width)}  ${o.description}`).join("\n")}` : "",
    c.examples.length ? `\nExamples\n${c.examples.map((e) => `  $ ${e}`).join("\n")}` : "",
  ].join("\n");
}

// Closest command by edit distance, for "did you mean".
function suggest(input: string) {
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length]![b.length]!;
  };
  const best = commands.map((c) => ({ c, d: dist(input, c.name) })).sort((a, b) => a.d - b.d)[0];
  return best && best.d <= 2 ? best.c.name : undefined;
}

async function main(argv = process.argv.slice(2)) {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h" || name === "help") return console.log(help());
  if (name === "--version" || name === "-v") return console.log((await import("../package.json")).version);

  const spec = findCommand(name);
  if (!spec) {
    const hint = suggest(name);
    throw new Error(`Unknown command "${name}".${hint ? ` Did you mean "${hint}"?` : ""} Run sikrets --help`);
  }

  // For passthrough commands, everything after `--` belongs to the child command.
  const split = spec.passthrough ? rest.indexOf("--") : -1;
  const own = split >= 0 ? rest.slice(0, split) : rest;
  const passed = split >= 0 ? rest.slice(split + 1) : [];

  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      ...Object.fromEntries(spec.options.map((o) => [o.name, { type: o.type, multiple: o.multiple ?? false, ...(o.short ? { short: o.short } : {}) }])),
    },
  });
  if (values.help) return console.log(help(spec));
  const args = spec.passthrough ? [...positionals, ...passed] : positionals;
  const missing = spec.arguments.slice(args.length).find((a) => a.required);
  if (missing) throw new Error(`Missing <${missing.name}>. Usage: ${usage(spec)}${spec.passthrough ? " -- …" : ""}`);

  // Keys with auto-rotate on are replaced when due, before the command uses them.
  if (!values["dry-run" as keyof typeof values] && !["init", "rotate", "rollback"].includes(spec.name)) {
    const { autoRotate } = await import("./core/autorotate.ts");
    await autoRotate(process.cwd(), (m) => console.error(m)).catch(() => {});
  }

  const { run } = await spec.load();
  await run(args, values);
}

main().catch((error) => {
  console.error(`sikrets: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
