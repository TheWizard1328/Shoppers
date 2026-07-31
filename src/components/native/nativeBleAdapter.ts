/**
 * Native BLE adapter — abstracts the difference between:
 *   - Capacitor BluetoothLe plugin (native APK: auto-connect, background scanning, no user gesture)
 *   - Web Bluetooth API (web/PWA: requires user gesture, suspends when backgrounded)
 *
 * KEY DIFFERENCE FROM WEB:
 *   - No requestDevice() prompt needed on native — auto-connects to known Inkbird devices
 *   - Can scan and connect in the background (screen off, app backgrounded)
 *   - Auto-reconnects on disconnect without user interaction
 *
 * The existing Inkbird BLE code in the app calls navigator.bluetooth.requestDevice().
 * On native, we swap that for the Capacitor plugin which handles the connection
 * natively. The temperature reading callback stays the same shape.
 */

import { isNative } from './nativePlatform';

export interface BleDevice {
  deviceId: string;
  name: string;
  rssi: number;
}

export interface TemperatureReading {
  temperature: number;  // °C
  humidity: number;    // %
  battery: number;     // 0-100
  timestamp: number;
}

type ReadingCallback = (reading: TemperatureReading) => void;
type ConnectionCallback = (connected: boolean, device?: BleDevice) => void;

// Inkbird IBS-TH1/th2 characteristic UUIDs (same as web Bluetooth version)
const INKBIRD_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
const INKBIRD_NOTIFY_UUID  = '0000fff4-0000-1000-8000-00805f9b34fb';
const INKBIRD_WRITE_UUID   = '0000fff2-0000-1000-8000-00805f9b34fb';

// Known Inkbird device name prefixes (for auto-connect filtering)
const INKBIRD_NAME_PREFIXES = ['sps', 'ibs', 'Inkbird'];

export class NativeBleAdapter {
  private connectedDeviceId: string | null = null;
  private readingCallback: ReadingCallback | null = null;
  private connectionCallback: ConnectionCallback | null = null;
  private nativePlugin: any = null;
  private autoReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnecting = false;

  async loadPlugin() {
    if (this.nativePlugin) return this.nativePlugin;
    try {
      const mod = await import('@capacitor-community/bluetooth-le');
      this.nativePlugin = mod.BluetoothLe;
    } catch {
      this.nativePlugin = null;
    }
    return this.nativePlugin;
  }

  /**
   * Initialize BLE — request permissions on Android 12+.
   * On native, this also enables the Bluetooth adapter if disabled.
   */
  async initialize(): Promise<boolean> {
    if (!isNative()) return true; // web doesn't need init

    const plugin = await this.loadPlugin();
    if (!plugin) return false;

    try {
      const permResult = await plugin.requestPermissions();
      if (permResult?.bluetooth !== 'granted') {
        console.warn('[NativeBleAdapter] Bluetooth permission denied');
        return false;
      }
      await plugin.initialize();
      return true;
    } catch (err: any) {
      console.error('[NativeBleAdapter] Initialize failed:', err?.message);
      return false;
    }
  }

  /**
   * Auto-connect to the nearest Inkbird device.
   * On native: scans without user gesture, connects to first matching device.
   * On web: falls back to navigator.bluetooth.requestDevice() (needs user tap).
   */
  async autoConnect(
    onReading: ReadingCallback,
    onConnectionChange: ConnectionCallback,
    _knownDeviceId?: string
  ): Promise<boolean> {
    this.readingCallback = onReading;
    this.connectionCallback = onConnectionChange;

    if (!isNative()) {
      // ── Web fallback: needs user gesture ──
      return this.webConnect();
    }

    // ── Native: auto-scan + connect ──
    const plugin = await this.loadPlugin();
    if (!plugin) {
      console.warn('[NativeBleAdapter] Plugin not available, falling back to web');
      return this.webConnect();
    }

    try {
      // If we have a known device ID, try direct connection first
      if (_knownDeviceId) {
        const connected = await this.connectToDevice(_knownDeviceId);
        if (connected) return true;
      }

      // Scan for Inkbird devices (10 second scan)
      await plugin.requestLEScan({
        allowDuplicates: false,
        namePrefix: '', // We'll filter in JS
      });

      const scanTimeout = setTimeout(() => {
        plugin.stopLEScan().catch(() => {});
      }, 10000);

      let foundDevice: BleDevice | null = null;

      await plugin.addListener('onScanResult', (result: any) => {
        const device = result?.device;
        if (!device) return;

        const name = (device.name || '').toLowerCase();
        const isInkbird = INKBIRD_NAME_PREFIXES.some(prefix => name.startsWith(prefix));

        if (isInkbird && !foundDevice) {
          foundDevice = {
            deviceId: device.deviceId,
            name: device.name || 'Inkbird',
            rssi: device.rssi || 0,
          };
          plugin.stopLEScan().catch(() => {});
          clearTimeout(scanTimeout);
        }
      });

      // Wait for scan to find a device
      await new Promise(resolve => setTimeout(resolve, 10000));
      clearTimeout(scanTimeout);

      if (!foundDevice) {
        console.warn('[NativeBleAdapter] No Inkbird device found during scan');
        this.scheduleReconnect();
        return false;
      }

      return await this.connectToDevice(foundDevice.deviceId, foundDevice);
    } catch (err: any) {
      console.error('[NativeBleAdapter] Auto-connect failed:', err?.message);
      this.scheduleReconnect();
      return false;
    }
  }

  /**
   * Connect to a specific device by ID and start temperature notifications.
   */
  private async connectToDevice(deviceId: string, deviceInfo?: BleDevice): Promise<boolean> {
    if (this.isConnecting) return false;
    this.isConnecting = true;

    const plugin = this.nativePlugin;
    try {
      await plugin.connect({ deviceId });
      this.connectedDeviceId = deviceId;
      this.connectionCallback?.(true, deviceInfo || { deviceId, name: 'Inkbird', rssi: 0 });

      // Subscribe to temperature notifications
      await plugin.startNotifications({ deviceId, service: INKBIRD_SERVICE_UUID, characteristic: INKBIRD_NOTIFY_UUID });

      await plugin.addListener('onNotification', (notif: any) => {
        if (notif?.value) {
          const reading = this.parseInkbirdData(notif.value);
          if (reading) this.readingCallback?.(reading);
        }
      });

      // Listen for disconnect
      await plugin.addListener('onDisconnect', (disconnectInfo: any) => {
        if (disconnectInfo?.deviceId === deviceId) {
          this.connectedDeviceId = null;
          this.connectionCallback?.(false);
          this.scheduleReconnect();
        }
      });

      this.isConnecting = false;
      return true;
    } catch (err: any) {
      console.error('[NativeBleAdapter] Connect failed:', err?.message);
      this.isConnecting = false;
      this.connectionCallback?.(false);
      this.scheduleReconnect();
      return false;
    }
  }

  /**
   * Parse Inkbird BLE notification data into temperature/humidity.
   * Same parsing logic as the web Bluetooth version — data format is identical.
   */
  private parseInkbirdData(dataValue: string): TemperatureReading | null {
    try {
      // Capacitor BLE returns base64 or hex string depending on plugin version
      // Convert to byte array
      const bytes = this.dataValueToBytes(dataValue);
      if (!bytes || bytes.length < 5) return null;

      // Inkbird IBS-TH1 data format:
      // bytes 0-1: temperature (little-endian, ×0.1°C)
      // bytes 2-3: humidity (little-endian, ×0.1%)
      // byte 4: battery percentage
      const tempRaw = bytes[0] | (bytes[1] << 8);
      const humidityRaw = bytes[2] | (bytes[3] << 8);
      const battery = bytes[4];

      return {
        temperature: tempRaw / 10,
        humidity: humidityRaw / 10,
        battery,
        timestamp: Date.now(),
      };
    } catch {
      return null;
    }
  }

  private dataValueToBytes(value: string): Uint8Array | null {
    try {
      // Try base64 first (Capacitor BLE default)
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch {
      // Try hex
      try {
        const cleaned = value.replace(/[^0-9a-fA-F]/g, '');
        const bytes = new Uint8Array(cleaned.length / 2);
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(cleaned.substr(i * 2, 2), 16);
        }
        return bytes;
      } catch {
        return null;
      }
    }
  }

  /**
   * Schedule auto-reconnect after disconnect.
   * Tries every 15 seconds until successful.
   */
  private scheduleReconnect() {
    if (this.autoReconnectTimer) clearTimeout(this.autoReconnectTimer);
    this.autoReconnectTimer = setTimeout(async () => {
      if (!this.connectedDeviceId && !this.isConnecting) {
        console.log('[NativeBleAdapter] Auto-reconnect attempt...');
        await this.autoConnect(
          this.readingCallback!,
          this.connectionCallback!,
          this.connectedDeviceId || undefined
        );
      }
    }, 15000);
  }

  /**
   * Web/PWA fallback — uses navigator.bluetooth.requestDevice().
   * Requires user gesture (onTouchEnd handler).
   */
  private async webConnect(): Promise<boolean> {
    if (!navigator?.bluetooth) return false;

    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'sps' }, { namePrefix: 'ibs' }, { namePrefix: 'Inkbird' }],
        optionalServices: [INKBIRD_SERVICE_UUID],
      });

      const server = await device.gatt?.connect();
      if (!server) return false;

      const service = await server.getPrimaryService(INKBIRD_SERVICE_UUID);
      const characteristic = await service.getCharacteristic(INKBIRD_NOTIFY_UUID);

      await characteristic.startNotifications();
      characteristic.addEventListener('characteristicvaluechanged', (event: any) => {
        const value = event.target.value;
        const bytes = new Uint8Array(value.buffer);
        const tempRaw = bytes[0] | (bytes[1] << 8);
        const humidityRaw = bytes[2] | (bytes[3] << 8);
        const reading: TemperatureReading = {
          temperature: tempRaw / 10,
          humidity: humidityRaw / 10,
          battery: bytes[4] || 0,
          timestamp: Date.now(),
        };
        this.readingCallback?.(reading);
      });

      device.addEventListener('gattserverdisconnected', () => {
        this.connectionCallback?.(false);
        // Web version can't auto-reconnect without user gesture — user must tap again
      });

      this.connectionCallback?.(true, { deviceId: device.id, name: device.name || 'Inkbird', rssi: 0 });
      return true;
    } catch (err: any) {
      console.error('[NativeBleAdapter] Web BLE connect failed:', err?.message);
      return false;
    }
  }

  /**
   * Disconnect and cleanup.
   */
  async disconnect(): Promise<void> {
    if (this.autoReconnectTimer) {
      clearTimeout(this.autoReconnectTimer);
      this.autoReconnectTimer = null;
    }

    if (!isNative()) {
      // Web disconnect handled by the existing code
      return;
    }

    const plugin = await this.loadPlugin();
    if (plugin && this.connectedDeviceId) {
      try {
        await plugin.stopNotifications({
          deviceId: this.connectedDeviceId,
          service: INKBIRD_SERVICE_UUID,
          characteristic: INKBIRD_NOTIFY_UUID,
        });
        await plugin.disconnect({ deviceId: this.connectedDeviceId });
        await plugin.removeAllListeners();
      } catch (err: any) {
        console.error('[NativeBleAdapter] Disconnect error:', err?.message);
      }
    }
    this.connectedDeviceId = null;
    this.connectionCallback?.(false);
  }
}
