import { Tabs } from "expo-router/js-tabs";
import { COLORS, FONTS } from "../../src/constants";
import { useSikrets } from "../../src/state";
import { Icon } from "../../src/ui";

export default function TabsLayout() {
  const { requests, sent } = useSikrets();
  const waiting = requests.filter((r) => r.challenge && !sent[r.id]).length;
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: COLORS.background },
        headerTitleStyle: { fontFamily: FONTS.semibold, color: COLORS.ink },
        headerShadowVisible: false,
        tabBarActiveTintColor: COLORS.forest,
        tabBarInactiveTintColor: COLORS.muted,
        tabBarStyle: { backgroundColor: COLORS.background, borderTopColor: COLORS.line },
        tabBarLabelStyle: { fontFamily: FONTS.medium, fontSize: 11 },
        sceneStyle: { backgroundColor: COLORS.background },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Approvals",
          tabBarBadge: waiting || undefined,
          tabBarBadgeStyle: { backgroundColor: COLORS.forest },
          tabBarIcon: ({ color }) => <Icon name="approvals" color={color} />,
        }}
      />
      <Tabs.Screen name="keys" options={{ title: "Keys", tabBarIcon: ({ color }) => <Icon name="keys" color={color} /> }} />
      <Tabs.Screen name="chat" options={{ title: "Agent", tabBarIcon: ({ color }) => <Icon name="chat" color={color} /> }} />
      <Tabs.Screen name="pair" options={{ title: "Pair", tabBarIcon: ({ color }) => <Icon name="pair" color={color} /> }} />
    </Tabs>
  );
}
