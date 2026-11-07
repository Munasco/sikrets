import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OPENCODE, POOL } from "./constants.ts";
import { capabilities, start, type Capabilities, type Options, type Server } from "./opencode.ts";
import { detect, type Mode } from "./sandbox.ts";

// One opencode per owner (login), started on their first request and stopped when idle. Each runs
// confined (src/sandbox.ts) in its own home under OPENCODE.home/owners/, with its own uid where
// the gateway can give it one, its own server password and its own model-relay token: nothing
// secret is shared between instances, and no instance can see another's files, sessions or
// processes. The gateway routes each owner's requests to their instance only (src/proxy.ts).

export type Owner = string;

export interface PoolOptions {
  /** The gateway's state directory; owners' homes go under it. */
  root?: string;
  /** Settings every instance starts with (model, MCP servers, skills, plugins). */
  base?: Omit<Options, "home" | "sandbox">;
  /** Starts one instance; tests wrap it. */
  launch?: (opts: Options) => Promise<Server>;
  /** Force a sandbox mode instead of detecting one. */
  mode?: Mode;
  /** More read-only paths for every sandbox. */
  readOnly?: string[];
  /** Paths every sandbox may write: tests only. */
  shared?: string[];
  idleMs?: number;
  max?: number;
  /** Quiet the warning when isolation is off (tests). */
  quiet?: boolean;
}

/** An instance's lifecycle. `starting` covers the launch and the start hooks; only `ready` serves
 * `running()`; `stopped` is final (stopped, evicted, swept, or the process died). */
type Status = "starting" | "ready" | "stopped";

interface Live {
  status: Status;
  server: Promise<Server>;
  /** The process, once launched (still `starting` while the hooks run). */
  instance?: Server;
  used: number;
  /** Requests (and open event streams) in flight. */
  busy: number;
  /** Undo what the start hooks set up. */
  cleanup: Array<() => void>;
}

const NEXT: Record<Status, Status[]> = { starting: ["ready", "stopped"], ready: ["stopped"], stopped: [] };

/** Moves an instance to its next status; false (and no change) for a move that isn't allowed. */
function transition(e: Live, to: Status): boolean {
  if (!NEXT[e.status].includes(to)) return false;
  e.status = to;
  return true;
}

/** Called for each instance once it's up; may return a function to call when it stops. */
export type StartHook = (owner: Owner, server: Server) => void | (() => void) | Promise<void | (() => void)>;

export class PoolFull extends Error {}

export class Pool {
  readonly root: string;
  readonly mode: Mode;
  /** The skills and MCP servers every instance has (the same config for everyone). */
  readonly capabilities: Capabilities;
  private live = new Map<Owner, Live>();
  private hooks: StartHook[] = [];
  private sweeper: ReturnType<typeof setInterval>;
  private uids: Record<string, number> = {};

  constructor(private opts: PoolOptions = {}) {
    this.root = opts.root ?? OPENCODE.home;
    // Owners' uids must pass through the root to reach their own homes (0700 each), but can't list it.
    mkdirSync(path.join(this.root, OPENCODE.ownersDir), { recursive: true, mode: 0o711 });
    for (const d of [this.root, path.join(this.root, OPENCODE.ownersDir)]) chmodSync(d, 0o711);
    this.root = realpathSync(this.root);
    const found = opts.mode ? { mode: opts.mode } : detect();
    this.mode = found.mode;
    if (this.mode === "none" && !opts.quiet) console.warn(`Warning: isolation between owners is off (${"why" in found ? found.why : "forced"}). Each owner gets their own opencode process and directory, but they run as the same user and can see each other's processes. Never serve more than one person like this.`);
    else if ("why" in found && found.why && !opts.quiet) console.warn(`Warning: isolation between owners is partial: ${found.why}.`);
    this.capabilities = capabilities(opts.base);
    try {
      this.uids = JSON.parse(readFileSync(path.join(this.root, POOL.uidsFile), "utf8")) as Record<string, number>;
    } catch {}
    this.sweeper = setInterval(() => void this.sweep(), POOL.sweepMs);
    this.sweeper.unref?.();
  }

  /** Runs `hook` for every instance that starts from now on. */
  use(hook: StartHook) {
    this.hooks.push(hook);
  }

  /** An owner's home: named by a hash, so the owner id itself never becomes a path. */
  home(owner: Owner) {
    return path.join(this.root, OPENCODE.ownersDir, createHash("sha256").update(owner).digest("hex").slice(0, 24));
  }

  /** The owner's own uid, assigned once and remembered. */
  private uid(owner: Owner): number | undefined {
    if (this.mode !== "bwrap" && this.mode !== "uid") return undefined;
    const key = path.basename(this.home(owner));
    if (this.uids[key] === undefined) {
      this.uids[key] = POOL.uidBase + Object.keys(this.uids).length;
      writeFileSync(path.join(this.root, POOL.uidsFile), JSON.stringify(this.uids), { mode: 0o600 });
    }
    return this.uids[key];
  }

  /** The owner's instance if it's up and its start hooks have run. */
  running(owner: Owner): Server | undefined {
    const e = this.live.get(owner);
    return e?.status === "ready" ? e.instance : undefined;
  }

  owners() {
    return [...this.live.keys()];
  }

  /** The owner's instance, started if needed, held busy until `release` is called. */
  async acquire(owner: Owner): Promise<{ server: Server; release: () => void }> {
    let entry = this.live.get(owner);
    if (!entry) {
      // In the map before anything is awaited, so a second request from the same owner waits for
      // this start instead of launching a second instance.
      const created: Live = { status: "starting", server: undefined as never, used: Date.now(), busy: 0, cleanup: [] };
      this.live.set(owner, created);
      created.server = (async () => {
        if (this.live.size > (this.opts.max ?? POOL.max)) await this.evict(owner);
        return this.launch(owner, created);
      })();
      entry = created;
      created.server.catch(() => this.drop(owner, created));
    }
    entry.busy++;
    entry.used = Date.now();
    let server: Server;
    try {
      server = await entry.server;
    } catch (e) {
      entry.busy--;
      throw e;
    }
    let done = false;
    const held = entry;
    return {
      server,
      release: () => {
        if (done) return;
        done = true;
        held.busy--;
        held.used = Date.now();
      },
    };
  }

  private async launch(owner: Owner, entry: Live): Promise<Server> {
    const launch = this.opts.launch ?? start;
    const server = await launch({ ...this.opts.base, home: this.home(owner), sandbox: { mode: this.mode, uid: this.uid(owner), readOnly: this.opts.readOnly, shared: this.opts.shared } });
    entry.instance = server;
    // A process that dies (crash, OOM, killed) takes its entry with it, so the next request starts
    // a fresh one instead of going to a dead port.
    void server.exited.then(() => this.drop(owner, entry));
    try {
      if (entry.status !== "starting") throw new Error("stopped while starting");
      for (const hook of this.hooks) {
        const undo = await hook(owner, server);
        if (undo) entry.cleanup.push(undo);
        if (entry.status !== "starting") throw new Error("stopped while starting");
      }
    } catch (e) {
      // Undo the hooks that ran and stop the process: nothing may outlive a failed start.
      this.drop(owner, entry);
      throw e;
    }
    transition(entry, "ready");
    return server;
  }

  /** No running chat and no request in flight. */
  private async idle(e: Live): Promise<boolean> {
    if (e.busy > 0 || e.status !== "ready" || !e.instance) return false;
    const active = await e.instance
      .fetch("/api/session/active")
      .then((r) => r.json() as Promise<{ data?: Record<string, unknown> }>)
      .then((d) => Object.keys(d.data ?? {}).length > 0, () => false);
    return !active && e.busy === 0 && e.status === "ready";
  }

  /** Makes room for `owner`: stops the longest-idle instance with no chat running, or refuses
   * when every one is in use. */
  private async evict(owner: Owner) {
    const others = [...this.live].filter(([o, e]) => o !== owner && e.status === "ready").sort((a, b) => a[1].used - b[1].used);
    for (const [o, e] of others) {
      if (!(await this.idle(e))) continue;
      this.drop(o, e);
      return;
    }
    throw new PoolFull("Every agent slot is in use; try again in a minute.");
  }

  /** Stops this entry (not a newer one for the same owner) and forgets it. Safe to call again,
   * e.g. when a start that was stopped midway finishes launching. */
  private drop(owner: Owner, e: Live) {
    if (this.live.get(owner) === e) this.live.delete(owner);
    transition(e, "stopped");
    for (const undo of e.cleanup.splice(0)) {
      try {
        undo();
      } catch {}
    }
    e.instance?.stop();
  }

  /** Stops the owner's instance, if one is running or starting (logout, a failed MCP switch). */
  stopOwner(owner: Owner) {
    const e = this.live.get(owner);
    if (e) this.drop(owner, e);
  }

  /** Stops instances nobody has used for idleMs and with no chat still running. */
  async sweep(now = Date.now()) {
    for (const [owner, e] of [...this.live]) {
      if (now - e.used < (this.opts.idleMs ?? POOL.idleMs)) continue;
      // drop() only stops this entry: if it was replaced while idle() waited, the new one stays.
      if (await this.idle(e)) this.drop(owner, e);
    }
  }

  stop() {
    clearInterval(this.sweeper);
    for (const [owner, e] of [...this.live]) this.drop(owner, e);
  }
}
