import { useContext, useEffect, useRef, useState } from "react";
import { ExternalLink, MessageSquare } from "lucide-react";
import { agentView, inTauri } from "../api.ts";
import { Button, ErrorLine, Logo, RefreshCtx } from "../ui.tsx";

// The security agent's chat runs in its own webview over this area (it refuses to be framed).
// The Rust side places it at the box's bounds and hides it when another screen opens. If it can't
// be shown, the error and a retry replace it; ⌘R reloads the chat page itself.

export const AGENT_URL = "https://agent.sikrets.usetennant.com";

export function AgentChat() {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  const { tick } = useContext(RefreshCtx);
  const firstTick = useRef(tick);

  // ⌘R (or the Reload button) reloads the chat page, not just the frame around it.
  useEffect(() => {
    if (!inTauri || tick === firstTick.current) return;
    agentView.reload().then(() => setError(undefined), setError);
  }, [tick]);

  useEffect(() => {
    const el = box.current;
    if (!el || !inTauri) return;
    let current = true;
    const place = () => {
      const r = el.getBoundingClientRect();
      agentView.show({ x: r.left, y: r.top, width: r.width, height: r.height }).then(
        () => current && setError(undefined),
        (e) => {
          if (!current) return;
          setError(e);
          agentView.hide().catch(() => {}); // a blank, half-placed view would cover the error
        },
      );
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => {
      current = false;
      ro.disconnect();
      window.removeEventListener("resize", place);
      agentView.hide().catch(() => {});
    };
  }, [attempt]);

  return (
    <div ref={box} className="relative h-full w-full bg-white">
      {error !== undefined && (
        <div className="grid h-full place-items-center p-8">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <p className="text-[14px] font-medium">Couldn't open the Guard chat</p>
            <ErrorLine error={error} />
            <Button variant="primary" onClick={() => (setError(undefined), setAttempt((n) => n + 1))}>Try again</Button>
          </div>
        </div>
      )}
      {!inTauri && (
        <div className="grid h-full place-items-center">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="grid size-10 place-items-center rounded-xl bg-forest text-cream">
              <Logo className="size-5" />
            </div>
            <p className="flex items-center gap-1.5 text-[13px] font-medium">
              <MessageSquare className="size-4 text-pine" /> Security agent
            </p>
            <p className="max-w-xs text-[12.5px] text-dim">In the app, the chat loads here in its own webview.</p>
            <a href={AGENT_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[11.5px] text-pine hover:underline">
              {AGENT_URL.replace("https://", "")} <ExternalLink className="size-3" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
