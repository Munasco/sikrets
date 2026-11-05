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

interface Live {
  server: Promise<Server>;
  ready?: Server;
  used: number;
  /** Requests (and open event streams) in flight. */
  busy: number;
  /** Undo what the start hooks set up. */
  cleanup: Array<() => void>;
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

  /** The owner's instance if it's up. */
  running(owner: Owner): Server | undefined {
    return this.live.get(owner)?.ready;
  }

  owners() {
    return [...this.live.keys()];
  }

  /** The owner's instance, started if needed, held busy until `release` is called. */
  async acquire(owner: Owner): Promise<{ server: Server; release: () => void }> {
    let entry = this.live.get(owner);
    if (!entry) {
      if (this.live.size >= (this.opts.max ?? POOL.max)) await this.evict();
      const created: Live = { server: undefined as never, used: Date.now(), busy: 0, cleanup: [] };
      created.server = this.launch(owner, created);
      entry = created;
      this.live.set(owner, entry);
      entry.server.catch(() => {
        if (this.live.get(owner) === created) this.live.delete(owner);
      });
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
    entry.ready = server;
    for (const hook of this.hooks) {
      const undo = await hook(owner, server);
      if (undo) entry.cleanup.push(undo);
    }
    return server;
  }

  /** Makes room: stops the longest-idle instance, or refuses when every one is busy. */
  private async evict() {
    const idle = [...this.live].filter(([, e]) => e.busy === 0 && e.ready).sort((a, b) => a[1].used - b[1].used);
    if (!idle.length) throw new PoolFull("Every agent slot is in use; try again in a minute.");
    this.stopOne(idle[0]![0]);
  }

  private stopOne(owner: Owner) {
    const e = this.live.get(owner);
    if (!e) return;
    this.live.delete(owner);
    for (const undo of e.cleanup) undo();
    e.ready?.stop();
  }

  /** Stops instances nobody has used for idleMs and with no chat still running. */
  async sweep(now = Date.now()) {
    for (const [owner, e] of [...this.live]) {
      if (e.busy > 0 || !e.ready || now - e.used < (this.opts.idleMs ?? POOL.idleMs)) continue;
      const active = await e.ready
        .fetch("/api/session/active")
        .then((r) => r.json() as Promise<{ data?: Record<string, unknown> }>)
        .then((d) => Object.keys(d.data ?? {}).length > 0, () => false);
      if (!active && e.busy === 0) this.stopOne(owner);
    }
  }

  stop() {
    clearInterval(this.sweeper);
    for (const owner of [...this.live.keys()]) this.stopOne(owner);
  }
}
