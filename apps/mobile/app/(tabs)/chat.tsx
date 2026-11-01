import { ActivityIndicator, View } from "react-native";
import { WebView } from "react-native-webview";
import { AGENT_CHAT_URL, COLORS } from "../../src/constants";

// The hosted security agent's own chat UI. It asks for its access code itself.
export default function Chat() {
  return (
    <WebView
      source={{ uri: AGENT_CHAT_URL }}
      style={{ flex: 1, backgroundColor: COLORS.background }}
      startInLoadingState
      renderLoading={() => (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.background }}>
          <ActivityIndicator color={COLORS.forest} />
        </View>
      )}
      originWhitelist={["https://*"]}
      allowsBackForwardNavigationGestures
      sharedCookiesEnabled
    />
  );
}
