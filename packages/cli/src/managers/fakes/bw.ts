// A stand-in for the Bitwarden CLI, for tests. State lives in $FAKE_PM_DIR/bw.json; every call's
// argv is appended to $FAKE_PM_DIR/calls.jsonl so tests can check no value ever reached argv.
import { appendFileSync } from "node:fs";

const dir = process.env.FAKE_PM_DIR!;
const file = `${dir}/bw.json`;
const SESSION = "fake-bw-session";
const PASSWORD = "fake-master-password";
const args = process.argv.slice(2).filter((a) => a !== "--nointeraction");
appendFileSync(`${dir}/calls.jsonl`, JSON.stringify({ bin: "bw", args: process.argv.slice(2) }) + "\n");

type State = { status: string; serverUrl: string | null; userEmail?: string; items: { id: string; name: string; [k: string]: unknown }[] };
const state = (await Bun.file(file).json()) as State;
const save = () => Bun.write(file, JSON.stringify(state));
const fail = (m: string): never => (console.error(m), process.exit(1));
const unlocked = () => (process.env.BW_SESSION === SESSION && state.status === "unlocked") || fail("Vault is locked.");
const item = (id: string) => state.items.find((i) => i.id === id) ?? fail("Not found.");

const [cmd, a, b] = args;
switch (cmd) {
  case "status":
    // Like bw: "unlocked" only with a valid session; a vault locked elsewhere reads as locked.
    console.log(JSON.stringify({ serverUrl: state.serverUrl, userEmail: state.userEmail, status: state.status === "unauthenticated" ? "unauthenticated" : state.status === "unlocked" && process.env.BW_SESSION === SESSION ? "unlocked" : "locked" }));
    break;
  case "config":
    state.serverUrl = b!;
    await save();
    console.log(`Saved setting \`config\`.`);
    break;
  case "login":
  case "unlock":
    if (process.env.SIKRETS_BW_PASSWORD !== PASSWORD) fail("Invalid master password.");
    state.status = "unlocked";
    if (cmd === "login") state.userEmail = a;
    await save();
    process.stdout.write(SESSION);
    break;
  case "sync":
    unlocked();
    console.log("Syncing complete.");
    break;
  case "get":
    unlocked();
    console.log(JSON.stringify(item(b!)));
    break;
  case "list":
    unlocked();
    console.log(JSON.stringify(state.items));
    break;
  case "edit": {
    unlocked();
    item(b!);
    const edited = JSON.parse(Buffer.from((await Bun.stdin.text()).trim(), "base64").toString());
    state.items = state.items.map((i) => (i.id === b ? edited : i));
    await save();
    console.log(JSON.stringify(edited));
    break;
  }
  case "lock":
    state.status = "locked";
    await save();
    console.log("Your vault is locked.");
    break;
  default:
    fail(`unknown command ${cmd}`);
}
