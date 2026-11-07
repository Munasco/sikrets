import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { AAD, MESSAGE_IDS, PROTOCOL_VERSION, mailbox, messageId, open, relayClient, seal, sessionKey, signDecision, type KeyView, type RequestView, type Snapshot, type UnpairNotice } from "@sikrets/pairing";
import { ANSWER_TTL_SECONDS, COPY, POLL_MS, SENT_MEMORY, STORAGE } from "./constants";
import { forget, loadPairing, pairWith, unlockSigningKey, type StoredPairing } from "./vault";

// App state: the pairing, the latest snapshot from each project, and answers sent but not yet seen
// applied. Sent answers are kept in the keychain by request and challenge: they survive a restart,
// and a request that reopens with a new challenge (a failed rotation) can be answered again. Polls the relay while the app is open. Real push needs an Apple developer account, so
// for now a local notification fires when a new request shows up during a poll.

export interface ProjectRequest extends RequestView {
  project: string;
}

interface Ctx {
  ready: boolean;
  pairing?: StoredPairing;
  snapshots: Snapshot[];
  requests: ProjectRequest[];
  keys: (KeyView & { project: string })[];
  /** What this phone already sent for the request's current challenge, if anything. */
  sentFor(req: RequestView): "approve" | "deny" | undefined;
  lastSync?: Date;
  error?: string;
  pair(qr: string): Promise<void>;
  unpair(): Promise<void>;
  refresh(): Promise<void>;
  /** Face ID, sign and send. False when the person cancelled. */
  answer(req: ProjectRequest, decision: "approve" | "deny"): Promise<boolean>;
}

const Context = createContext<Ctx | undefined>(undefined);

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

type Sent = Record<string, "approve" | "deny">;
const sentKey = (req: Pick<RequestView, "id" | "challenge">) => `${req.id}:${req.challenge}`;

export function SikretsProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [pairing, setPairing] = useState<StoredPairing>();
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [sent, setSent] = useState<Sent>({});
  const [lastSync, setLastSync] = useState<Date>();
  const [error, setError] = useState<string>();
  const notified = useRef<Set<string>>(new Set());

  const link = useMemo(() => {
    if (!pairing) return undefined;
    return {
      box: mailbox(pairing.offer.secret),
      key: sessionKey(pairing.encSecretKey, pairing.offer.cliKey, pairing.offer.secret),
      relay: relayClient(pairing.offer.relay),
    };
  }, [pairing]);

  useEffect(() => {
    (async () => {
      setPairing(await loadPairing());
      const seen = await SecureStore.getItemAsync(STORAGE.notified).catch(() => null);
      if (seen) notified.current = new Set(JSON.parse(seen) as string[]);
      const answered = await SecureStore.getItemAsync(STORAGE.sent).catch(() => null);
      if (answered) setSent(JSON.parse(answered) as Sent);
      setReady(true);
    })();
  }, []);

  const refresh = useCallback(async () => {
    if (!link) return;
    const unpairedByLaptop = (blob: string) => {
      try {
        return open<UnpairNotice>(link.key, AAD.toPhone, blob).pairingId === link.box.pairingId;
      } catch {
        return false;
      }
    };
    try {
      const msgs = await link.relay.list(link.box.toPhone);
      const snaps: Snapshot[] = [];
      for (const m of msgs) {
        if (m.id === MESSAGE_IDS.hello) continue;
        if (m.id === MESSAGE_IDS.unpaired) {
          if (unpairedByLaptop(m.blob)) {
            await forget();
            notified.current = new Set();
            setPairing(undefined);
            setSnapshots([]);
            setSent({});
            setError(COPY.unpairedByLaptop);
            return;
          }
          continue;
        }
        try {
          snaps.push(open<Snapshot>(link.key, AAD.toPhone, m.blob));
        } catch {
          // not sealed for this phone: ignore
        }
      }
      snaps.sort((a, b) => a.project.localeCompare(b.project));
      setSnapshots(snaps);
      setLastSync(new Date());
      setError(undefined);
      const fresh = snaps.flatMap((s) => s.requests.filter((r) => r.challenge && !notified.current.has(r.id)));
      for (const r of fresh) {
        notified.current.add(r.id);
        await Notifications.scheduleNotificationAsync({ content: { title: "Sikrets", body: `${r.message}: ${r.resource}`, data: { requestId: r.id } }, trigger: null }).catch(() => undefined);
      }
      if (fresh.length) await SecureStore.setItemAsync(STORAGE.notified, JSON.stringify([...notified.current].slice(-200)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Relay unreachable");
    }
  }, [link]);

  useEffect(() => {
    if (!link) return;
    refresh();
    let timer: ReturnType<typeof setInterval> | undefined = setInterval(refresh, POLL_MS);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") {
        refresh();
        if (!timer) timer = setInterval(refresh, POLL_MS);
      } else if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    });
    return () => {
      if (timer) clearInterval(timer);
      sub.remove();
    };
  }, [link, refresh]);

  const pair = useCallback(async (qr: string) => {
    const p = await pairWith(qr);
    await Notifications.requestPermissionsAsync().catch(() => undefined);
    await SecureStore.deleteItemAsync(STORAGE.sent).catch(() => undefined);
    setSnapshots([]);
    setSent({});
    setPairing(p);
  }, []);

  const unpair = useCallback(async () => {
    // Tell the laptop, so it stops waiting on a phone that won't answer. Best effort.
    if (link) {
      const notice: UnpairNotice = { v: PROTOCOL_VERSION, pairingId: link.box.pairingId, at: new Date().toISOString() };
      await link.relay.put(link.box.toCli, MESSAGE_IDS.unpaired, seal(link.key, AAD.toCli, notice), ANSWER_TTL_SECONDS).catch(() => undefined);
    }
    await forget();
    notified.current = new Set();
    setPairing(undefined);
    setSnapshots([]);
    setSent({});
  }, [link]);

  const answer = useCallback(
    async (req: ProjectRequest, decision: "approve" | "deny") => {
      if (!pairing || !link) throw new Error("Not paired");
      const sk = await unlockSigningKey(pairing, decision === "approve" ? COPY.faceIdApprove : COPY.faceIdDeny);
      if (!sk) return false;
      const signed = signDecision(sk, { pairingId: link.box.pairingId, requestId: req.id, resource: req.resource, decision, challenge: req.challenge, issuedAt: new Date().toISOString() });
      await link.relay.put(link.box.toCli, messageId(), seal(link.key, AAD.toCli, signed), ANSWER_TTL_SECONDS);
      const next = Object.fromEntries(Object.entries({ ...sent, [sentKey(req)]: decision }).slice(-SENT_MEMORY));
      await SecureStore.setItemAsync(STORAGE.sent, JSON.stringify(next)).catch(() => undefined);
      setSent(next);
      return true;
    },
    [pairing, link, sent],
  );
  const sentFor = useCallback((req: RequestView) => (req.challenge ? sent[sentKey(req)] : undefined), [sent]);

  const requests = useMemo(() => snapshots.flatMap((s) => s.requests.map((r) => ({ ...r, project: s.project }))), [snapshots]);
  const keys = useMemo(() => snapshots.flatMap((s) => s.keys.map((k) => ({ ...k, project: s.project }))), [snapshots]);

  const value: Ctx = { ready, pairing, snapshots, requests, keys, sentFor, lastSync, error, pair, unpair, refresh, answer };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSikrets() {
  const c = useContext(Context);
  if (!c) throw new Error("useSikrets outside SikretsProvider");
  return c;
}
