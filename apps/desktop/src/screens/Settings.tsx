import { useState } from "react";
import { CheckCircle2, CircleAlert, FolderOpen, Terminal } from "lucide-react";
import { chooseProject, openTerminal, sikrets, type Info, type Recovery } from "../api.ts";
import { savedTheme, setTheme, type Theme } from "../theme.ts";
import { Button, Chip, cn, ErrorLine, message, Panel, Snippet, useLoad, useToast, useRefresh } from "../ui.tsx";

// Project folder, recovery status (setup runs in Terminal: the code is shown once, to a person),
// and how to connect ChatGPT and Claude to this project over MCP.

export function Settings({ info }: { info: Info }) {
  const toast = useToast();
  const refresh = useRefresh();
  const recovery = useLoad(() => sikrets<Recovery>(["recovery", "status"]));
  const [initBusy, setInitBusy] = useState(false);
  const [client, setClient] = useState<"claude-code" | "claude-desktop" | "chatgpt">("claude-code");
  const [theme, pickTheme] = useState<Theme>(savedTheme);

  const cli = info.cliPath || "sikrets";
  const root = info.project ?? "<project folder>";
  const q = (s: string) => (/[^\w/.~-]/.test(s) ? `"${s}"` : s);

  const snippets = {
    "claude-code": `claude mcp add sikrets -- ${q(cli)} mcp --root ${q(root)}`,
    "claude-desktop": JSON.stringify({ mcpServers: { sikrets: { command: cli, args: ["mcp", "--root", root] } } }, null, 2),
    chatgpt: `codex mcp add sikrets -- ${q(cli)} mcp --root ${q(root)}`,
  };

  const r = recovery.data;
  return (
    <div className="flex max-w-3xl flex-col gap-4 p-5">
      <Panel title="Project">
        <div className="flex items-center gap-3 p-3">
          <FolderOpen className="size-4 text-dim" />
          <span className="selectable min-w-0 flex-1 truncate font-mono text-[12px]">{info.project ?? "None chosen"}</span>
          {info.project && (info.initialized ? <Chip tone="good">sikrets.json</Chip> : <Chip tone="warn">not set up</Chip>)}
          {info.project && !info.initialized && (
            <Button
              variant="primary"
              busy={initBusy}
              onClick={async () => {
                setInitBusy(true);
                try {
                  await sikrets(["init", "--vault", "keychain"]);
                  toast("Created sikrets.json");
                  refresh();
                } catch (e) {
                  toast(message(e), "bad");
                } finally {
                  setInitBusy(false);
                }
              }}
            >
              Set up here
            </Button>
          )}
          <Button onClick={async () => (await chooseProject()) && refresh()}>Change</Button>
        </div>
      </Panel>

      <Panel title="Recovery">
        <div className="flex items-center gap-3 p-3">
          {r?.setUp ? <CheckCircle2 className="size-4 text-pine" /> : <CircleAlert className="size-4 text-amber" />}
          <div className="min-w-0 flex-1">
            <p className="text-[13px]">{!r ? "Checking…" : r.setUp ? `Set up ${r.createdAt?.slice(0, 10)}${r.split ? " · split 2 of 3" : ""}` : "Not set up"}</p>
            <p className="text-[12px] text-dim">
              {r?.setUp ? (r.matchesThisDevice === false ? "Unlocks a different key than this device's. Rotate it." : "A code you keep offline restores your vault on a new Mac.") : "Without it, losing this Mac loses the vault key."}
            </p>
          </div>
          {r && (
            <Button variant={r.setUp ? "quiet" : "primary"} onClick={() => openTerminal(["recovery", r.setUp ? "rotate" : "setup"]).catch((e) => toast(message(e), "bad"))}>
              <Terminal className="size-3.5" /> {r.setUp ? "Rotate code" : "Set up"}
            </Button>
          )}
        </div>
        <ErrorLine error={recovery.error} />
      </Panel>

      <Panel title="Connect an AI app">
        <div className="flex flex-col gap-3 p-3">
          <div className="flex gap-1 rounded-md border border-line bg-paper p-0.5 text-[12px]" role="tablist">
            {(
              [
                ["claude-code", "Claude Code"],
                ["claude-desktop", "Claude Desktop"],
                ["chatgpt", "ChatGPT · Codex"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={client === id} type="button" onClick={() => setClient(id)} className={cn("h-6 flex-1 rounded", client === id ? "bg-white text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-dim hover:text-ink")}>
                {label}
              </button>
            ))}
          </div>
          <Snippet text={snippets[client]} label={client === "claude-desktop" ? "Copy config" : "Copy command"} />
          <p className="text-[12px] text-dim">
            {client === "claude-desktop" ? "Paste into ~/Library/Application Support/Claude/claude_desktop_config.json, then restart Claude." : client === "chatgpt" ? "Run in Terminal. Codex then runs commands with your keys without seeing them." : "Run in Terminal, in any folder."}
          </p>
        </div>
      </Panel>

      <Panel title="Appearance">
        <div className="p-3">
          <div className="flex w-64 gap-1 rounded-md border border-line bg-paper p-0.5 text-[12px]" role="radiogroup" aria-label="Appearance">
            {(
              [
                ["system", "System"],
                ["light", "Light"],
                ["dark", "Dark"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="radio"
                aria-checked={theme === id}
                type="button"
                onClick={() => {
                  setTheme(id);
                  pickTheme(id);
                }}
                className={cn("h-6 flex-1 rounded", theme === id ? "bg-white text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-dim hover:text-ink")}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </Panel>

      <Panel title="Command line">
        <div className="flex flex-col gap-2 p-3">
          <Snippet text={`ln -sf ${q(cli)} /usr/local/bin/sikrets`} label="Copy command" />
          <p className="text-[12px] text-dim">Puts the bundled CLI on your PATH. v{info.version}</p>
        </div>
      </Panel>
    </div>
  );
}
