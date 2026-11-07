import "../src/polyfill";
import { Geist_400Regular } from "@expo-google-fonts/geist/400Regular";
import { Geist_500Medium } from "@expo-google-fonts/geist/500Medium";
import { Geist_600SemiBold } from "@expo-google-fonts/geist/600SemiBold";
import { GeistMono_400Regular } from "@expo-google-fonts/geist-mono/400Regular";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { COLORS, FONTS } from "../src/constants";
import { SikretsProvider } from "../src/state";

SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  const [loaded, failed] = useFonts({ Geist_400Regular, Geist_500Medium, Geist_600SemiBold, GeistMono_400Regular });
  useEffect(() => {
    if (loaded || failed) SplashScreen.hideAsync().catch(() => undefined);
  }, [loaded, failed]);
  if (!loaded && !failed) return null;
  return (
    <SikretsProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: COLORS.background },
          headerTitleStyle: { fontFamily: FONTS.semibold, color: COLORS.ink },
          headerTintColor: COLORS.forest,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: COLORS.background },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="request/[id]" options={{ title: "Request", presentation: "modal" }} />
      </Stack>
    </SikretsProvider>
  );
}
