import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { AAD, MESSAGE_IDS, mailbox, messageId, open, relayClient, seal, sessionKey, signDecision, type KeyView, type RequestView, type Snapshot } from "@sikrets/pairing";
import { ANSWER_TTL_SECONDS, COPY, POLL_MS, STORAGE } from "./constants";
import { forget, loadPairing, pairWith, unlockSigningKey, type StoredPairing } from "./vault";

// App state: the pairing, the latest snapshot from each project, and answers sent but not yet seen
// applied. Polls the relay while the app is open. Real push needs an Apple developer account, so
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
  /** requestId → what this phone sent. */
  sent: Record<string, "approve" | "deny">;
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

export function SikretsProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [pairing, setPairing] = useState<StoredPairing>();
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [sent, setSent] = useState<Record<string, "approve" | "deny">>({});
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
      setReady(true);
    })();
  }, []);

  const refresh = useCallback(async () => {
    if (!link) return;
    try {
      const msgs = await link.relay.list(link.box.toPhone);
      const snaps: Snapshot[] = [];
      for (const m of msgs) {
        if (m.id === MESSAGE_IDS.hello) continue;
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
    setSnapshots([]);
    setSent({});
    setPairing(p);
  }, []);

  const unpair = useCallback(async () => {
    await forget();
    notified.current = new Set();
    setPairing(undefined);
    setSnapshots([]);
    setSent({});
  }, []);

  const answer = useCallback(
    async (req: ProjectRequest, decision: "approve" | "deny") => {
      if (!pairing || !link) throw new Error("Not paired");
      const sk = await unlockSigningKey(pairing, decision === "approve" ? COPY.faceIdApprove : COPY.faceIdDeny);
      if (!sk) return false;
      const signed = signDecision(sk, { pairingId: link.box.pairingId, requestId: req.id, resource: req.resource, decision, challenge: req.challenge, issuedAt: new Date().toISOString() });
      await link.relay.put(link.box.toCli, messageId(), seal(link.key, AAD.toCli, signed), ANSWER_TTL_SECONDS);
      setSent((s) => ({ ...s, [req.id]: decision }));
      return true;
    },
    [pairing, link],
  );

  const requests = useMemo(() => snapshots.flatMap((s) => s.requests.map((r) => ({ ...r, project: s.project }))), [snapshots]);
  const keys = useMemo(() => snapshots.flatMap((s) => s.keys.map((k) => ({ ...k, project: s.project }))), [snapshots]);

  const value: Ctx = { ready, pairing, snapshots, requests, keys, sent, lastSync, error, pair, unpair, refresh, answer };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSikrets() {
  const c = useContext(Context);
  if (!c) throw new Error("useSikrets outside SikretsProvider");
  return c;
}
