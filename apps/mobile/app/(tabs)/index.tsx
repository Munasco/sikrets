import { router } from "expo-router";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { useState } from "react";
import { COLORS } from "../../src/constants";
import { useSikrets, type ProjectRequest } from "../../src/state";
import { Badge, Button, Card, Empty, T } from "../../src/ui";
import { statusBadge, timeLeft } from "../../src/format";

export default function Approvals() {
  const { pairing, requests, sent, refresh, error, ready } = useSikrets();
  const [refreshing, setRefreshing] = useState(false);
  if (!ready) return null;
  if (!pairing)
    return (
      <View style={{ flex: 1 }}>
        <Empty title="Pair with your laptop" detail="Run sikrets pair, then scan the code." />
        <View style={{ padding: 24 }}>
          <Button label="Scan pairing code" onPress={() => router.navigate("/pair")} />
        </View>
      </View>
    );
  const open = requests.filter((r) => r.challenge);
  const done = requests.filter((r) => !r.challenge);
  const data = [...open, ...done];
  return (
    <FlatList
      data={data}
      keyExtractor={(r) => `${r.project}/${r.id}`}
      contentContainerStyle={{ padding: 16, gap: 10, flexGrow: 1 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={COLORS.forest}
          onRefresh={async () => {
            setRefreshing(true);
            await refresh();
            setRefreshing(false);
          }}
        />
      }
      ListHeaderComponent={error ? <T variant="small" style={{ color: COLORS.danger }}>{error}</T> : undefined}
      ListEmptyComponent={<Empty title="Nothing waiting" detail="Requests from sikrets approvals watch show up here." />}
      renderItem={({ item }) => <Row req={item} sent={sent[item.id]} />}
    />
  );
}

function Row({ req, sent }: { req: ProjectRequest; sent?: "approve" | "deny" }) {
  const badge = statusBadge(req, sent);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${req.resource}, ${req.message}`} onPress={() => router.push({ pathname: "/request/[id]", params: { id: req.id, project: req.project } })}>
      <Card>
        <View style={styles.top}>
          <T variant="h3" numberOfLines={1} style={{ flex: 1 }}>
            {req.resource}
          </T>
          <Badge label={badge.label} tone={badge.tone} />
        </View>
        <T style={{ marginTop: 6 }}>{req.message}</T>
        <T variant="small" style={{ marginTop: 6 }}>
          {req.project}
          {req.challenge ? ` · ${timeLeft(req.expiresAt)}` : ""}
        </T>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({ top: { flexDirection: "row", alignItems: "center", gap: 8 } });
