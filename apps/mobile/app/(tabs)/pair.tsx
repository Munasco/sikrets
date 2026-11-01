import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { useIsFocused } from "expo-router";
import { useRef, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { OFFER_PREFIX } from "@sikrets/pairing";
import { COLORS } from "../../src/constants";
import { useSikrets } from "../../src/state";
import { Button, Card, Logo, T } from "../../src/ui";

export default function Pair() {
  const { pairing, pair, unpair, lastSync } = useSikrets();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const handled = useRef(false);
  const focused = useIsFocused();

  const onScan = async ({ data }: BarcodeScanningResult) => {
    if (handled.current || !data.startsWith(OFFER_PREFIX)) return;
    handled.current = true;
    setBusy(true);
    try {
      await pair(data);
      setScanning(false);
    } catch (e) {
      Alert.alert("Pairing failed", e instanceof Error ? e.message : "Try again.");
    } finally {
      setBusy(false);
      handled.current = false;
    }
  };

  if (scanning && focused) {
    if (!permission?.granted)
      return (
        <View style={styles.center}>
          <T style={{ textAlign: "center", marginBottom: 16 }}>Camera access scans the code on your laptop.</T>
          <Button label="Allow camera" onPress={requestPermission} />
        </View>
      );
    return (
      <View style={{ flex: 1, backgroundColor: COLORS.ink }}>
        <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={busy ? undefined : onScan} />
        <View style={styles.overlay} pointerEvents="none">
          <View style={styles.frame} />
        </View>
        <View style={styles.bottom}>
          <Button label={busy ? "Pairing…" : "Cancel"} kind="secondary" busy={busy} onPress={() => setScanning(false)} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.page}>
      <View style={{ alignItems: "center", marginTop: 24, marginBottom: 32 }}>
        <Logo size={56} />
        <T variant="h1" style={{ marginTop: 16 }}>
          {pairing ? "Paired" : "Pair your laptop"}
        </T>
        <T style={{ marginTop: 8, textAlign: "center", color: "#6d6862" }}>
          {pairing ? "Approvals reach this phone, end-to-end encrypted." : "On your laptop, run:"}
        </T>
        {!pairing ? (
          <Card style={{ marginTop: 12, backgroundColor: COLORS.cream, borderWidth: 0 }}>
            <T variant="mono">sikrets pair</T>
          </Card>
        ) : null}
      </View>
      {pairing ? (
        <Card style={{ gap: 6, marginBottom: 24 }}>
          <T variant="small">Since {new Date(pairing.pairedAt).toLocaleString()}</T>
          <T variant="small">{pairing.biometricBound ? "Signing key locked to Face ID" : "Signing key gated by Face ID"}</T>
          {lastSync ? <T variant="small">Synced {lastSync.toLocaleTimeString()}</T> : null}
        </Card>
      ) : null}
      <View style={{ gap: 10 }}>
        <Button label={pairing ? "Pair again" : "Scan code"} kind={pairing ? "secondary" : "primary"} onPress={() => setScanning(true)} />
        {pairing ? (
          <Button
            label="Unpair"
            kind="danger"
            onPress={() =>
              Alert.alert("Unpair this phone?", "Its keys are deleted. Run sikrets pair --forget on the laptop too.", [
                { text: "Cancel", style: "cancel" },
                { text: "Unpair", style: "destructive", onPress: () => unpair() },
              ])
            }
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 20, backgroundColor: COLORS.background },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  overlay: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  frame: { width: 240, height: 240, borderRadius: 24, borderWidth: 3, borderColor: COLORS.white },
  bottom: { position: "absolute", left: 20, right: 20, bottom: 32 },
});
