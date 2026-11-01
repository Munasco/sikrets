import { Fragment, type ReactNode } from "react";
import { SecretChip } from "./ui.tsx";

// A small Markdown renderer for the agent's answers: paragraphs, lists, headings, rules, tables,
// code, bold, italics and links. React elements only (no innerHTML), and every secret placeholder
// becomes a locked chip wherever it appears.

const SECRET = /\[\[secret ([^\]#]+?) #([0-9a-f]{6,})\]\]/g;

/** Text with secret placeholders turned into chips. */
export function withSecrets(text: string, key = "s"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(SECRET)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push(<SecretChip key={`${key}-${m.index}`} redacted={m[1]!} hash={m[2]!} />);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function inline(src: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|\*\*([^*]+)\*\*|(?<![*\w])\*([^*\n]+)\*(?!\*)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<)]+[^\s<).,;:])/g;
  let last = 0;
  let i = 0;
  for (const m of src.matchAll(re)) {
    if (m.index! > last) out.push(...withSecrets(src.slice(last, m.index), `${key}t${i}`));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{withSecrets(m[1].slice(1, -1), k)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(m[2], k)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inline(m[3], k)}</em>);
    else if (m[4]) out.push(<a key={k} href={m[5]} target="_blank" rel="noopener noreferrer">{m[4]}</a>);
    else if (m[6]) out.push(<a key={k} href={m[6]} target="_blank" rel="noopener noreferrer">{m[6]}</a>);
    last = m.index! + m[0].length;
  }
  if (last < src.length) out.push(...withSecrets(src.slice(last), `${key}e`));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { kind: "ul" | "ol"; start: number; items: string[] } | undefined;
  let table: string[] = [];
  const key = () => `b${blocks.length}`;
  const flushPara = () => {
    if (para.length) blocks.push(<p key={key()}>{para.map((l, i) => <Fragment key={i}>{i > 0 && <br />}{inline(l, `${key()}l${i}`)}</Fragment>)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{inline(it, `${key()}i${i}`)}</li>);
    blocks.push(list.kind === "ol" ? <ol key={key()} start={list.start}>{items}</ol> : <ul key={key()}>{items}</ul>);
    list = undefined;
  };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map((r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    const [head, ...body] = rows;
    blocks.push(
      <table key={key()}>
        {head && <thead><tr>{head.map((c, i) => <th key={i}>{inline(c, `${key()}h${i}`)}</th>)}</tr></thead>}
        <tbody>{body.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci}>{inline(c, `${key()}c${ri}-${ci}`)}</td>)}</tr>)}</tbody>
      </table>,
    );
    table = [];
  };
  const flush = () => (flushPara(), flushList(), flushTable());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i]!);
      // Code inside a list item comes indented; drop the shared indent.
      const indent = Math.min(...code.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length), Infinity);
      blocks.push(<pre key={key()}><code>{withSecrets(code.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n"), key())}</code></pre>);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      flushList();
      table.push(line);
      continue;
    }
    flushTable();
    const h = /^#{1,4}\s+(.*)/.exec(line);
    const item = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)/.exec(line);
    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) (flush(), blocks.push(<hr key={key()} />));
    else if (h) (flush(), blocks.push(<h3 key={key()}>{inline(h[1]!, key())}</h3>));
    else if (item) {
      flushPara();
      const kind = item[1] ? "ul" : "ol";
      if (list?.kind !== kind) (flushList(), (list = { kind, start: Number(item[2] ?? 1), items: [] }));
      list!.items.push(item[3]!);
    } else if (!line.trim()) (flushPara(), flushList());
    else (flushList(), para.push(line));
  }
  flush();
  return <div className="prose-chat">{blocks}</div>;
}
