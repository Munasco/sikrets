import { useEffect, useRef, type ReactNode } from "react";
import { BookOpen, Layers, SquarePen, TerminalSquare } from "lucide-react";
import type { Command, Skill } from "./api.ts";
import { cn } from "./ui.tsx";

// The composer's pickers, the t3code way (MIT, pingdotgg/t3code; behaviour only, our own code):
// `$` anywhere opens the skills, `/` at the start of the message opens the commands; the list
// filters as you type (exact, then prefix, then word start, then substring, then in order), arrows
// wrap, Enter or Tab picks, Esc closes. A picked skill stays in the text as `$id` and is sent as a
// skill attachment; a picked command becomes `/name ` and its arguments follow.

export type Trigger = { kind: "skill" | "command"; query: string; start: number; end: number };

/** The `$…` or leading `/…` token the caret is in, if any. `$5`-style amounts don't count. */
export function trigger(text: string, caret: number): Trigger | undefined {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  const token = text.slice(start, caret);
  const skill = /^\$([a-z][a-z0-9-]*)?$/i.exec(token);
  if (skill) return { kind: "skill", query: skill[1] ?? "", start, end: caret };
  const command = /^\/([a-z0-9-]*)$/i.exec(token);
  if (command && !text.slice(0, start).trim()) return { kind: "command", query: command[1]!, start, end: caret };
  return undefined;
}

/** Lower is better; undefined is no match. */
function score(name: string, query: string, description = ""): number | undefined {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 0;
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.split(/[-_\s]/).some((w) => w.startsWith(q))) return 2;
  if (n.includes(q)) return 3;
  let i = 0;
  for (const c of n) if (c === q[i]) i++;
  if (i === q.length) return 4;
  return description.toLowerCase().includes(q) ? 5 : undefined;
}

export type Item =
  | { kind: "skill"; key: string; skill: Skill }
  | { kind: "command"; key: string; command: Command }
  | { kind: "builtin"; key: string; name: "new" | "compact"; description: string };

/** Commands the page runs itself. */
export const BUILTINS: Array<Extract<Item, { kind: "builtin" }>> = [
  { kind: "builtin", key: "b:new", name: "new", description: "Start a new chat" },
  { kind: "builtin", key: "b:compact", name: "compact", description: "Summarise this chat to free up room" },
];

export function items(t: Trigger, skills: Skill[], commands: Command[]): Item[] {
  const ranked = <T,>(list: T[], name: (x: T) => string, desc: (x: T) => string | undefined) =>
    list
      .map((x) => ({ x, s: score(name(x), t.query, desc(x)) }))
      .filter((r): r is { x: T; s: number } => r.s !== undefined)
      .sort((a, b) => a.s - b.s || name(a.x).localeCompare(name(b.x)))
      .map((r) => r.x);
  if (t.kind === "skill") return ranked(skills, (s) => s.id, (s) => `${s.name} ${s.description ?? ""}`).map((skill) => ({ kind: "skill", key: `s:${skill.id}`, skill }));
  const all: Item[] = [...BUILTINS, ...commands.map((command) => ({ kind: "command" as const, key: `c:${command.name}`, command }))];
  return ranked(all, (i) => (i.kind === "command" ? i.command.name : i.kind === "builtin" ? i.name : ""), (i) => (i.kind === "command" ? i.command.description : i.kind === "builtin" ? i.description : ""));
}

/** Skill ids mentioned as `$id` in a message, known ones only, in order. */
export function mentioned(text: string, skills: Skill[]): string[] {
  const known = new Set(skills.map((s) => s.id));
  return [...new Set([...text.matchAll(/(?<![\w$])\$([a-z0-9][a-z0-9-]*)/gi)].map((m) => m[1]!).filter((id) => known.has(id)))];
}

/** A message's text with known `$skill` mentions shown as chips; `render` handles the rest. */
export function withSkills(text: string, skills: Skill[], render: (s: string, key: string) => ReactNode[]): ReactNode[] {
  const known = new Map(skills.map((s) => [s.id, s]));
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/(?<![\w$])\$([a-z0-9][a-z0-9-]*)/gi)) {
    const skill = known.get(m[1]!);
    if (!skill) continue;
    if (m.index! > last) out.push(...render(text.slice(last, m.index), `t${last}`));
    out.push(<SkillChip key={`k${m.index}`} skill={skill} />);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(...render(text.slice(last), `t${last}`));
  return out;
}

export function SkillChip({ skill }: { skill: Skill }) {
  return (
    <span title={skill.description} className="mx-0.5 inline-flex translate-y-[-1px] items-center gap-1 rounded-md border border-pine/15 bg-white px-1.5 py-px align-middle text-[12px] font-medium leading-[18px] text-pine">
      <BookOpen className="size-3" strokeWidth={2} aria-hidden />
      {skill.name}
    </span>
  );
}

export function Menu({ items, active, onPick, onHover, kind }: { items: Item[]; active: number; onPick: (i: Item) => void; onHover: (n: number) => void; kind: Trigger["kind"] }) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-xl border border-line bg-white shadow-[0_8px_24px_-12px_rgb(20_30_25/25%)]">
      <p className="px-3 pt-2 font-mono text-[10.5px] uppercase tracking-[0.08em] text-faint">{kind === "skill" ? "Skills" : "Commands"}</p>
      {items.length === 0 ? (
        <p className="px-3 pb-2.5 pt-1 text-[12.5px] text-faint">No matches</p>
      ) : (
        <ul ref={list} role="listbox" id="composer-menu" aria-label={kind === "skill" ? "Skills" : "Commands"} className="max-h-64 overflow-y-auto p-1">
          {items.map((item, i) => {
            const { icon: Icon, label, detail } =
              item.kind === "skill"
                ? { icon: BookOpen, label: `$${item.skill.id}`, detail: item.skill.description ?? item.skill.name }
                : item.kind === "command"
                  ? { icon: TerminalSquare, label: `/${item.command.name}${item.command.hint ? ` ${item.command.hint}` : ""}`, detail: item.command.description }
                  : { icon: item.name === "new" ? SquarePen : Layers, label: `/${item.name}`, detail: item.description };
            return (
              <li key={item.key} role="option" id={`composer-item-${i}`} data-index={i} aria-selected={i === active} onMouseDown={(e) => (e.preventDefault(), onPick(item))} onMouseMove={() => onHover(i)} className={cn("flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5", i === active && "bg-cream")}>
                <Icon className="size-4 shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
                <span className="shrink-0 font-mono text-[12.5px] text-ink">{label}</span>
                {detail && <span className="min-w-0 truncate text-[12.5px] text-faint">{detail}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
