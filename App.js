import { useAssets } from 'expo-asset';
import React, { useEffect, useCallback, useState, useRef } from "react";
import {
  Platform,
  View,
  Alert,
  ActivityIndicator,
  Text,
  DeviceEventEmitter,
  PermissionsAndroid,
} from "react-native";
import { WebView } from "react-native-webview";
import * as ScreenOrientation from "expo-screen-orientation";
import { StatusBar } from "expo-status-bar";
import * as NavigationBar from "expo-navigation-bar";
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';

// BLE IMPORTS
import { BleManager } from 'react-native-ble-plx';
import base64 from 'react-native-base64';

// ─────────────────────────────────────────────────────────────────────────────
// BLE UUIDs  (must match the robot board firmware)
// ─────────────────────────────────────────────────────────────────────────────
const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const WRITE_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const NOTIFY_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

// ─────────────────────────────────────────────────────────────────────────────
// USB / Serial  (Android only, lazy-loaded)
// ─────────────────────────────────────────────────────────────────────────────
let RNSerialport = null;
let SerialActions = null;

// Stores active DeviceEventEmitter subscriptions so we can remove them
// individually instead of calling the deprecated removeAllListeners().
const _usbListeners = [];

function ensureSerialModule() {
  if (Platform.OS !== "android") return false;
  if (RNSerialport && SerialActions) return true;
  try {
    const Serial = require("rn-usb-serial");
    RNSerialport = Serial.RNSerialport;
    SerialActions = Serial.actions;
    return true;
  } catch (e) {
    console.warn("Unable to load rn-usb-serial:", e);
    return false;
  }
}

function startUsbService() {
  if (!ensureSerialModule()) return;
  // FIX: Store subscriptions so we can remove them cleanly later.
  // DeviceEventEmitter.removeAllListeners() is deprecated since RN 0.65.
  _usbListeners.push(
    DeviceEventEmitter.addListener(SerialActions.ON_CONNECTED, () => console.log("USB: Connected")),
    DeviceEventEmitter.addListener(SerialActions.ON_DISCONNECTED, () => console.log("USB: Disconnected")),
  );
  try {
    RNSerialport.setInterface(-1);
    RNSerialport.setAutoConnectBaudRate(115200);
    RNSerialport.setAutoConnect(true);
    RNSerialport.startUsbService();
  } catch (e) {
    console.warn("Failed to start USB service:", e);
  }
}

function stopUsbService() {
  if (!RNSerialport || Platform.OS !== "android") return;
  // FIX: Remove each listener by its subscription reference.
  _usbListeners.forEach(sub => sub.remove());
  _usbListeners.length = 0;
  try {
    RNSerialport.stopUsbService();
  } catch (e) {
    console.warn("Error stopping USB service:", e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BLE Manager — singleton at module level so hot-reloads don't destroy it
// ─────────────────────────────────────────────────────────────────────────────
let bleManagerInstance = null;
if (Platform.OS !== 'web') {
  try {
    bleManagerInstance = new BleManager();
  } catch (e) {
    console.log("BLE Manager init failed:", e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// App Component
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const webViewRef = React.useRef(null);
  const [bleManager] = useState(bleManagerInstance);

  // Use a REF for connectedDevice so BLE callbacks always close over the
  // latest device without stale closure issues.
  const connectedDeviceRef = useRef(null);
  
  // Ref to prevent multiple document pickers opening simultaneously.
  const documentPickerActiveRef = useRef(false);

  // NEW: Proper boolean state for UI-level connection status.
  // This replaces the previous forceRender(n => n + 1) anti-pattern.
  const [isConnected, setIsConnected] = useState(false);

  // NEW: WebView loading state for the splash/loading screen.
  const [webViewReady, setWebViewReady] = useState(false);

  // Helper to update both the ref and the connection-status state together.
  const setConnectedDevice = useCallback((device) => {
    connectedDeviceRef.current = device;
    setIsConnected(!!device);
  }, []);

  // ── Safely inject JS into the WebView ─────────────────────────────────────
  // Memoised so it never changes reference between renders.
  const injectJS = useCallback((jsCode) => {
    webViewRef.current?.injectJavaScript(jsCode + '; true;');
  }, []);

  // ── Permissions & lifecycle ───────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
        ]);

        const allGranted =
          granted['android.permission.BLUETOOTH_SCAN'] === 'granted' &&
          granted['android.permission.BLUETOOTH_CONNECT'] === 'granted' &&
          granted['android.permission.ACCESS_FINE_LOCATION'] === 'granted';

        if (!allGranted) {
          Alert.alert(
            "Permission Required",
            "Go to Settings → Apps → [App] → Permissions and allow Bluetooth & Location."
          );
        }

        NavigationBar.setVisibilityAsync("hidden").catch(() => { });
      }

      if (Platform.OS !== "web") {
        ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => { });
        startUsbService();
      }
    })();

    return () => {
      // Stop BLE scan only — do NOT destroy the singleton manager.
      if (bleManager) bleManager.stopDeviceScan();
      if (Platform.OS === "android") stopUsbService();
    };
  }, [bleManager]);

  // ── BLE: Scan for nearby devices ─────────────────────────────────────────
  const scanAndConnectBLE = useCallback(() => {
    if (!bleManager) {
      Alert.alert("BLE unavailable", "Bluetooth manager could not start.");
      return;
    }

    injectJS(`handleBoardMessage("Scanning…", "SYS");`);

    bleManager.state().then(state => {
      if (state !== 'PoweredOn') {
        Alert.alert("Bluetooth Off", "Please turn on Bluetooth and Location.");
        injectJS(`handleBoardMessage("Bluetooth is OFF", "SYS");`);
        return;
      }

      bleManager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
        if (error) {
          console.log("Scan Error:", error);
          injectJS(`handleBoardMessage("Scan Error: ${error.reason || 'Check GPS/BT'}", "SYS");`);
          return;
        }
        if (device && device.name) {
          const rssi = device.rssi || -50;
          injectJS(`addDeviceToUI("${device.name}", "${device.id}", ${rssi});`);
        }
      });

      // Auto-stop scan after 10 s
      setTimeout(() => {
        bleManager.stopDeviceScan();
        console.log("Scan stopped.");
      }, 10000);
    }).catch(e => {
      console.log("BLE state error:", e);
      injectJS(`handleBoardMessage("BLE Error: ${e.message}", "SYS");`);
    });
  }, [bleManager, injectJS]);

  // ── BLE: Connect to a specific device ────────────────────────────────────
  const connectToSpecificDevice = useCallback((deviceId) => {
    if (!deviceId || !bleManager) return;

    bleManager.stopDeviceScan();
    injectJS(`handleBoardMessage("Connecting…", "SYS");`);

    const previousDevice = connectedDeviceRef.current;

    const doConnect = () => {
      bleManager.connectToDevice(deviceId)
        .then(device => device.discoverAllServicesAndCharacteristics())
        .then(async device => {
          setConnectedDevice(device);

          // ── Negotiate MTU for large payload transfers ──────────────────
          device._mtu = 20;
          try {
            if (Platform.OS === 'android') {
              const negotiatedDevice = await device.requestMTU(512);
              device._mtu = negotiatedDevice.mtu;
              console.log("MTU negotiated:", device._mtu);
            } else {
              device._mtu = 185; // safe iOS default
            }
          } catch (e) {
            console.log("MTU fallback to 20:", e);
            device._mtu = 20;
          }

          // Small pause: Android can silently drop the first write if we
          // start writing immediately after connect + discover.
          await new Promise(r => setTimeout(r, 80));

          injectJS(`
            window._mobileBLEConnected = true;
            finalizeConnection("${device.name || 'Robot'}");
          `);
          console.log("Connected to:", device.name);

          // ── Subscribe to NOTIFY characteristic ─────────────────────────
          let _notifyBuffer = '';
          try {
            device.monitorCharacteristicForService(
              SERVICE_UUID, NOTIFY_UUID,
              (error, characteristic) => {
                if (error) {
                  if (error.errorCode !== 2) console.log("Notify error:", error.reason || error);
                  return;
                }
                if (!characteristic?.value) return;

                _notifyBuffer += base64.decode(characteristic.value);

                const parts = _notifyBuffer.split('\n');
                _notifyBuffer = parts.pop() || '';

                for (const rawLine of parts) {
                  const line = rawLine.replace(/\r/g, '').trim();
                  if (!line) continue;
                  if (/^>{2,}/.test(line)) continue;
                  if (/^\.{3,}/.test(line)) continue;
                  if (line.startsWith('@@START') || line.startsWith('@@END')) continue;
                  if (line === 'OK' || line === 'MPY: soft reboot') continue;
                  const nonPrintable = line.replace(/[\x20-\x7E]/g, '').length;
                  if (nonPrintable > line.length * 0.3) continue;

                  const safe = line.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                  injectJS(`handleBoardMessage("${safe}", "BLE");`);
                }
              }
            );
            console.log("BLE Notify subscription active");
          } catch (notifyErr) {
            console.log("Failed to subscribe to notify:", notifyErr);
          }

          // ── Handle unexpected disconnects ──────────────────────────────
          device.onDisconnected(() => {
            if (connectedDeviceRef.current?.id === device.id) {
              setConnectedDevice(null);
              injectJS(`
                window._mobileBLEConnected = false;
                handleBoardMessage("BLE disconnected", "SYS");
                var p = document.getElementById('bt-text');
                if (p) p.innerText = 'Bluetooth';
              `);
            }
          });
        })
        .catch(e => {
          console.log("Connection error:", e);
          injectJS(`handleBoardMessage("Connection failed: ${e.message.replace(/"/g, "'")}", "SYS");`);
        });
    };

    if (previousDevice) {
      previousDevice.cancelConnection()
        .catch(() => { })
        .finally(() => {
          setConnectedDevice(null);
          setTimeout(doConnect, 300);
        });
    } else {
      doConnect();
    }
  }, [bleManager, injectJS, setConnectedDevice]);

  // ── BLE: Send code in MTU-sized chunks ───────────────────────────────────
  const sendToBoardBLE = useCallback(async (data) => {
    const device = connectedDeviceRef.current;
    if (!device || !bleManager) {
      Alert.alert("Error", "Please connect via Bluetooth first.");
      return;
    }

    try {
      // Verify device is still alive before transmitting
      const stillConnected = await bleManager.isDeviceConnected(device.id).catch(() => false);
      if (!stillConnected) {
        setConnectedDevice(null);
        injectJS(`
          window._mobileBLEConnected = false;
          handleBoardMessage("BLE lost — please reconnect", "SYS");
          var p = document.getElementById('bt-text'); if (p) p.innerText = 'Bluetooth';
        `);
        return;
      }

      // START marker
      await bleManager.writeCharacteristicWithResponseForDevice(
        device.id, SERVICE_UUID, WRITE_UUID, base64.encode('@@START\n')
      );

      // Chunk payload — reserve 12 bytes for GATT overhead
      const chunkSize = Math.max(20, (device._mtu || 20) - 12);
      for (let i = 0; i < data.length; i += chunkSize) {
        await bleManager.writeCharacteristicWithResponseForDevice(
          device.id, SERVICE_UUID, WRITE_UUID,
          base64.encode(data.substring(i, i + chunkSize))
        );
      }

      // END marker
      await bleManager.writeCharacteristicWithResponseForDevice(
        device.id, SERVICE_UUID, WRITE_UUID, base64.encode('\n@@END')
      );

      injectJS(`handleBoardMessage("Upload Done! ✅", "SYS");`);
    } catch (error) {
      console.error("BLE Send Error:", error);
      const stillUp = await bleManager.isDeviceConnected(device.id).catch(() => false);
      if (!stillUp) {
        setConnectedDevice(null);
        injectJS(`
          window._mobileBLEConnected = false;
          var p = document.getElementById('bt-text'); if (p) p.innerText = 'Bluetooth';
        `);
      }
      injectJS(`handleBoardMessage("Send Failed ❌: ${String(error.message || error).replace(/"/g, "'")}", "SYS");`);
    }
  }, [bleManager, injectJS, setConnectedDevice]);

  // ── BLE: Send a single command string ────────────────────────────────────
  const sendCommandBLE = useCallback(async (command) => {
    const device = connectedDeviceRef.current;
    if (!device || !bleManager) {
      injectJS(`handleBoardMessage("No BLE connection", "SYS");`);
      return;
    }
    try {
      const stillConnected = await bleManager.isDeviceConnected(device.id).catch(() => false);
      if (!stillConnected) {
        setConnectedDevice(null);
        injectJS(`
          window._mobileBLEConnected = false;
          handleBoardMessage("BLE lost — please reconnect", "SYS");
          var p = document.getElementById('bt-text'); if (p) p.innerText = 'Bluetooth';
        `);
        return;
      }
      await bleManager.writeCharacteristicWithResponseForDevice(
        device.id, SERVICE_UUID, WRITE_UUID,
        base64.encode(command + "\n")
      );
      injectJS(`handleBoardMessage("${command} sent ✅", "SYS");`);
    } catch (e) {
      console.error("Command Error:", e);
      injectJS(`handleBoardMessage("Command failed ❌", "SYS");`);
    }
  }, [bleManager, injectJS, setConnectedDevice]);

  // ── BLE: Safe disconnect (USB-eject style) ───────────────────────────────
  const disconnectBLE = useCallback(async () => {
    console.log("🔴 Safe disconnect started");
    const device = connectedDeviceRef.current;

    if (!device || !bleManager) {
      injectJS(`handleBoardMessage("Not connected to any device", "SYS");`);
      return;
    }

    try {
      // STEP 1 — Send DISCONNECT command via the standard write characteristic.
      // FIX: Previously used undefined `bleControlChar.writeValue()` (Web Bluetooth API).
      //      Now correctly uses react-native-ble-plx's writeCharacteristicWithResponseForDevice,
      //      and base64.encode() instead of the unavailable TextEncoder.
      injectJS(`handleBoardMessage("🔴 Initiating safe disconnect...", "SYS");`);
      injectJS(`handleBoardMessage("⏹️ Stopping board execution...", "SYS");`);

      let disconnectSent = false;
      try {
        const stillConnected = await bleManager.isDeviceConnected(device.id).catch(() => false);
        if (stillConnected) {
          await bleManager.writeCharacteristicWithResponseForDevice(
            device.id, SERVICE_UUID, WRITE_UUID,
            base64.encode("DISCONNECT\n")   // FIX: base64.encode, not TextEncoder
          );
          disconnectSent = true;
          injectJS(`handleBoardMessage("  ✓ Disconnect command sent", "SYS");`);
          console.log("✅ Disconnect command sent");
        }
      } catch (disconnectError) {
        console.log("⚠️ Disconnect send error:", disconnectError.message);
        injectJS(`handleBoardMessage("  ⚠️ Could not send disconnect", "SYS");`);
      }

      if (!disconnectSent) {
        injectJS(`handleBoardMessage("❌ No BLE connection", "SYS");`);
        setConnectedDevice(null);
        return;
      }

      // STEP 2 — Flush
      injectJS(`handleBoardMessage("💾 Flushing data to storage...", "SYS");`);
      await new Promise(r => setTimeout(r, 400));

      // STEP 3 — Graceful shutdown
      injectJS(`handleBoardMessage("🔧 Graceful shutdown of peripherals...", "SYS");`);
      await new Promise(r => setTimeout(r, 400));

      // STEP 4 — Wait for safe state
      injectJS(`handleBoardMessage("📢 Waiting for safe state confirmation...", "SYS");`);
      await new Promise(r => setTimeout(r, 400));

      // STEP 5 — Clear device reference
      setConnectedDevice(null);

      // STEP 6 — Close GATT connection
      injectJS(`handleBoardMessage("🔌 Closing connection...", "SYS");`);
      try {
        await device.cancelConnection();
      } catch (e) {
        console.log("⚠️ Cancel error:", e.message);
      }

      // STEP 7 — Final cleanup
      await new Promise(r => setTimeout(r, 300));
      console.log("✅ Safe disconnect complete");
      injectJS(`
        window._mobileBLEConnected = false;
        handleBoardMessage("🟢 [SAFE_DISCONNECT] Complete!", "SYS");
        handleBoardMessage("✨ Safe to unplug device", "SYS");
        var p = document.getElementById('bt-text');
        if (p) p.innerText = 'Bluetooth';
      `);

    } catch (error) {
      console.error("❌ Disconnect error:", error);
      setConnectedDevice(null);
      injectJS(`handleBoardMessage("Error: ${error.message}", "SYS");`);
    }
  }, [bleManager, injectJS, setConnectedDevice]);

  // ── Message Bridge: index.html → App.js ──────────────────────────────────
  const handleMessage = useCallback((event) => {
    let msg;
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch (e) {
      console.warn("Bridge parse error:", e);
      return;
    }

    switch (msg.type) {

      // User clicked SCAN in the BT modal
      case "CONNECT_BLE":
        scanAndConnectBLE();
        break;

      // User tapped a device in the BT list
      case "SELECT_DEVICE":
        connectToSpecificDevice(msg.deviceId);
        break;

      // Upload button pressed — send compiled code over BLE
      case "SEND_DATA":
        sendToBoardBLE(msg.data);
        break;

      // PLAY / STOP / SOFT_RESET / HARD_RESET etc.
      case "COMMAND":
        sendCommandBLE(msg.command);
        break;

      // USB-eject style safe disconnect
      case "DISCONNECT_SAFE":
        if (connectedDeviceRef.current) {
          disconnectBLE().catch(e => console.error("Disconnect error:", e));
        } else {
          injectJS(`handleBoardMessage("Already disconnected", "SYS");`);
        }
        break;

      // Save/download XML to device storage and share
      case "SAVE_FILE":
        (async () => {
          try {
            const fileName = msg.fileName || 'program.xml';
            const file = new File(Paths.cache, fileName);
            await file.write(msg.content); // FIX: was missing `await`
            if (await Sharing.isAvailableAsync()) {
              await Sharing.shareAsync(file.uri, {
                mimeType: 'text/xml',
                dialogTitle: 'Save Blockly Program',
                UTI: 'public.xml',
              });
            } else {
              Alert.alert("Saved", `File saved to: ${file.uri}`);
            }
            injectJS(`handleBoardMessage("File saved ✅", "SYS");`);
          } catch (e) {
            console.error("File save error:", e);
            injectJS(`handleBoardMessage("Save failed: ${String(e.message || e).replace(/"/g, "'")}", "SYS");`);
          }
        })();
        break;

      // NEW: SAVE_CLOUD — index.html sends this when cloud sync is requested.
      // FIX: was unhandled — now logs and acknowledges. Wire up your cloud
      //      provider (Firebase, Supabase, etc.) inside this block.
      case "SAVE_CLOUD":
        (async () => {
          try {
            console.log("SAVE_CLOUD requested:", msg.name);
            // TODO: replace with your actual cloud upload call, e.g.:
            // await uploadToCloud(msg.name, msg.data);
            injectJS(`handleBoardMessage("Cloud sync coming soon ☁️", "SYS");`);
          } catch (e) {
            console.error("Cloud save error:", e);
            injectJS(`handleBoardMessage("Cloud save failed: ${String(e.message || e).replace(/"/g, "'")}", "SYS");`);
          }
        })();
        break;

      // Mobile file picker — load XML back into the WebView
      case "LOAD_FILE":
        (async () => {
          if (documentPickerActiveRef.current) {
            console.log("Document picker already active. Ignoring request.");
            return;
          }
          try {
            documentPickerActiveRef.current = true;
            const result = await DocumentPicker.getDocumentAsync({
              type: ['text/xml', 'application/xml'],
              copyToCacheDirectory: true,
            });
            if (result.canceled || !result.assets?.length) {
              return;
            }
            const pickedFile = new File(result.assets[0].uri);
            const content = await pickedFile.text();
            const safe = content
              .replace(/\\/g, '\\\\')
              .replace(/`/g, '\\`')
              .replace(/\$/g, '\\$');
            injectJS(`loadXml(\`${safe}\`);`);
            injectJS(`handleBoardMessage("File loaded ✅", "SYS");`);
          } catch (e) {
            console.error("File load error:", e);
            injectJS(`handleBoardMessage("Load failed: ${String(e.message || e).replace(/"/g, "'")}", "SYS");`);
          } finally {
            documentPickerActiveRef.current = false;
          }
        })();
        break;

      default:
        console.warn("Unknown bridge message type:", msg.type);
    }
  }, [
    scanAndConnectBLE,
    connectToSpecificDevice,
    sendToBoardBLE,
    sendCommandBLE,
    disconnectBLE,
    injectJS,
  ]);

  // ── WebView error handlers ────────────────────────────────────────────────
  // NEW: Previously there were no error handlers — a failed asset load would
  // show a blank screen with no feedback.

  const handleWebViewError = useCallback((syntheticEvent) => {
    const { nativeEvent } = syntheticEvent;
    console.error("WebView error:", nativeEvent);
    // Only show an alert for genuine load failures, not cancelled navigations.
    if (nativeEvent.code !== -999) {
      Alert.alert("Load Error", `Failed to load workspace: ${nativeEvent.description}`);
    }
  }, []);

  const handleWebViewHttpError = useCallback((syntheticEvent) => {
    const { nativeEvent } = syntheticEvent;
    console.error("WebView HTTP error:", nativeEvent.statusCode, nativeEvent.url);
  }, []);

  // NEW: On iOS the WebView process can be silently killed by the OS
  // (low-memory, crash). Reloading avoids a permanently blank screen.
  const handleContentProcessTerminate = useCallback(() => {
    console.warn("WebView process terminated — reloading.");
    webViewRef.current?.reload();
  }, []);

  // ── Asset loading ─────────────────────────────────────────────────────────
  const [assets] = useAssets([require('./assets/blockly/index.html')]);

  // ── Loading splash ────────────────────────────────────────────────────────
  // NEW: Show a proper loading screen while assets are prepared and
  // the WebView is bootstrapping, instead of a raw blank background.
  if (!assets) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color="#00b4cc" />
        <Text style={styles.splashText}>Loading workspace…</Text>
      </View>
    );
  }

  // ── Web platform fallback (expo web) ─────────────────────────────────────
  if (Platform.OS === "web") {
    return (
      <View style={styles.flex}>
        <StatusBar hidden />
        <iframe
          src={assets[0].uri}
          style={{ width: "100%", height: "100%", border: "none" }}
          title="Blockly Workspace"
        />
      </View>
    );
  }

  // ── Native (Android / iOS) ────────────────────────────────────────────────
  return (
    <View style={styles.flex}>
      <StatusBar hidden />

      {/* NEW: Overlay spinner while the WebView is still loading its HTML/JS */}
      {!webViewReady && (
        <View style={styles.splashOverlay}>
          <ActivityIndicator size="large" color="#00b4cc" />
          <Text style={styles.splashText}>Preparing Blockly…</Text>
        </View>
      )}

      <WebView
        ref={webViewRef}
        originWhitelist={["*"]}
        source={{ uri: assets[0].uri }}
        allowFileAccess
        allowUniversalAccessFromFileURLs
        javaScriptEnabled
        style={styles.flex}

        // Bridge
        onMessage={handleMessage}

        // NEW: Error handlers — previously absent, causing silent blank screens.
        onError={handleWebViewError}
        onHttpError={handleWebViewHttpError}

        // NEW: Recover from iOS WebView process termination.
        onContentProcessDidTerminate={handleContentProcessTerminate}

        // NEW: Hide the loading overlay once the WebView has fully rendered.
        onLoadEnd={() => setWebViewReady(true)}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────
const styles = {
  flex: {
    flex: 1,
  },
  splash: {
    flex: 1,
    backgroundColor: '#cfeff2',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  splashOverlay: {
    position: 'absolute',
    inset: 0,
    zIndex: 10,
    backgroundColor: '#cfeff2',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  splashText: {
    fontSize: 14,
    color: '#2b3c47',
    fontWeight: '600',
    letterSpacing: 0.5,
  },
};