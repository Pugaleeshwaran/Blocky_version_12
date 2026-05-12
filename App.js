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

const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const WRITE_UUID   = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const NOTIFY_UUID  = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

let RNSerialport  = null;
let SerialActions = null;
const _usbListeners = [];

function ensureSerialModule() {
  if (Platform.OS !== "android") return false;
  if (RNSerialport && SerialActions) return true;
  try {
    const Serial  = require("rn-usb-serial");
    RNSerialport  = Serial.RNSerialport;
    SerialActions = Serial.actions;
    return true;
  } catch (e) {
    console.warn("Unable to load rn-usb-serial:", e);
    return false;
  }
}

function startUsbService() {
  if (!ensureSerialModule()) return;
  _usbListeners.push(
    DeviceEventEmitter.addListener(SerialActions.ON_CONNECTED,    () => console.log("USB: Connected")),
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
  _usbListeners.forEach(sub => sub.remove());
  _usbListeners.length = 0;
  try { RNSerialport.stopUsbService(); } catch (e) { console.warn("Error stopping USB service:", e); }
}

function buildPycodeMessage(code, entry = "main") {
  return `PYCODE\nENTRY:${entry}\nSIZE:${code.length}\n\n${code}`;
}

function sendToBoardUSB(message) {
  if (!ensureSerialModule()) return;
  try { RNSerialport.writeString(message); Alert.alert("USB Sent", "Code sent over USB."); }
  catch (e) { Alert.alert("USB Error", "Failed to send."); }
}

let bleManagerInstance = null;
if (Platform.OS !== 'web') {
  try { bleManagerInstance = new BleManager(); }
  catch (e) { console.log("BLE Manager init failed:", e); }
}

export default function App() {
  const blocklyRef = React.useRef(null);
  const trainRef   = React.useRef(null);

  const [bleManager]   = useState(bleManagerInstance);
  const [showAIScreen, setShowAIScreen] = useState(false);
  const [isConnected,  setIsConnected]  = useState(false);
  const [webViewReady, setWebViewReady] = useState(false);

  const connectedDeviceRef      = useRef(null);
  const documentPickerActiveRef = useRef(false);

  const setConnectedDevice = useCallback((device) => {
    connectedDeviceRef.current = device;
    setIsConnected(!!device);
  }, []);

  const injectJS = useCallback((jsCode) => {
    blocklyRef.current?.injectJavaScript(jsCode + '; true;');
  }, []);

  // Web platform: listen for postMessage from iframes
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const webListener = (event) => {
      try {
        const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (msg.type === "OPEN_AI_TRAIN")  setShowAIScreen(true);
        if (msg.type === "CLOSE_AI_TRAIN") setShowAIScreen(false);
        if (msg.type === "AI_MODEL_TRAINED") {
          const blocklyIframe = document.querySelector('iframe[title="Blockly Workspace"]');
          if (blocklyIframe?.contentWindow) {
            blocklyIframe.contentWindow.postMessage(JSON.stringify(msg), '*');
          }
          // Do NOT close the screen — user stays on training page
        }
      } catch (e) {}
    };
    window.addEventListener("message", webListener);
    return () => window.removeEventListener("message", webListener);
  }, []);

  // Permissions & lifecycle
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
          granted['android.permission.BLUETOOTH_SCAN']    === 'granted' &&
          granted['android.permission.BLUETOOTH_CONNECT'] === 'granted' &&
          granted['android.permission.ACCESS_FINE_LOCATION'] === 'granted';
        if (!allGranted) {
          Alert.alert("Permission Required", "Go to Settings and allow Bluetooth & Location.");
        }
        NavigationBar.setVisibilityAsync("hidden").catch(() => {});
      }
      if (Platform.OS !== "web") {
        ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
        startUsbService();
      }
    })();
    return () => {
      if (bleManager) bleManager.stopDeviceScan();
      if (Platform.OS === "android") stopUsbService();
    };
  }, [bleManager]);

  const scanAndConnectBLE = useCallback(() => {
    if (!bleManager) { Alert.alert("BLE unavailable", "Bluetooth manager could not start."); return; }
    injectJS(`handleBoardMessage("Scanning…", "SYS");`);
    bleManager.state().then(state => {
      if (state !== 'PoweredOn') {
        Alert.alert("Bluetooth Off", "Please turn on Bluetooth and Location.");
        injectJS(`handleBoardMessage("Bluetooth is OFF", "SYS");`);
        return;
      }
      bleManager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
        if (error) { injectJS(`handleBoardMessage("Scan Error: ${error.reason || 'Check GPS/BT'}", "SYS");`); return; }
        if (device && device.name) {
          const rssi = device.rssi || -50;
          injectJS(`addDeviceToUI("${device.name}", "${device.id}", ${rssi});`);
        }
      });
      setTimeout(() => { bleManager.stopDeviceScan(); console.log("Scan stopped."); }, 10000);
    }).catch(e => { injectJS(`handleBoardMessage("BLE Error: ${e.message}", "SYS");`); });
  }, [bleManager, injectJS]);

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
          device._mtu = 20;
          try {
            if (Platform.OS === 'android') {
              const nd = await device.requestMTU(512);
              device._mtu = nd.mtu;
            } else { device._mtu = 185; }
          } catch (e) { device._mtu = 20; }
          await new Promise(r => setTimeout(r, 80));
          injectJS(`window._mobileBLEConnected = true; finalizeConnection("${device.name || 'Robot'}");`);
          let _notifyBuffer = '';
          try {
            device.monitorCharacteristicForService(SERVICE_UUID, NOTIFY_UUID, (error, characteristic) => {
              if (error) { if (error.errorCode !== 2) console.log("Notify error:", error.reason || error); return; }
              if (!characteristic?.value) return;
              _notifyBuffer += base64.decode(characteristic.value);
              const parts = _notifyBuffer.split('\n');
              _notifyBuffer = parts.pop() || '';
              for (const rawLine of parts) {
                const line = rawLine.replace(/\r/g, '').trim();
                if (!line || /^>{2,}/.test(line) || /^\.{3,}/.test(line)) continue;
                if (line.startsWith('@@START') || line.startsWith('@@END')) continue;
                if (line === 'OK' || line === 'MPY: soft reboot') continue;
                if (line.replace(/[\x20-\x7E]/g, '').length > line.length * 0.3) continue;
                const safe = line.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                injectJS(`handleBoardMessage("${safe}", "BLE");`);
              }
            });
          } catch (notifyErr) { console.log("Failed to subscribe to notify:", notifyErr); }
          device.onDisconnected(() => {
            if (connectedDeviceRef.current?.id === device.id) {
              setConnectedDevice(null);
              injectJS(`window._mobileBLEConnected = false; handleBoardMessage("BLE disconnected", "SYS"); var p = document.getElementById('bt-text'); if (p) p.innerText = 'Bluetooth';`);
            }
          });
        })
        .catch(e => { injectJS(`handleBoardMessage("Connection failed: ${e.message.replace(/"/g, "'")}", "SYS");`); });
    };
    if (previousDevice) {
      previousDevice.cancelConnection().catch(() => {}).finally(() => { setConnectedDevice(null); setTimeout(doConnect, 300); });
    } else { doConnect(); }
  }, [bleManager, injectJS, setConnectedDevice]);

  const sendToBoardBLE = useCallback(async (data) => {
    const device = connectedDeviceRef.current;
    if (!device || !bleManager) { Alert.alert("Error", "Please connect via Bluetooth first."); return; }
    try {
      const stillConnected = await bleManager.isDeviceConnected(device.id).catch(() => false);
      if (!stillConnected) {
        setConnectedDevice(null);
        injectJS(`window._mobileBLEConnected = false; handleBoardMessage("BLE lost — please reconnect", "SYS"); var p = document.getElementById('bt-text'); if (p) p.innerText = 'Bluetooth';`);
        return;
      }
      await bleManager.writeCharacteristicWithResponseForDevice(device.id, SERVICE_UUID, WRITE_UUID, base64.encode('@@START\n'));
      const chunkSize = Math.max(20, (device._mtu || 20) - 12);
      for (let i = 0; i < data.length; i += chunkSize) {
        await bleManager.writeCharacteristicWithResponseForDevice(device.id, SERVICE_UUID, WRITE_UUID, base64.encode(data.substring(i, i + chunkSize)));
      }
      await bleManager.writeCharacteristicWithResponseForDevice(device.id, SERVICE_UUID, WRITE_UUID, base64.encode('\n@@END'));
      injectJS(`handleBoardMessage("Upload Done! ✅", "SYS");`);
    } catch (error) {
      const stillUp = await bleManager.isDeviceConnected(device.id).catch(() => false);
      if (!stillUp) { setConnectedDevice(null); injectJS(`window._mobileBLEConnected = false; var p = document.getElementById('bt-text'); if (p) p.innerText = 'Bluetooth';`); }
      injectJS(`handleBoardMessage("Send Failed ❌: ${String(error.message || error).replace(/"/g, "'")}", "SYS");`);
    }
  }, [bleManager, injectJS, setConnectedDevice]);

  const sendCommandBLE = useCallback(async (command) => {
    const device = connectedDeviceRef.current;
    if (!device || !bleManager) { injectJS(`handleBoardMessage("No BLE connection", "SYS");`); return; }
    try {
      const stillConnected = await bleManager.isDeviceConnected(device.id).catch(() => false);
      if (!stillConnected) { setConnectedDevice(null); injectJS(`window._mobileBLEConnected = false; handleBoardMessage("BLE lost — please reconnect", "SYS");`); return; }
      await bleManager.writeCharacteristicWithResponseForDevice(device.id, SERVICE_UUID, WRITE_UUID, base64.encode(command + "\n"));
      injectJS(`handleBoardMessage("${command} sent ✅", "SYS");`);
    } catch (e) { injectJS(`handleBoardMessage("Command failed ❌", "SYS");`); }
  }, [bleManager, injectJS, setConnectedDevice]);

  const disconnectBLE = useCallback(async () => {
    const device = connectedDeviceRef.current;
    if (!device || !bleManager) { injectJS(`handleBoardMessage("Not connected to any device", "SYS");`); return; }
    try {
      injectJS(`handleBoardMessage("🔴 Initiating safe disconnect...", "SYS");`);
      let disconnectSent = false;
      try {
        const stillConnected = await bleManager.isDeviceConnected(device.id).catch(() => false);
        if (stillConnected) {
          await bleManager.writeCharacteristicWithResponseForDevice(device.id, SERVICE_UUID, WRITE_UUID, base64.encode("DISCONNECT\n"));
          disconnectSent = true;
          injectJS(`handleBoardMessage("  ✓ Disconnect command sent", "SYS");`);
        }
      } catch (e) { injectJS(`handleBoardMessage("  ⚠️ Could not send disconnect", "SYS");`); }
      if (!disconnectSent) { setConnectedDevice(null); return; }
      await new Promise(r => setTimeout(r, 1200));
      setConnectedDevice(null);
      try { await device.cancelConnection(); } catch (e) {}
      await new Promise(r => setTimeout(r, 300));
      injectJS(`window._mobileBLEConnected = false; handleBoardMessage("🟢 [SAFE_DISCONNECT] Complete!", "SYS"); var p = document.getElementById('bt-text'); if (p) p.innerText = 'Bluetooth';`);
    } catch (error) { setConnectedDevice(null); injectJS(`handleBoardMessage("Error: ${error.message}", "SYS");`); }
  }, [bleManager, injectJS, setConnectedDevice]);

  const handleBlocklyMessage = useCallback((event) => {
    let msg;
    try { msg = JSON.parse(event.nativeEvent.data); }
    catch (e) { console.warn("Bridge parse error:", e); return; }

    switch (msg.type) {
      case "CONNECT_BLE":       scanAndConnectBLE(); break;
      case "SELECT_DEVICE":     connectToSpecificDevice(msg.deviceId); break;
      case "SEND_DATA":         sendToBoardBLE(msg.data); break;
      case "COMMAND":           sendCommandBLE(msg.command); break;
      case "DISCONNECT_SAFE":
        if (connectedDeviceRef.current) { disconnectBLE().catch(e => console.error(e)); }
        else { injectJS(`handleBoardMessage("Already disconnected", "SYS");`); }
        break;
      case "python_upload":     sendToBoardUSB(buildPycodeMessage(msg.code)); break;
      case "OPEN_AI_TRAIN":     setShowAIScreen(true); break;
      case "AI_MODEL_TRAINED":
        blocklyRef.current?.injectJavaScript(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify(msg))}}));true;`);
        break;
      case "SAVE_FILE":
        (async () => {
          try {
            const file = new File(Paths.cache, msg.fileName || 'program.xml');
            await file.write(msg.content);
            if (await Sharing.isAvailableAsync()) {
              await Sharing.shareAsync(file.uri, { mimeType:'text/xml', dialogTitle:'Save Blockly Program', UTI:'public.xml' });
            } else { Alert.alert("Saved", `File saved to: ${file.uri}`); }
            injectJS(`handleBoardMessage("File saved ✅", "SYS");`);
          } catch (e) { injectJS(`handleBoardMessage("Save failed: ${String(e.message||e).replace(/"/g,"'")}", "SYS");`); }
        })(); break;
      case "SAVE_CLOUD":
        injectJS(`handleBoardMessage("Cloud sync coming soon ☁️", "SYS");`); break;
      case "LOAD_FILE":
        (async () => {
          if (documentPickerActiveRef.current) return;
          try {
            documentPickerActiveRef.current = true;
            const result = await DocumentPicker.getDocumentAsync({ type:['text/xml','application/xml'], copyToCacheDirectory:true });
            if (result.canceled || !result.assets?.length) return;
            const content = await new File(result.assets[0].uri).text();
            const safe = content.replace(/\\/g,'\\\\').replace(/`/g,'\\`').replace(/\$/g,'\\$');
            injectJS(`loadXml(\`${safe}\`);`);
            injectJS(`handleBoardMessage("File loaded ✅", "SYS");`);
          } catch (e) { injectJS(`handleBoardMessage("Load failed: ${String(e.message||e).replace(/"/g,"'")}", "SYS");`); }
          finally { documentPickerActiveRef.current = false; }
        })(); break;
      default: console.warn("Unknown bridge message type:", msg.type);
    }
  }, [scanAndConnectBLE, connectToSpecificDevice, sendToBoardBLE, sendCommandBLE, disconnectBLE, injectJS]);

  const handleTrainMessage = useCallback((event) => {
    let msg;
    try { msg = JSON.parse(event.nativeEvent.data); } catch (e) { return; }
    // Only CLOSE_AI_TRAIN (back button) closes the screen — NOT AI_MODEL_TRAINED
    if (msg.type === "CLOSE_AI_TRAIN") setShowAIScreen(false);
    if (msg.type === "AI_MODEL_TRAINED") {
      // Relay trained classes to Blockly — but keep training screen open
      blocklyRef.current?.injectJavaScript(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify(msg))}}));true;`);
    }
  }, []);

  const handleWebViewError = useCallback((syntheticEvent) => {
    const { nativeEvent } = syntheticEvent;
    console.error("WebView error:", nativeEvent);
    if (nativeEvent.code !== -999) Alert.alert("Load Error", `Failed to load workspace: ${nativeEvent.description}`);
  }, []);

  const handleWebViewHttpError = useCallback((syntheticEvent) => {
    console.error("WebView HTTP error:", syntheticEvent.nativeEvent.statusCode);
  }, []);

  const handleContentProcessTerminate = useCallback(() => {
    console.warn("WebView process terminated — reloading.");
    blocklyRef.current?.reload();
  }, []);

  const [assets] = useAssets([
    require('./assets/blockly/index.html'),  // assets[0] → Blockly workspace
    require('./assets/blockly/train.html'),  // assets[1] → AI Training screen
  ]);

  if (!assets) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color="#00b4cc" />
        <Text style={styles.splashText}>Loading workspace…</Text>
      </View>
    );
  }

  if (Platform.OS === "web") {
    return (
      <View style={styles.flex}>
        <StatusBar hidden />
        {/* Train iframe — ALWAYS mounted, shown/hidden via style to preserve state */}
        <iframe src={assets[1].uri} allow="camera; microphone"
          style={{ position:'absolute', top:0, left:0, width:'100%', height:'100%', border:'none', zIndex:10,
            opacity: showAIScreen ? 1 : 0, pointerEvents: showAIScreen ? 'auto' : 'none' }}
          title="Model Training" />
        <iframe src={assets[0].uri} allow="camera; microphone"
          style={{ width:'100%', height:'100%', border:'none', visibility: showAIScreen ? 'hidden' : 'visible' }}
          title="Blockly Workspace" />
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <StatusBar hidden />

      {!webViewReady && (
        <View style={styles.splashOverlay}>
          <ActivityIndicator size="large" color="#00b4cc" />
          <Text style={styles.splashText}>Preparing Blockly…</Text>
        </View>
      )}

      {/* AI Training WebView — ALWAYS mounted to preserve state, shown/hidden via style */}
      <WebView
        ref={trainRef}
        source={{ uri: assets[1].uri }}
        originWhitelist={["*"]}
        allowFileAccess
        allowUniversalAccessFromFileURLs
        mediaCapturePermissionGrantType="grant"
        javaScriptEnabled
        onMessage={handleTrainMessage}
        style={{
          position:'absolute', top:0, left:0, right:0, bottom:0, zIndex:10,
          // hide visually but NEVER unmount — preserves all training state
          opacity: showAIScreen ? 1 : 0,
          pointerEvents: showAIScreen ? 'auto' : 'none',
        }}
      />

      {/* Blockly WebView — always mounted */}
      <WebView
        ref={blocklyRef}
        originWhitelist={["*"]}
        source={{ uri: assets[0].uri }}
        allowFileAccess
        allowUniversalAccessFromFileURLs
        javaScriptEnabled
        style={{ flex:1, opacity: showAIScreen ? 0 : 1, pointerEvents: showAIScreen ? 'none' : 'auto' }}
        onMessage={handleBlocklyMessage}
        onError={handleWebViewError}
        onHttpError={handleWebViewHttpError}
        onContentProcessDidTerminate={handleContentProcessTerminate}
        onLoadEnd={() => setWebViewReady(true)}
      />
    </View>
  );
}

const styles = {
  flex:         { flex: 1 },
  splash:       { flex:1, backgroundColor:'#cfeff2', justifyContent:'center', alignItems:'center', gap:12 },
  splashOverlay:{ position:'absolute', inset:0, zIndex:10, backgroundColor:'#cfeff2', justifyContent:'center', alignItems:'center', gap:12 },
  splashText:   { fontSize:14, color:'#2b3c47', fontWeight:'600', letterSpacing:0.5 },
};
