import { useState } from "react";
import { BookKey, BookOpen, Check, ChevronRight, FileSearch, FolderGit2, Hash, Lock, PackageSearch, Plug, RotateCcwKey, ShieldAlert, X } from "lucide-react";
import type { ToolPart } from "./api.ts";
import { withSecrets } from "./markdown.tsx";
import { cn, Tip } from "./ui.tsx";

// Tool calls as work-log rows, in the t3code manner: no box, an icon, a one-line label that
// shimmers while the tool runs, a short result on the right, and the redacted details on click.

interface Finding {
  type: string;
  name: string;
  redacted: string;
  sha256: string;
  line?: number;
  file?: string;
  url?: string;
}

type Result = {
  error?: string;
  count?: number;
  findings?: Finding[];
  filesScanned?: number;
  matched?: number;
  matches?: Array<{ sha256: string; redacted: string; file?: string }>;
  results?: Array<{ name: string; rotateAt?: string; envVars?: string[]; sikrets?: string[] }>;
  vulns?: Array<{ id: string; summary?: string; severity?: string; fixedIn?: string[] }>;
  package?: string;
  /** Plain output: the built-ins', skills' and MCP tools'. */
  text?: string;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function parse(part: ToolPart): Result | undefined {
  const text = part.state.content?.map((c) => c.text ?? "").join("");
  if (!text) return part.state.error ? { error: part.state.error.message } : undefined;
  try {
    const r = JSON.parse(text) as unknown;
    return r && typeof r === "object" && !Array.isArray(r) ? (r as Result) : { text };
  } catch {
    return part.state.status === "error" ? { error: text } : { text };
  }
}

/** Icon, live label, done label and result summary per tool. */
function describe(part: ToolPart, r: Result | undefined) {
  const input = (part.state.input ?? {}) as Record<string, unknown>;
  const repo = String(input.repo ?? "").replace(/^(?:https?:\/\/)?github\.com\//, "");
  switch (part.name) {
    case "scan_text":
      return { icon: FileSearch, live: "Scanning the text", done: "Scanned the text", result: r?.count !== undefined ? (r.count ? plural(r.count, "finding") : "clean") : undefined };
    case "scan_github_repo":
      return { icon: FolderGit2, live: `Scanning ${repo}`, done: `Scanned ${repo}`, result: r?.count !== undefined ? `${plural(r.filesScanned ?? 0, "file")} · ${r.count ? plural(r.count, "finding") : "clean"}` : undefined };
    case "check_leak_hashes":
      return { icon: Hash, live: "Checking leak hashes", done: `Checked ${plural((input.hashes as unknown[] | undefined)?.length ?? 0, "hash", "hashes")}`, result: r?.matched !== undefined ? `${r.matched} matched` : undefined };
    case "how_to_rotate":
      return { icon: RotateCcwKey, live: `Looking up ${String(input.service ?? "")}`, done: `Rotation for ${String(input.service ?? "")}`, result: r?.results ? plural(r.results.length, "service") : undefined };
    case "osv_lookup":
      return { icon: PackageSearch, live: `Checking ${String(input.name ?? "")} on OSV`, done: `${String(input.name ?? "")}${input.version ? `@${String(input.version)}` : ""} on OSV`, result: r?.count !== undefined ? (r.count ? plural(r.count, "known vuln") : "no known vulns") : undefined };
    case "skill":
      return { icon: BookOpen, live: `Loading ${String(input.id ?? "a skill")}`, done: `Loaded ${String(input.id ?? "a skill")}`, result: undefined };
    default: {
      // MCP tools are `<server>_<tool>`; server names have no underscore.
      const i = part.name.indexOf("_");
      if (i > 0) return { icon: Plug, live: `${part.name.slice(0, i)} · ${part.name.slice(i + 1)}`, done: `${part.name.slice(0, i)} · ${part.name.slice(i + 1)}`, result: undefined };
      return { icon: BookKey, live: part.name, done: part.name, result: undefined };
    }
  }
}

export function ToolRow({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const r = parse(part);
  const d = describe(part, r);
  const live = part.state.status === "pending" || part.state.status === "running";
  const failed = part.state.status === "error" || Boolean(r?.error);
  const found = (r?.findings?.length ?? 0) + (r?.matched ?? 0) > 0;
  const Icon = d.icon;
  return (
    <div className="text-[13px]">
      <button type="button" onClick={() => !live && setOpen(!open)} aria-expanded={open} className={cn("group flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-1 text-left", !live && "hover:bg-cream")}>
        <span className="grid size-6 shrink-0 place-items-center">
          <Icon className={cn("size-4", failed ? "text-rust" : "text-muted")} strokeWidth={1.75} aria-hidden />
        </span>
        <span className={cn("min-w-0 truncate", live ? "shimmer" : "text-ink-soft")}>{live ? d.live : d.done}</span>
        {!live && d.result && <span className={cn("shrink-0 font-mono text-[11.5px]", found ? "text-rust" : "text-faint")}>{d.result}</span>}
        {!live && failed && <span className="truncate text-[12px] text-rust">{r?.error}</span>}
        <span className="flex-1" />
        {!live && (failed ? <X className="size-3.5 text-rust" aria-label="Failed" /> : <Check className="size-3.5 text-faint" aria-label="Done" />)}
        {!live && <ChevronRight className={cn("size-3.5 text-faint transition-transform", open && "rotate-90")} aria-hidden />}
      </button>
      {open && r && <Details result={r} />}
    </div>
  );
}

function Details({ result: r }: { result: Result }) {
  return (
    <div className="mb-1 ms-7 mt-0.5 max-h-96 overflow-auto rounded-lg border border-line-soft bg-white text-[12.5px]">
      {r.findings?.length ? (
        <ul className="divide-y divide-line-soft">
          {r.findings.map((f, i) => (
            <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2">
              <ShieldAlert className="size-3.5 text-rust" aria-hidden />
              <span className="font-medium">{f.name}</span>
              <span className="inline-flex items-center gap-1 rounded bg-cream px-1.5 font-mono text-[11.5px] text-pine">
                <Lock className="size-3" aria-hidden />
                {f.redacted}
              </span>
              <span className="font-mono text-[11px] text-faint">{f.file ? (f.url ? <a className="underline-offset-2 hover:underline" href={f.url} target="_blank" rel="noopener noreferrer">{f.file}:{f.line}</a> : `${f.file}:${f.line}`) : `line ${f.line}`}</span>
              <Tip label={`SHA-256 ${f.sha256}`}>
                <span tabIndex={0} className="font-mono text-[11px] text-faint">#{f.sha256.slice(0, 8)}</span>
              </Tip>
            </li>
          ))}
        </ul>
      ) : r.results?.length ? (
        <ul className="divide-y divide-line-soft">
          {r.results.map((s, i) => (
            <li key={i} className="space-y-1 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">{s.name}</span>
                {s.rotateAt && <a href={s.rotateAt} target="_blank" rel="noopener noreferrer" className="truncate text-pine underline-offset-2 hover:underline">{s.rotateAt.replace(/^https?:\/\//, "")}</a>}
              </div>
              {s.sikrets && <div className="flex flex-wrap gap-1">{s.sikrets.map((c) => <code key={c} className="rounded bg-cream px-1.5 font-mono text-[11.5px]">{c}</code>)}</div>}
            </li>
          ))}
        </ul>
      ) : r.vulns?.length ? (
        <ul className="divide-y divide-line-soft">
          {r.vulns.map((v) => (
            <li key={v.id} className="px-3 py-2">
              <span className="font-mono text-[11.5px] text-rust">{v.id}</span> <span className="text-ink-soft">{v.summary}</span>
              {v.fixedIn?.length ? <span className="ml-1 font-mono text-[11px] text-faint">fixed in {v.fixedIn.join(", ")}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <pre className="whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11.5px] text-ink-soft">{withSecrets(r.text ?? JSON.stringify(r, null, 2))}</pre>
      )}
    </div>
  );
}
