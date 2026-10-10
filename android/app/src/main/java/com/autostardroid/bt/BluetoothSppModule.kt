package com.autostardroid.bt

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.pm.PackageManager
import android.util.Base64
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID

/**
 * Module natif Bluetooth SPP (Serial Port Profile) pour React Native.
 * Utilisé pour les adaptateurs Bluetooth-série type HC-05 branchés sur la
 * prise RJ-11/4P4C de la raquette Meade Autostar (#494/#495/#497/Autostar II).
 * UUID SPP standard : 00001101-0000-1000-8000-00805F9B34FB
 */
class BluetoothSppModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "NativeBluetoothSpp"
    private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
  }

  private var socket: BluetoothSocket? = null
  private var readThread: Thread? = null
  private var reading = false
  private var outStream: OutputStream? = null

  private val adapter: BluetoothAdapter?
    get() = (reactApplicationContext.getSystemService(android.content.Context.BLUETOOTH_SERVICE)
        as? BluetoothManager)?.adapter

  private fun hasPermission(p: String) =
      reactApplicationContext.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

  private fun sendEvent(name: String, params: WritableMap) {
    reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(name, params)
  }

  override fun getName() = NAME

  override fun onCatalystInstanceDestroy() {
    disconnectInternal()
  }

  private fun disconnectInternal() {
    reading = false
    try { socket?.close() } catch (_: Exception) {}
    socket = null
    outStream = null
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun isEnabled(promise: Promise) {
    try {
      promise.resolve(adapter?.isEnabled == true)
    } catch (e: Exception) { promise.reject("BT", e.message, e) }
  }

  @ReactMethod
  fun enable(promise: Promise) {
    try {
      val a = adapter ?: return promise.reject("BT", "Bluetooth non supporté")
      if (a.isEnabled) return promise.resolve(true)
      promise.resolve(a.enable()) // Android >= 13 : l'utilisateur doit l'activer dans les réglages
    } catch (e: Exception) { promise.reject("BT", e.message, e) }
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun listBondedDevices(promise: Promise) {
    try {
      val a = adapter ?: return promise.reject("BT", "Bluetooth non supporté")
      if (!a.isEnabled) return promise.reject("BT", "Bluetooth désactivé")
      val arr = Arguments.createArray()
      if (hasPermission(android.Manifest.permission.BLUETOOTH_CONNECT)) {
        for (d in a.bondedDevices) {
          arr.pushMap(Arguments.createMap().apply {
            putString("name", d.name ?: "(sans nom)")
            putString("address", d.address)
            putString("class", d.bluetoothClass?.deviceClass?.toString() ?: "")
          })
        }
      } else {
        promise.reject("PERM", "Permission BLUETOOTH_CONNECT manquante")
        return
      }
      promise.resolve(arr)
    } catch (e: Exception) { promise.reject("BT", e.message, e) }
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun connect(address: String, promise: Promise) {
    try {
      if (!hasPermission(android.Manifest.permission.BLUETOOTH_CONNECT)) {
        return promise.reject("PERM", "Permission BLUETOOTH_CONNECT manquante")
      }
      disconnectInternal()
      val a = adapter ?: return promise.reject("BT", "Bluetooth non supporté")
      val device: BluetoothDevice = a.getRemoteDevice(address)
      val s = device.createRfcommSocketToServiceRecord(SPP_UUID)
      try { a.cancelDiscovery() } catch (_: SecurityException) {
        // BLUETOOTH_SCAN absente : la découverte active reste possible, on continue
      }
      s.connect() // bloquant
      socket = s
      outStream = s.outputStream
      startReading(s.inputStream)
      promise.resolve(true)
    } catch (e: SecurityException) {
      promise.reject("PERM", e.message, e)
    } catch (e: IOException) {
      disconnectInternal()
      promise.reject("CONN", "Connexion impossible : ${e.message}", e)
    } catch (e: Exception) {
      promise.reject("BT", e.message, e)
    }
  }

  @ReactMethod
  fun disconnect(promise: Promise) {
    disconnectInternal()
    promise.resolve(true)
  }

  @ReactMethod
  fun isConnected(promise: Promise) = promise.resolve(socket?.isConnected == true)

  // Stubs requis par NativeEventEmitter côté JS (pas d'événements dirigés).
  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}

  @ReactMethod
  fun writeBase64(dataB64: String, promise: Promise) {
    try {
      val out = outStream ?: return promise.reject("WRITE", "Non connecté")
      val bytes = Base64.decode(dataB64, Base64.NO_WRAP)
      out.write(bytes)
      out.flush()
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("WRITE", e.message, e)
    }
  }

  private fun startReading(input: InputStream) {
    reading = true
    readThread = Thread {
      val buf = ByteArray(512)
      while (reading) {
        try {
          val n = input.read(buf)
          if (n > 0) {
            val chunk = Base64.encodeToString(buf.copyOf(n), Base64.NO_WRAP)
            sendEvent("btData", Arguments.createMap().apply { putString("data", chunk) })
          } else if (n < 0) {
            sendEvent("btDisconnected", Arguments.createMap())
            break
          }
        } catch (e: IOException) {
          if (reading) {
            sendEvent("btDisconnected", Arguments.createMap().apply { putString("message", e.message) })
          }
          break
        }
      }
    }.apply { isDaemon = true; name = "bt-spp-read"; start() }
  }
}
