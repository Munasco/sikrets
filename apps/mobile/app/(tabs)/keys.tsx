import { SectionList, StyleSheet, View } from "react-native";
import { COLORS } from "../../src/constants";
import { keyTone, shortDate } from "../../src/format";
import { useSikrets } from "../../src/state";
import { Badge, Card, Empty, T } from "../../src/ui";

// Names and status only. The laptop never sends a value, so there is none to show.
export default function Keys() {
  const { pairing, snapshots } = useSikrets();
  if (!pairing) return <Empty title="Not paired" detail="Pair with your laptop to see your keys." />;
  const sections = snapshots.filter((s) => s.keys.length).map((s) => ({ title: s.project, data: s.keys }));
  return (
    <SectionList
      sections={sections}
      keyExtractor={(k, i) => `${k.name}-${i}`}
      contentContainerStyle={{ padding: 16, gap: 8, flexGrow: 1 }}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => (
        <T variant="small" style={styles.section}>
          {section.title.toUpperCase()}
        </T>
      )}
      ListEmptyComponent={<Empty title="No keys yet" detail="Run sikrets approvals watch on the laptop to send your inventory." />}
      renderItem={({ item }) => (
        <Card style={{ marginBottom: 8 }}>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <T variant="h3">{item.name}</T>
              <T variant="small" style={{ marginTop: 2 }}>
                {item.recipe}
              </T>
            </View>
            <Badge label={item.status} tone={keyTone(item)} />
          </View>
          {item.rotateBy || item.lastRotatedAt ? (
            <T variant="small" style={{ marginTop: 8 }}>
              {[item.lastRotatedAt && `Rotated ${shortDate(item.lastRotatedAt)}`, item.rotateBy && `rotate by ${shortDate(item.rotateBy)}`].filter(Boolean).join(" · ")}
            </T>
          ) : null}
        </Card>
      )}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  section: { color: COLORS.muted, letterSpacing: 0.8, marginTop: 8, marginBottom: 8 },
});
