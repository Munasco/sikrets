import { useEffect, useRef } from "react";
import { ExternalLink, MessageSquare } from "lucide-react";
import { agentView, inTauri } from "../api.ts";
import { Logo } from "../ui.tsx";

// The security agent's chat runs in its own webview over this area (it refuses to be framed).
// The Rust side places it at the box's bounds and hides it when another screen opens.

export const AGENT_URL = "https://dan27asb93qem.cloudfront.net";

export function AgentChat() {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || !inTauri) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      agentView.show({ x: r.left, y: r.top, width: r.width, height: r.height }).catch(() => {});
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      agentView.hide().catch(() => {});
    };
  }, []);

  return (
    <div ref={box} className="relative h-full w-full bg-white">
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
