// A stand-in for the 1Password CLI, for tests. State lives in $FAKE_PM_DIR/op.json; every call's
// argv is appended to $FAKE_PM_DIR/calls.jsonl so tests can check no value ever reached argv.
import { appendFileSync } from "node:fs";

const dir = process.env.FAKE_PM_DIR!;
const file = `${dir}/op.json`;
const USER = "FAKEUSERUUID";
const SESSION = "fake-op-session";
appendFileSync(`${dir}/calls.jsonl`, JSON.stringify({ bin: "op", args: process.argv.slice(2) }) + "\n");

type Field = { id: string; type: string; label: string; value?: string; reference?: string; section?: { id: string; label?: string } };
type Item = { id: string; title: string; vault: { id: string; name: string }; fields: Field[] };
const state = (await Bun.file(file).json()) as { items: Item[] };
const save = () => Bun.write(file, JSON.stringify(state));
const fail = (m: string): never => (console.error(`[ERROR] ${m}`), process.exit(1));

// Drop global flags we don't model.
const raw = process.argv.slice(2);
const args: string[] = [];
const flags: Record<string, string> = {};
for (let i = 0; i < raw.length; i++) {
  if (["--account", "--vault", "--format", "--template"].includes(raw[i]!)) flags[raw[i]!] = raw[++i]!;
  else if (raw[i] !== "--no-newline") args.push(raw[i]!);
}
const signedIn = () => process.env[`OP_SESSION_${USER}`] === SESSION || fail("You are not currently signed in.");
const findItem = (idOrTitle: string, vault?: string) =>
  state.items.find((i) => (i.id === idOrTitle || i.title === idOrTitle) && (!vault || i.vault.id === vault || i.vault.name === vault)) ?? fail(`"${idOrTitle}" isn't an item.`);
const withRefs = (i: Item): Item => ({ ...i, fields: i.fields.map((f) => ({ ...f, reference: `op://${i.vault.name}/${i.title}/${f.section?.label ? `${f.section.label}/` : ""}${f.label}` })) });

const [cmd, sub, target] = args;
if (cmd === "account" && sub === "list") console.log(JSON.stringify([{ url: "my.1password.com", email: "dev@example.com", user_uuid: USER, account_uuid: "ACCT" }]));
else if (cmd === "signin") process.stdout.write(SESSION);
else if (cmd === "signout") void 0;
else if (cmd === "whoami") {
  signedIn();
  console.log(JSON.stringify({ user_uuid: USER, email: "dev@example.com" }));
}
else if (cmd === "read") {
  signedIn();
  const [vault, title, ...rest] = sub!.slice("op://".length).split("/");
  const field = rest.at(-1)!;
  const f = findItem(title!, vault).fields.find((x) => x.label === field || x.id === field) ?? fail(`no field ${field}`);
  process.stdout.write(f.value ?? "");
} else if (cmd === "item" && sub === "list") {
  signedIn();
  console.log(JSON.stringify(state.items.map(({ id, title, vault }) => ({ id, title, vault }))));
} else if (cmd === "item" && sub === "get") {
  signedIn();
  console.log(JSON.stringify(withRefs(findItem(target!, flags["--vault"]))));
} else if (cmd === "item" && sub === "edit") {
  signedIn();
  const current = findItem(target!, flags["--vault"]);
  if (flags["--template"] !== "/dev/stdin") fail("expected the template on stdin");
  const edited = JSON.parse(await Bun.stdin.text()) as Item;
  state.items = state.items.map((i) => (i.id === current.id ? { ...current, fields: edited.fields.map(({ reference: _, ...f }) => f) } : i));
  await save();
  console.log(JSON.stringify(withRefs(findItem(current.id))));
} else fail(`unknown command ${args.join(" ")}`);
