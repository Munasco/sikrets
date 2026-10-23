import { FlowError } from "./flow.ts";
import type { Box, Driver, Target } from "./driver.ts";

// Driver over Open Browser Use: its Chrome extension + native host forward DevTools Protocol
// commands to a tab in one of your real Chrome profiles, already signed in. Each Sikrets run gets
// its own tab group (session) that is closed when the flow finishes.

interface ObuOptions {
  /** Chrome profile directory or display name, e.g. "Profile 1" or "ekogenie.com". */
  readonly profile: string;
  readonly session?: string;
  readonly timeoutMs?: number;
}

async function obu(args: readonly string[], timeoutMs: number): Promise<unknown> {
  const bin = Bun.which("obu") ?? Bun.which("open-browser-use");
  if (!bin) throw new FlowError("driver", "browser", "Open Browser Use isn't installed (npm i -g open-browser-use)");
  const proc = Bun.spawn([bin, ...args, "--timeout", `${Math.ceil(timeoutMs / 1000)}s`], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 || /no .*socket found/i.test(out + err)) {
    const hint = /socket/i.test(out + err) ? "Open Chrome with that profile and make sure the Open Browser Use extension is on" : (out + err).trim().slice(0, 200);
    throw new FlowError("driver", "browser", hint);
  }
  const body = JSON.parse(out) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new FlowError("driver", "browser", body.error.message ?? "obu error");
  return body.result;
}

// Runs inside the page: resolves a Target to the first visible element and scrolls it into view.
const FIND = `(t) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  let els;
  if (t.css) els = [...document.querySelectorAll(t.css)];
  else {
    const sel = { button: "button,[role=button],input[type=submit]", link: "a,[role=link]",
      textbox: "input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,[contenteditable=true],[role=textbox]",
      dialog: "dialog[open],[role=dialog],[aria-modal=true]" }[t.role];
    const name = (el) => (el.getAttribute("aria-label") || el.labels?.[0]?.innerText || el.placeholder || el.innerText || el.value || "").trim();
    const re = t.source !== undefined ? new RegExp(t.source, t.flags) : null;
    els = [...document.querySelectorAll(sel)].filter((el) => (re ? re.test(name(el)) : name(el) === t.name));
  }
  const el = els.find(visible);
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}`;

const serialize = (t: Target) =>
  "css" in t ? { css: t.css } : t.name instanceof RegExp ? { role: t.role, source: t.name.source, flags: t.name.flags } : { role: t.role, name: t.name };

export async function openObu(url: string, opts: ObuOptions): Promise<Driver> {
  const session = opts.session ?? `sikrets-${Date.now().toString(36)}`;
  const timeout = opts.timeoutMs ?? 20_000;
  const base = ["--session-id", session];

  await obu(["open-tab", ...base, "--profile", opts.profile, "--url", url], timeout);
  const tabs = (await obu(["tabs", ...base], timeout)) as { id: number }[];
  const tab = tabs.at(-1)?.id;
  if (tab === undefined) throw new FlowError("driver", "browser", "obu opened no tab");

  const cdp = (method: string, params: unknown = {}) => obu(["cdp", ...base, "--tab-id", String(tab), "--method", method, "--params", JSON.stringify(params)], timeout);
  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = (await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as { result: { value?: T }; exceptionDetails?: { text?: string } };
    if (r.exceptionDetails) throw new FlowError("driver", "browser", `page script failed: ${r.exceptionDetails.text ?? "exception"}`);
    return r.result.value as T;
  };
  const mouse = (type: string, x: number, y: number) => cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  // Chrome only hit-tests synthetic input in the foreground tab, so every input starts by focusing ours.
  const front = () => cdp("Page.bringToFront");
  // A navigation counts as finished only when a *new* document (without our marker) is fully loaded;
  // checking readyState alone races with the old page, which still reports "complete".
  const MARK = "__sikretsDoc";
  const waitLoaded = async (fromMarked: boolean) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const s = await evaluate<{ ready: string; marked: boolean }>(`({ ready: document.readyState, marked: Boolean(window.${MARK}) })`).catch(() => undefined);
      if (s && s.ready === "complete" && !(fromMarked && s.marked)) {
        await evaluate(`window.${MARK} = true`);
        return;
      }
      await Bun.sleep(150);
    }
    throw new FlowError("timeout", "navigate", `page didn't finish loading within ${timeout}ms`);
  };

  const driver: Driver = {
    kind: "obu",
    async goto(next) {
      await evaluate(`window.${MARK} = true`);
      await cdp("Page.navigate", { url: next });
      await waitLoaded(true);
    },
    url: () => evaluate<string>("location.href"),
    find: (target) => evaluate<Box | null>(`(${FIND})(${JSON.stringify(serialize(target))})`),
    async click(target) {
      const box = await driver.find(target);
      if (!box) throw new FlowError("missing", "click", `nothing to click: ${JSON.stringify(serialize(target))}`);
      await front();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await mouse("mouseMoved", x, y);
      await Bun.sleep(80);
      await mouse("mousePressed", x, y);
      await Bun.sleep(60);
      await mouse("mouseReleased", x, y);
    },
    async type(target, text) {
      await driver.click(target);
      // One character at a time, paced like the Playwright flows.
      for (const ch of text) {
        await cdp("Input.insertText", { text: ch });
        await Bun.sleep(60 + Math.floor(Math.random() * 70));
      }
    },
    text: (target) =>
      target
        ? evaluate<string>(`(() => { const b = (${FIND})(${JSON.stringify(serialize(target))}); if (!b) return ""; const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return (el?.closest("[role=dialog],dialog") ?? el)?.innerText ?? ""; })()`)
        : evaluate<string>("document.body.innerText"),
    async screenshot() {
      const r = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
      return Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    },
    async close() {
      await obu(["finalize-tabs", ...base, "--keep", "[]"], timeout).catch(() => undefined);
    },
  };
  await waitLoaded(false);
  return driver;
}

/** Opens a tab, runs `fn`, and always closes the tab group, whether `fn` succeeds or throws. */
export async function withObu<T>(url: string, opts: ObuOptions, fn: (driver: Driver) => Promise<T>): Promise<T> {
  const driver = await openObu(url, opts);
  try {
    return await fn(driver);
  } finally {
    await driver.close();
  }
}
