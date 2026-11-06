import { projectContext } from "../core/config.ts";
import { envelopeKind } from "../core/envelope.ts";
import { externalKeys } from "../core/keys.ts";
import { Secret } from "../core/secret.ts";
import { outputKeys, standInKey } from "../core/standin.ts";
import { state } from "../core/state.ts";
import { openVault } from "../core/vault.ts";
import { awsClientConfig } from "../providers/aws.ts";
import { log } from "../ui.ts";
import { keychainVaultService, LEGACY_VAULTS, SSM_PREFIX } from "../constants.ts";

// sikrets migrate: moves values from where the CLI used to keep them (AWS SSM Parameter Store
// under /sikrets/<project>/, or the OS keychain) to the Sikrets server. A dry run by default;
// --apply uploads. Values already sealed (sk1:) go up exactly as they are; legacy plaintext is
// sealed on this machine first. Names already on the server are left alone. The old copies stay
// where they were. Only this command reads SSM, with your own AWS profile; names are printed,
// never values.

type Source = (typeof LEGACY_VAULTS)[number];
type Action = "upload" | "seal-and-upload" | "on-server" | "newer-format";

/** The one method of SSMClient migrate uses, so tests can pass a fake. */
export interface SsmClient {
  send(command: object): Promise<any>;
}

/** How migrate reaches SSM. Tests replace it; nothing else does. */
export const legacy = {
  async ssm(): Promise<SsmClient> {
    const { SSMClient } = await import("@aws-sdk/client-ssm");
    return new SSMClient(await awsClientConfig());
  },
};

/** Every value under /sikrets/<project>/ in SSM, by name. */
async function readSsm(project: string): Promise<Map<string, string>> {
  const { GetParametersByPathCommand } = await import("@aws-sdk/client-ssm");
  const client = await legacy.ssm();
  const prefix = `${SSM_PREFIX}/${project}`;
  const found = new Map<string, string>();
  let NextToken: string | undefined;
  do {
    const page = await client.send(new GetParametersByPathCommand({ Path: prefix, Recursive: false, WithDecryption: true, NextToken }));
    for (const p of (page.Parameters ?? []) as { Name?: string; Value?: string }[]) if (p.Name && p.Value) found.set(p.Name.slice(prefix.length + 1), p.Value);
    NextToken = page.NextToken;
  } while (NextToken);
  return found;
}

/** The keychain can't be listed, so look up every name this project knows, and their stand-ins. */
async function readKeychain(root: string, project: string): Promise<Map<string, string>> {
  const { resources } = await state.load(root);
  const names = new Set([...resources.flatMap((r) => [...r.envKeys, ...outputKeys(r).map((k) => k.key)]), ...(await externalKeys(root)).map((k) => k.key)]);
  for (const n of [...names]) names.add(standInKey(n));
  const service = keychainVaultService(project);
  const found = new Map<string, string>();
  for (const name of [...names].sort()) {
    const value = await Bun.secrets.get({ service, name });
    if (value) found.set(name, value);
  }
  return found;
}

export async function run(_args: string[], opts: Record<string, unknown>) {
  const say = (m: string) => log(opts, m);
  const root = process.cwd();
  const { config, ctx } = await projectContext(root, { log: say });
  const from = (typeof opts.from === "string" ? opts.from : (config.vault ?? "ssm")) as Source;
  if (!LEGACY_VAULTS.includes(from)) throw new Error(`--from must be ${LEGACY_VAULTS.join(" or ")}`);
  const apply = Boolean(opts.apply);

  const values = from === "ssm" ? await readSsm(ctx.project) : await readKeychain(root, ctx.project);
  const vault = await openVault(ctx.project, ctx.server);
  const onServer = new Set(await vault.list());
  const items: { name: string; action: Action }[] = [...values]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, value]) => {
      if (onServer.has(name)) return { name, action: "on-server" };
      const kind = envelopeKind(value);
      return { name, action: kind === "sealed" ? "upload" : kind === "newer" ? "newer-format" : "seal-and-upload" };
    });

  let moved = 0;
  if (apply) {
    for (const { name, action } of items) {
      const value = values.get(name)!;
      if (action === "upload") await vault.putSealed(name, value);
      else if (action === "seal-and-upload") await vault.put(name, Secret.of(value));
      else continue;
      moved++;
    }
  }

  if (opts.json) return console.log(JSON.stringify({ project: ctx.project, from, server: vault.server, apply, moved, items }));
  const label = { upload: "upload (already sealed)", "seal-and-upload": "seal here, then upload", "on-server": "skip: already on the server", "newer-format": "skip: written by a newer Sikrets" } as const;
  if (!items.length) return say(`Nothing to migrate: no values for ${ctx.project} in the ${from} vault.`);
  say(`${apply ? "Migrating" : "Dry run — would migrate"} ${ctx.project} from the ${from} vault to ${vault.server}:`);
  for (const { name, action } of items) say(`  ${action === "on-server" || action === "newer-format" ? "·" : apply ? "✓" : "+"} ${name}  ${label[action]}`);
  if (!apply) return say(`Nothing changed. Run sikrets migrate${typeof opts.from === "string" ? ` --from ${from}` : ""} --apply to upload.`);
  say(`Moved ${moved} value(s). The ${from} copies are untouched; delete them once you've checked everything works.`);
}
