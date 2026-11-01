import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { COLORS } from "../../src/constants";
import { statusBadge, timeLeft } from "../../src/format";
import { useSikrets } from "../../src/state";
import { Badge, Button, Card, Empty, Logo, T } from "../../src/ui";

export default function RequestDetail() {
  const { id, project } = useLocalSearchParams<{ id: string; project: string }>();
  const { requests, sent, answer } = useSikrets();
  const [busy, setBusy] = useState<"approve" | "deny">();
  const req = requests.find((r) => r.id === id && r.project === project);
  if (!req) return <Empty title="Request not found" detail="It may have expired or been decided on the laptop." />;
  const badge = statusBadge(req, sent[req.id]);
  const canAnswer = Boolean(req.challenge) && !sent[req.id] && Date.parse(req.expiresAt) > Date.now();

  const act = async (decision: "approve" | "deny") => {
    setBusy(decision);
    try {
      if (await answer(req, decision)) router.back();
    } catch (e) {
      Alert.alert("Couldn't send", e instanceof Error ? e.message : "Try again.");
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.hero}>
        <Logo size={44} />
        <T variant="h1" style={{ marginTop: 16, textAlign: "center" }}>
          {req.resource}
        </T>
        <T style={{ marginTop: 8, textAlign: "center" }}>{req.message}</T>
        <View style={{ marginTop: 12 }}>
          <Badge label={badge.label} tone={badge.tone} />
        </View>
      </View>
      <Card style={{ gap: 10 }}>
        <Line k="Project" v={req.project} />
        <Line k="Action" v="Rotate the key. The old one stops working." />
        <Line k="Expires" v={timeLeft(req.expiresAt)} />
        <Line k="Request" v={req.id} mono />
      </Card>
      {canAnswer ? (
        <View style={{ gap: 10, marginTop: 24 }}>
          <Button label="Approve with Face ID" onPress={() => act("approve")} busy={busy === "approve"} disabled={busy === "deny"} />
          <Button label="Deny" kind="danger" onPress={() => act("deny")} busy={busy === "deny"} disabled={busy === "approve"} />
        </View>
      ) : null}
    </ScrollView>
  );
}

function Line({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <View style={styles.line}>
      <T variant="small" style={{ width: 72 }}>
        {k}
      </T>
      <T variant={mono ? "mono" : "body"} style={{ flex: 1 }}>
        {v}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, paddingBottom: 48, backgroundColor: COLORS.background, flexGrow: 1 },
  hero: { alignItems: "center", paddingVertical: 24 },
  line: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
});
