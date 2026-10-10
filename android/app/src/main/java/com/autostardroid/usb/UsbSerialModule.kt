package com.autostardroid.usb

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.util.Base64
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber

/**
 * Module natif USB-série pour Android (React Native).
 * Supporte les câbles USB-série courants utilisés avec les raquettes Meade :
 * FTDI (0403), Prolific PL2303 (067b), SiLabs CP210x (10c4), WCH CH340 (1a86).
 * Lib : usb-serial-for-android (mik3y), via JitPack.
 */
class UsbSerialModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "NativeUsbSerial"
    const val ACTION_USB_PERMISSION = "com.autostardroid.USB_PERMISSION"
    private val VENDOR_NAMES = mapOf(
        0x0403 to "FTDI", 0x067B to "Prolific PL", 0x10C4 to "Silabs CP210x",
        0x1A86 to "WCH CH34x", 0x1546 to "U-Blox", 0x2341 to "Arduino", 0x1567 to "Meade"
    )
  }

  private var port: UsbSerialPort? = null
  private var readThread: Thread? = null
  private var reading = false

  private val usbManager: UsbManager?
    get() = reactApplicationContext.getSystemService(Context.USB_SERVICE) as? UsbManager

  private val usbReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (ACTION_USB_PERMISSION == intent.action) {
        val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
        val dev: UsbDevice? = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
        sendEvent("usbPermission", Arguments.createMap().apply {
          putBoolean("granted", granted)
          putString("deviceName", dev?.deviceName ?: "")
        })
      } else if (UsbManager.ACTION_USB_DEVICE_DETACHED == intent.action) {
        val dev: UsbDevice? = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
        if (dev != null && port != null) {
          // câble débranché : fermeture propre
          stopReading()
          try { port?.close() } catch (_: Exception) {}
          port = null
          sendEvent("usbDetached", Arguments.createMap().apply { putString("deviceName", dev.deviceName) })
        }
      }
    }
  }

  init {
    val filter = IntentFilter().apply {
      addAction(ACTION_USB_PERMISSION)
      addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
    }
    // Android 14+ (targetSdk 34) : le flag d'export est OBLIGATOIRE pour tout filtre
    // contenant une action non-système, sinon SecurityException au démarrage.
    // NOT_EXPORTED fonctionne : l'Intent USB_PERMISSION est adressé à notre package
    // (setPackage) et ACTION_USB_DEVICE_DETACHED est un broadcast système protégé.
    ContextCompat.registerReceiver(
        reactApplicationContext, usbReceiver, filter,
        ContextCompat.RECEIVER_NOT_EXPORTED)
  }

  override fun getName() = NAME

  override fun onCatalystInstanceDestroy() {
    stopReading()
    try { port?.close() } catch (_: Exception) {}
    port = null
    try { reactApplicationContext.unregisterReceiver(usbReceiver) } catch (_: Exception) {}
  }

  private fun sendEvent(name: String, params: WritableMap) {
    reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(name, params)
  }

  @ReactMethod
  fun listDevices(promise: Promise) {
    try {
      val managers = UsbSerialProber.getDefaultProber().findAllDrivers(usbManager)
      val arr = Arguments.createArray()
      for (d in managers) {
        val dev = d.device
        arr.pushMap(Arguments.createMap().apply {
          putString("deviceName", dev.deviceName)
          putInt("vendorId", dev.vendorId)
          putInt("productId", dev.productId)
          putString("vendorHex", String.format("%04x", dev.vendorId))
          putString("productHex", String.format("%04x", dev.productId))
          putString("driver", d.javaClass.simpleName)
          putString("brand", VENDOR_NAMES[dev.vendorId] ?: "Inconnu")
        })
      }
      promise.resolve(arr)
    } catch (e: Exception) {
      promise.reject("LIST", e.message, e)
    }
  }

  @ReactMethod
  fun requestPermission(deviceName: String, promise: Promise) {
    try {
      val manager = usbManager ?: return promise.reject("USB", "UsbManager indisponible")
      val dev = manager.deviceList.values.firstOrNull { it.deviceName == deviceName }
          ?: return promise.reject("USB", "Périphérique non trouvé : $deviceName")
      if (manager.hasPermission(dev)) return promise.resolve(true)
      val pi = android.app.PendingIntent.getBroadcast(
          reactApplicationContext, 0,
          Intent(ACTION_USB_PERMISSION).setPackage(reactApplicationContext.packageName),
          android.app.PendingIntent.FLAG_MUTABLE)
      manager.requestPermission(dev, pi)
      promise.resolve(false) // résultat réel via l'événement usbPermission
    } catch (e: Exception) {
      promise.reject("PERM", e.message, e)
    }
  }

  @ReactMethod
  fun open(deviceName: String, baudRate: Int, promise: Promise) {
    try {
      if (port != null) {
        stopReading(); try { port?.close() } catch (_: Exception) {}; port = null
      }
      val manager = usbManager ?: return promise.reject("USB", "UsbManager indisponible")
      val driver = UsbSerialProber.getDefaultProber().findAllDrivers(manager)
          .firstOrNull { it.device.deviceName == deviceName }
          ?: return promise.reject("USB", "Driver non trouvé pour $deviceName")
      val connection = manager.openDevice(driver.device)
          ?: return promise.reject("USB", "Permission USB refusée ou appareil indisponible")
      val p = driver.ports[0]
      p.open(connection)
      p.setParameters(baudRate, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
      port = p
      startReading()
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("OPEN", e.message, e)
    }
  }

  @ReactMethod
  fun close(promise: Promise) {
    try {
      stopReading()
      port?.close()
      port = null
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("CLOSE", e.message, e)
    }
  }

  /** Écrit les octets encodés en Base64. */
  @ReactMethod
  fun writeBase64(dataB64: String, promise: Promise) {
    try {
      val p = port ?: return promise.reject("WRITE", "Port fermé")
      val bytes = Base64.decode(dataB64, Base64.NO_WRAP)
      p.write(bytes, 1000)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("WRITE", e.message, e)
    }
  }

  @ReactMethod
  fun isConnected(promise: Promise) = promise.resolve(port != null)

  // Stubs requis par NativeEventEmitter côté JS (pas d'événements dirigés).
  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}

  private fun startReading() {
    reading = true
    readThread = Thread {
      val buf = ByteArray(512)
      while (reading) {
        try {
          val p = port ?: break
          val n = p.read(buf, 100)
          if (n > 0) {
            val chunk = Base64.encodeToString(buf.copyOf(n), Base64.NO_WRAP)
            sendEvent("usbData", Arguments.createMap().apply { putString("data", chunk) })
          }
        } catch (e: java.io.IOException) {
          sendEvent("usbError", Arguments.createMap().apply { putString("message", e.message) })
          break
        } catch (e: Exception) {
          if (reading) sendEvent("usbError", Arguments.createMap().apply { putString("message", e.message) })
        }
      }
    }.apply { isDaemon = true; name = "usb-serial-read"; start() }
  }

  private fun stopReading() {
    reading = false
    readThread?.interrupt()
    readThread = null
  }
}
