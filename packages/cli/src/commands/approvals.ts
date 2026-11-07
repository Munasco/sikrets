import { record } from "../core/activity.ts";
import { applyEvent, approvals, decide, isOpen, isReason, reasonText, requestRotation, type ApprovalRequest, type Reason } from "../core/approvals.ts";
import { native } from "../core/doorman.ts";
import { state } from "../core/state.ts";
import { until } from "../core/ttl.ts";
import { log } from "../ui.ts";
import { APPROVAL_REASONS } from "../constants.ts";

// sikrets approvals [list|request|approve|deny]. Approving always goes through a person (Touch ID,
// a dialog or a terminal prompt), so an agent can file and list requests but never approve one.

export async function run(args: string[], opts: Record<string, unknown>) {
  const [action = "list", target] = args;
  const root = process.cwd();
  const say = (m: string) => log(opts, m);
  switch (action) {
    case "list":
      return list(root, opts);
    case "request":
      return request(root, need(target, "resource"), opts, say);
    case "approve":
      return approve(root, await approvals.find(root, need(target, "request id")), opts, say);
    case "deny":
      return deny(root, await approvals.find(root, need(target, "request id")), opts, say);
    default:
      throw new Error(`Unknown action "${action}". Use: sikrets approvals list | request | approve | deny`);
  }
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing <${what}>`);
  return value;
}

async function list(root: string, opts: Record<string, unknown>) {
  const all = await approvals.load(root);
  const shown = opts.all ? all : all.filter(isOpen);
  if (opts.json) return console.log(JSON.stringify(shown.map((r) => ({ ...r, message: reasonText(r.reason) }))));
  if (!shown.length) return console.log(opts.all ? "No approval requests yet." : "Nothing waiting for approval.");
  for (const r of shown) {
    const when = isOpen(r) ? `expires ${until(r.expiresAt)}` : (r.decidedAt ?? r.createdAt).replace("T", " ").slice(0, 16);
    console.log(`${r.id}  ${r.resource.padEnd(16)} ${r.status.padEnd(8)} ${reasonText(r.reason)}  (${when})`);
  }
}

async function request(root: string, resource: string, opts: Record<string, unknown>, say: (m: string) => void) {
  const reason = (opts.reason ?? "requested") as Reason;
  if (!isReason(reason)) throw new Error(`--reason must be one of ${Object.keys(APPROVAL_REASONS).join(", ")}`);
  if (!(await state.load(root)).resources.some((r) => r.name === resource)) throw new Error(`No resource named "${resource}" in this project. See: sikrets status`);
  const { request: req, created } = await requestRotation(root, resource, reason);
  say(created ? `Filed ${req.id}: ${reasonText(reason)} (${resource}).` : `${req.id} is already waiting for ${resource}.`);
  if (opts.queue) return opts.json ? console.log(JSON.stringify(req)) : say("Queued. A person can approve it with: sikrets approvals approve " + req.id);
  return approve(root, req, opts, say);
}

async function approve(root: string, req: ApprovalRequest, opts: Record<string, unknown>, say: (m: string) => void) {
  say(`Asking for approval to rotate ${req.resource}…`);
  const out = await decide(root, req, (r) => native.ask(r), rotateNow);
  if (out.status === req.status) say(`No answer; ${req.id} is still waiting. Approve later with: sikrets approvals approve ${req.id}`);
  else await record(root, { kind: "approval", detail: `${out.id} ${out.resource} ${out.status}${out.decidedBy ? ` via ${out.decidedBy}` : ""}` });
  if (opts.json) console.log(JSON.stringify(out));
  else if (out.status === "denied") say(`Denied. ${req.resource} was not rotated.`);
}

async function deny(root: string, req: ApprovalRequest, opts: Record<string, unknown>, say: (m: string) => void) {
  // Saying no needs no proof of presence: it can only ever leave a key as it is.
  const out = await applyEvent(root, req.id, "deny", { by: "cli" });
  await record(root, { kind: "approval", detail: `${out.id} ${out.resource} denied via cli` });
  if (opts.json) console.log(JSON.stringify(out));
  else say(`Denied ${out.id}. ${out.resource} was not rotated.`);
}

/** Approval runs the existing rotate, already confirmed by the person who approved. */
async function rotateNow(resource: string) {
  const { run } = await import("./rotate.ts");
  await run([resource], { yes: true });
}
