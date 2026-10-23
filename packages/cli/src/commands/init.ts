import { CONFIG_FILE, defaultConfig, hasConfig, validateConfig, writeConfig } from "../core/config.ts";
import { log } from "../ui.ts";

// Creates sikrets.json for the project in the current directory. Safe to re-run: never overwrites.
export async function run(_args: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  if (await hasConfig(root)) throw new Error(`${CONFIG_FILE} already exists here`);
  // Same strict validation as loading, so a bad --project or --vault fails here, not later.
  const config = validateConfig(
    {
      ...defaultConfig(root),
      ...(typeof opts.project === "string" ? { project: opts.project } : {}),
      ...(typeof opts.vault === "string" ? { vault: opts.vault } : {}),
    },
    root,
  );
  await writeConfig(root, config);
  if (opts.json) console.log(JSON.stringify(config));
  else log(opts, `Created ${CONFIG_FILE} for project "${config.project}" (vault: ${config.vault}). Commit it.`);
}
