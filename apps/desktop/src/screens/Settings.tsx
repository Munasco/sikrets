import { useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, CircleDashed, FolderOpen, Loader2, Terminal } from "lucide-react";
import { chooseProject, openTerminal, sikrets, type Info, type Recovery } from "../api.ts";
import { savedTheme, setTheme, type Theme } from "../theme.ts";
import { Button, Chip, message, Panel, Segmented, Snippet, shown, useLoad, useToast, useRefresh } from "../ui.tsx";

// Project folder, recovery status (setup runs in Terminal: the code is shown once, to a person),
// how to connect ChatGPT and Claude to this project over MCP, and the theme.

/** A settings group: a plain heading over a card, like macOS settings. */
function Group({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between px-0.5">
        <h2 className="text-[12.5px] font-medium text-ink-soft">{title}</h2>
        {aside}
      </div>
      <Panel>{children}</Panel>
    </section>
  );
}

const RECOVERY_NOTE: Record<Recovery["state"], string> = {
  ok: "A code you keep offline restores your vault on a new Mac.",
  "not set up": "Without it, losing this Mac loses the vault key.",
  mismatch: "Unlocks a different key than this device's. Rotate it.",
  used: "This code was used to restore. Rotate it for a fresh one.",
  "no key on this device": "This Mac has no vault key yet. Restore with: sikrets recovery restore",
};

export function Settings({ info }: { info: Info }) {
  const toast = useToast();
  const refresh = useRefresh();
  const recovery = useLoad(() => (info.project ? sikrets<Recovery>(["recovery", "status"]) : Promise.resolve(undefined)), [info.project]);
  const [initBusy, setInitBusy] = useState(false);
  const [client, setClient] = useState<"claude-code" | "claude-desktop" | "chatgpt">("claude-code");
  const [theme, pickTheme] = useState<Theme>(savedTheme);

  const cli = info.cliPath || "sikrets";
  const root = info.project ?? "";
  const q = (s: string) => (/[^\w/.~-]/.test(s) ? `"${s}"` : s);
  // Shell commands can say ~ for the home folder; the JSON config can't.
  const sh = (s: string) => q(s.replace(/^\/Users\/[^/]+(?=\/)/, "~"));

  const snippets = {
    "claude-code": `claude mcp add sikrets -- ${sh(cli)} mcp --root ${sh(root)}`,
    "claude-desktop": JSON.stringify({ mcpServers: { sikrets: { command: cli, args: ["mcp", "--root", root] } } }, null, 2),
    chatgpt: `codex mcp add sikrets -- ${sh(cli)} mcp --root ${sh(root)}`,
  };

  const r = shown(recovery);
  const recoveryError = recovery.status === "error" ? recovery.error : undefined;
  const recoveryIcon = !info.project ? <CircleDashed className="size-4 shrink-0 text-dim" /> : !r && !recoveryError ? <Loader2 className="size-4 shrink-0 animate-spin text-dim" /> : r?.state === "ok" ? <CheckCircle2 className="size-4 shrink-0 text-pine" /> : <CircleAlert className="size-4 shrink-0 text-amber" />;
  return (
    <div className="flex max-w-[880px] flex-col gap-5 p-5">
      <Group title="Project">
        <div className="flex min-h-[52px] items-center gap-3 p-3">
          <FolderOpen className="size-4 shrink-0 text-dim" />
          {info.project ? <span className="selectable min-w-0 flex-1 truncate font-mono text-[12px]">{info.project}</span> : <span className="min-w-0 flex-1 text-[13px] text-ink-soft">No project folder chosen</span>}
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
          <Button variant={info.project ? "quiet" : "primary"} onClick={() => chooseProject().then((p) => p && refresh(), (e) => toast(`Couldn't switch project: ${message(e)}`, "bad"))}>
            {info.project ? "Change" : "Choose…"}
          </Button>
        </div>
      </Group>

      <Group title="Recovery">
        {!info.project ? (
          <div className="flex min-h-[52px] items-center gap-3 p-3">
            {recoveryIcon}
            <p className="text-[13px] text-ink-soft">Choose a project to check recovery.</p>
          </div>
        ) : (
          <div className="flex min-h-[52px] items-center gap-3 p-3">
            {recoveryIcon}
            <div className="min-w-0 flex-1">
              <p className="text-[13px]">{recoveryError ? "Couldn't check" : !r ? "Checking…" : r.setUp ? `Set up ${r.createdAt?.slice(0, 10)}${r.split ? " · split 2 of 3" : ""}` : "Not set up"}</p>
              <p className="text-[12px] text-ink-soft">{recoveryError ? message(recoveryError) : r ? RECOVERY_NOTE[r.state] : null}</p>
            </div>
            {r && (
              <Button variant={r.state === "ok" ? "quiet" : "primary"} onClick={() => openTerminal(["recovery", r.setUp ? "rotate" : "setup"]).catch((e) => toast(message(e), "bad"))}>
                <Terminal className="size-3.5" /> {r.setUp ? "Rotate code" : "Set up"}
              </Button>
            )}
          </div>
        )}
      </Group>

      <Group title="Connect an AI app">
        <div className="flex flex-col gap-2.5 p-3">
          <Segmented
            role="tablist"
            label="AI app"
            value={client}
            onChange={setClient}
            options={[
              ["claude-code", "Claude Code"],
              ["claude-desktop", "Claude Desktop"],
              ["chatgpt", "ChatGPT · Codex"],
            ]}
          />
          {info.project ? (
            <>
              <Snippet text={snippets[client]} label={client === "claude-desktop" ? "Copy config" : "Copy command"} />
              <p className="text-[12px] text-ink-soft">
                {client === "claude-desktop" ? "Paste into ~/Library/Application Support/Claude/claude_desktop_config.json, then restart Claude." : client === "chatgpt" ? "Run in Terminal. Codex then runs commands with your keys without seeing them." : "Run in Terminal, in any folder."}
              </p>
            </>
          ) : (
            <p className="text-[12px] text-ink-soft">Choose a project to get its connection command.</p>
          )}
        </div>
      </Group>

      <Group title="Appearance">
        <div className="flex min-h-[52px] flex-wrap items-center justify-between gap-3 p-3">
          <span className="text-[13px]">Theme</span>
          <Segmented
            label="Theme"
            value={theme}
            onChange={(id) => {
              setTheme(id);
              pickTheme(id);
            }}
            options={[
              ["system", "System"],
              ["light", "Light"],
              ["dark", "Dark"],
            ]}
          />
        </div>
      </Group>

      <Group title="Command line" aside={<span className="font-mono text-[11px] text-dim tabular-nums">v{info.version}</span>}>
        <div className="flex flex-col gap-2.5 p-3">
          <Snippet text={`ln -sf ${sh(cli)} /usr/local/bin/sikrets`} label="Copy command" />
          <p className="text-[12px] text-ink-soft">Puts the bundled CLI on your PATH.</p>
        </div>
      </Group>
    </div>
  );
}
