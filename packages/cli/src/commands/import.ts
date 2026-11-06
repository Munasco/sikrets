import path from "node:path";
import { record } from "../core/activity.ts";
import { projectContext } from "../core/config.ts";
import { detectFormat, FORMAT_NAMES, fromManager, keyName, parseExport, type ImportEntry, type ImportFormat } from "../core/import.ts";
import { saveExternalKeys } from "../core/keys.ts";
import { openVault } from "../core/vault.ts";
import { managers } from "../managers/index.ts";
import { confirm, log } from "../ui.ts";
import { IMPORT } from "../constants.ts";

// `sikrets import <file>` moves values from a .env file or a password manager / browser export into
// the project vault; `sikrets import bitwarden|1password` takes them straight from the vault CLI and
// links each key, so rotations write back. The summary shows names only, never values.
export async function run(args: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  const source = args[0]!;
  const say = (m: string) => log(opts, m);
  const { ctx } = await projectContext(root, { dryRun: Boolean(opts["dry-run"]), log: say });

  const m = managers[source.toLowerCase()];
  const fromFile = !m || (await Bun.file(source).exists());
  let entries: ImportEntry[];
  let label: string;
  if (fromFile) {
    if (!(await Bun.file(source).exists())) throw new Error(`No file at ${source}, and it isn't a password manager (bitwarden, 1password)`);
    const format = typeof opts.format === "string" ? (opts.format as ImportFormat) : detectFormat(source, source.endsWith(".1pux") ? "" : await Bun.file(source).text());
    if (!(format in FORMAT_NAMES)) throw new Error(`Unknown --format "${format}". Use one of: ${Object.keys(FORMAT_NAMES).join(", ")}`);
    entries = parseExport(format, format === "1pux" && source.endsWith(".1pux") ? await unzipOnePux(source) : await Bun.file(source).text());
    label = FORMAT_NAMES[format];
  } else {
    entries = fromManager(await m!.list());
    label = m!.name;
  }
  if (typeof opts.prefix === "string") entries = entries.map((e) => ({ ...e, key: keyName(opts.prefix as string, e.key) }));
  if (!entries.length) throw new Error(`Found nothing to import in ${source}`);

  const vault = await openVault(ctx.project, ctx.server);
  const existing = new Set<string>();
  for (const e of entries) if (await vault.has(e.key)) existing.add(e.key);

  say(`${ctx.dryRun ? "Dry run — would import" : "Importing"} ${entries.length} value(s) from ${label} into the vault on ${vault.server}:`);
  for (const e of entries) say(`  ${existing.has(e.key) ? "~" : "+"} ${e.key}${e.item !== e.key ? `  (${e.item})` : ""}${existing.has(e.key) ? "  replaces the current value" : ""}${e.ref ? "  linked" : ""}`);
  const summary = { source: fromFile ? source : m!.id, format: label, keys: entries.map((e) => e.key), replaced: [...existing] };
  if (ctx.dryRun) return opts.json ? console.log(JSON.stringify({ dryRun: true, ...summary })) : undefined;
  if (!opts.yes && process.stdin.isTTY && !(await confirm("Import these?"))) return say("Cancelled; nothing changed.");

  for (const e of entries) await vault.put(e.key, e.value);
  const now = new Date().toISOString();
  await saveExternalKeys(root, entries.map((e) => ({ key: e.key, source: fromFile ? label : m!.id, ...(e.ref ? { ref: e.ref } : {}), addedAt: now })));
  await record(root, { kind: "import", detail: `${entries.length} from ${label}`, keys: entries.map((e) => e.key) });

  if (opts.json) console.log(JSON.stringify(summary));
  else say(`Imported ${entries.length} value(s).${fromFile ? "" : ` Linked to ${label}: rotations write back.`}`);
  if (fromFile) say(`${source} still holds these values in plain text. Delete it now: rm ${JSON.stringify(path.resolve(source))}`);
}

/** Reads export.data out of a .1pux zip, straight into memory. */
async function unzipOnePux(file: string): Promise<string> {
  const proc = Bun.spawn([IMPORT.unzip, "-p", file, IMPORT.onePuxData], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0 || !out) throw new Error(`Couldn't read ${IMPORT.onePuxData} from ${file}; is it a 1Password .1pux export?`);
  return out;
}
