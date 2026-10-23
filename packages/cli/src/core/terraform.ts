import path from "node:path";
import { IAC_DIR } from "../iac/terraform.ts";
import { toProcessEnv, type Env } from "./credentials.ts";
import { Secret } from "./secret.ts";

/** Terraform or OpenTofu, whichever is installed (SIKRETS_TERRAFORM overrides). */
export function terraformBinary(): string {
  const bin = Bun.env.SIKRETS_TERRAFORM ?? Bun.which("terraform") ?? Bun.which("tofu");
  if (!bin) throw new Error("Terraform isn't installed. Install it (brew install hashicorp/tap/terraform) or OpenTofu (brew install opentofu)");
  return bin;
}

/** Runs terraform in iac/terraform with its output streamed to the terminal. */
export async function terraform(root: string, args: readonly string[], env: Env): Promise<void> {
  const proc = Bun.spawn([terraformBinary(), ...args], {
    cwd: path.join(root, IAC_DIR),
    env: { ...Bun.env, TF_IN_AUTOMATION: "1", ...toProcessEnv(env) },
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`terraform ${args[0]} exited with ${code}`);
}

export interface Output {
  sensitive: boolean;
  value: string | Secret;
}

/** Reads root outputs without ever printing them; sensitive values come back as Secret. */
export async function outputs(root: string, env: Env): Promise<Record<string, Output>> {
  const proc = Bun.spawn([terraformBinary(), "output", "-json"], {
    cwd: path.join(root, IAC_DIR),
    env: { ...Bun.env, TF_IN_AUTOMATION: "1", ...toProcessEnv(env) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`terraform output exited with ${code}`);
  const raw = JSON.parse(stdout) as Record<string, { sensitive: boolean; value: unknown }>;
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([, o]) => o.value !== null && o.value !== "")
      .map(([name, o]) => {
        const text = typeof o.value === "string" ? o.value : JSON.stringify(o.value);
        return [name, { sensitive: o.sensitive, value: o.sensitive ? Secret.of(text) : text }];
      }),
  );
}
