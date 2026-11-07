import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// aws.sh's KMS pin handling, run against a stand-in `aws` CLI and `curl` (no AWS account is
// touched). The run stops at the first step past the KMS section (the VPC lookup).

const SCRIPT = path.join(import.meta.dir, "aws.sh");
const pcr = (c: string) => c.repeat(96);
const policy = (pins: string[]) =>
  JSON.stringify({ Statement: [{ Sid: "Manage" }, { Sid: "EnclaveDecrypt", Condition: { StringEqualsIgnoreCase: { "kms:RecipientAttestation:ImageSha384": pins } } }] });

const AWS = `#!/bin/bash
echo "$*" >> "$FAKE/log"
arg() { local want=$1; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { echo "$2"; return; }; shift; done; }
case "$1 $2" in
  "sts get-caller-identity") echo 123456789012 ;;
  "ssm get-parameter")
    case "$(arg --name "$@")" in
      */pinned-pcr0) [ -f "$FAKE/pinned" ] && cat "$FAKE/pinned" || exit 255 ;;
      *) echo stored ;;
    esac ;;
  "ssm put-parameter") [[ "$(arg --name "$@")" == */pinned-pcr0 ]] && arg --value "$@" > "$FAKE/pinned" ;;
  "kms describe-key")
    case "$(arg --key-id "$@")" in
      alias/*) [ -n "$ALIAS_MISSING" ] && exit 254; echo key-1 ;;
      *) echo Enabled ;;
    esac ;;
  "kms get-key-policy") cat "$FAKE/policy" ;;
  "kms put-key-policy") arg --policy "$@" > "$FAKE/policy" ;;
  "kms create-key") echo new-key ;;
  "resourcegroupstaggingapi get-resources") echo "arn:aws:kms:us-east-1:123456789012:key/orphan-key" ;;
  "cloudfront list-distributions") echo None ;;
  "ec2 describe-vpcs") exit 99 ;;
esac
exit 0
`;

const CURL = `#!/bin/bash
out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
[ -n "$LIVE" ] || exit 7
printf '{"enclave":true,"pcrs":{"0":"%s"}}' "$LIVE" > "$out"
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(env: Record<string, string>, pins: string[]) {
  const fake = mkdtempSync(path.join(tmpdir(), "sikrets-aws-"));
  dirs.push(fake);
  for (const [name, body] of [["aws", AWS], ["curl", CURL]] as const) {
    writeFileSync(path.join(fake, name), body);
    chmodSync(path.join(fake, name), 0o755);
  }
  writeFileSync(path.join(fake, "policy"), policy(pins));
  const p = Bun.spawnSync(["bash", SCRIPT], { env: { PATH: `${fake}:${process.env.PATH}`, HOME: fake, FAKE: fake, ...env } });
  const log = existsSync(path.join(fake, "log")) ? readFileSync(path.join(fake, "log"), "utf8") : "";
  const pinned = existsSync(path.join(fake, "pinned")) ? (JSON.parse(readFileSync(path.join(fake, "pinned"), "utf8")) as { pcr0: string[]; since: number }) : undefined;
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString(), log, pinned };
}

describe("aws.sh KMS pin", () => {
  test("a pin that leaves out the live enclave's PCR0 is refused", () => {
    const r = run({ ENCLAVE_PCR0: pcr("b"), LIVE: pcr("a") }, [pcr("a")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Refusing");
    expect(r.log).not.toContain("put-key-policy");
  });

  test("the live PCR0 alongside the new one is pinned, and the pin set is mirrored for the host", () => {
    const r = run({ ENCLAVE_PCR0: `${pcr("a")},${pcr("b")}`, LIVE: pcr("a") }, [pcr("a")]);
    expect(r.code).toBe(99); // stopped at the VPC lookup, past the KMS section
    expect(r.log).toContain("put-key-policy");
    expect(r.pinned?.pcr0.sort()).toEqual([pcr("a"), pcr("b")]);
  });

  test("with no enclave answering, a pin over an existing one needs FORCE_PCR0", () => {
    expect(run({ ENCLAVE_PCR0: pcr("b") }, [pcr("a")]).code).toBe(1);
    expect(run({ ENCLAVE_PCR0: pcr("b"), FORCE_PCR0: "1" }, [pcr("a")]).code).toBe(99);
    // The first pin (only the placeholder so far) has nothing to keep.
    expect(run({ ENCLAVE_PCR0: pcr("b") }, [pcr("0")]).code).toBe(99);
  });

  test("a key left without its alias by an interrupted run is adopted, not duplicated", () => {
    const r = run({ ALIAS_MISSING: "1" }, [pcr("0")]);
    expect(r.log).not.toContain("kms create-key");
    expect(r.log).toContain("kms create-alias --alias-name alias/sikrets-agent-demo --target-key-id orphan-key");
  });

  test("a dual pin older than a day gets a reminder", () => {
    const fake = run({}, [pcr("a"), pcr("b")]);
    expect(fake.out).not.toContain("two PCR0s");
    const r = run({ DUAL_PIN_HOURS: "-1" }, [pcr("a"), pcr("b")]);
    expect(r.out).toContain("two PCR0s");
  });
});
