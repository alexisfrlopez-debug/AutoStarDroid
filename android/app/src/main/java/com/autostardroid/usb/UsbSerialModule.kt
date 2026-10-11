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
 *
 * RÉSILIENCE BUS USB (v2.1.1) : pendant un slew GOTO les moteurs tirent un
 * courant important — sur une chaîne OTG alimentée par le téléphone, la chute
 * de tension qui en résulte fait parfois ÉCHOUER un transfert bulk (IOException
 * sur read). Avant v2.1.1, la moindre IOException TUAIT le thread de lecture
 * (`break` définitif) : le port restait ouvert, l'app affichait « Connecté »,
 * mais plus AUCUNE donnée n'arrivait jamais — l'utilisateur voyait la
 * connexion « perdue » au moment du GOTO. Désormais :
 *  - IOException sur read → on vérifie que le périphérique est toujours là
 *    (même deviceName, ou même VID/PID après re-énumération) → si oui, on
 *    ROUVRE le port (jusqu'à 8 essais espacés de 500 ms) et on continue ;
 *  - périphérique réellement parti → événement usbDetached explicite (le
 *    broadcast système peut ne jamais arriver après une re-énumération ratée),
 *    et la couche JS peut alors tenter la reconnexion automatique.
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
    /** Tentatives de réouverture du port après une erreur de bus. */
    private const val REOPEN_TRIES = 8
    /** Délai entre deux essais de réouverture (ms) — la re-énumération USB
     *  d'un adaptateur après un glitch de bus prend typiquement 0,5 à 3 s. */
    private const val REOPEN_DELAY_MS = 500L
  }

  private var port: UsbSerialPort? = null
  /** Périphérique actuellement ouvert (pour la réouverture après glitch). */
  private var portDevice: UsbDevice? = null
  private var portBaud: Int = 9600
  /** Verrou unique : open/close/réouverture ne doivent jamais se chevaucher
   *  (le port usb-serial-for-android n'est pas thread-safe). Les writes
   *  restent hors verrou : en cas de réouverture en cours ils échouent vite
   *  (« Port fermé ») plutôt que de bloquer la file série côté JS. */
  private val portLock = Any()
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
          closePortLocked()
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
    closePortLocked()
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

  /** Ouvre le port pour le périphérique donné (verrou portLock posé par
   *  l'appelant). Lève en cas d'échec — l'appelant décide du rejet. */
  private fun openPortLocked(manager: UsbManager, dev: UsbDevice, baudRate: Int) {
    val driver = UsbSerialProber.getDefaultProber().findAllDrivers(manager)
        .firstOrNull { it.device.deviceName == dev.deviceName }
        ?: throw IllegalArgumentException("Driver non trouvé pour ${dev.deviceName}")
    val connection = manager.openDevice(driver.device)
        ?: throw IllegalStateException("Permission USB refusée ou appareil indisponible")
    val p = driver.ports[0]
    p.open(connection)
    p.setParameters(baudRate, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
    // LIGNES DE COMMANDE : DTR et RTS doivent être ASSERTÉS — sur les
    // adaptateurs PL2303 et CH340 (les câbles Meade les plus courants),
    // le port ne transmet RIEN tant que DTR n'est pas levé. Sans cela la
    // liaison entière reste muette (aucune réponse :GVP#/:Gr#…) : c'était
    // la cause racine « LCD non synchronisé / touches invisibles / GOTO
    // muet » en v1.7.x sur USB. Les pilotes qui ignorent ces lignes
    // (certains FTDI câblés sans DTR) ne lèvent pas d'erreur utile —
    // chaque appel est tolérant (try/catch) pour ne jamais bloquer l'ouverture.
    try { p.setDTR(true) } catch (_: Exception) {}
    try { p.setRTS(true) } catch (_: Exception) {}
    // Purge des résidus d'une session précédente (échos, réponses orphelines).
    try { p.purgeHwBuffers(true, true) } catch (_: Exception) {}
    port = p
    portDevice = dev
    portBaud = baudRate
  }

  /** Fermeture propre du port courant (verrou portLock posé par l'appelant). */
  private fun closePortLocked() {
    try { port?.close() } catch (_: Exception) {}
    port = null
    portDevice = null
  }

  /** Le périphérique est-il encore branché ? Recherche par deviceName PUIS
   *  par VID/PID (un glitch de bus peut re-énumérer l'adaptateur sous un
   *  autre deviceName — même identité matérielle). */
  private fun findReattachedDevice(manager: UsbManager): UsbDevice? {
    val wanted = portDevice ?: return null
    return manager.deviceList.values.firstOrNull { it.deviceName == wanted.deviceName }
        ?: manager.deviceList.values.firstOrNull {
          it.vendorId == wanted.vendorId && it.productId == wanted.productId
        }
  }

  @ReactMethod
  fun open(deviceName: String, baudRate: Int, promise: Promise) {
    try {
      synchronized(portLock) {
        if (port != null) {
          stopReading()
          closePortLocked()
        }
        val manager = usbManager
            ?: throw IllegalStateException("UsbManager indisponible")
        val dev = manager.deviceList.values.firstOrNull { it.deviceName == deviceName }
            ?: throw IllegalArgumentException("Périphérique non trouvé : $deviceName")
        openPortLocked(manager, dev, baudRate)
      }
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
      synchronized(portLock) { closePortLocked() }
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
          // RÉSILIENCE v2.1.1 : une IOException sur read est souvent
          // TRANSITOIRE (slew moteur → chute de tension OTG → transfert bulk
          // raté, ou re-énumération de l'adaptateur). Tuer le thread ici
          // laissait une liaison « zombie » : connecté côté app, muet pour
          // toujours. Tant que le périphérique est encore branché, on
          // ROUVRE le port et on poursuit la lecture.
          if (!reading) break
          val manager = usbManager
          var reopened = false
          if (manager != null) {
            repeat(REOPEN_TRIES) {
              if (!reading) return@repeat
              try { Thread.sleep(REOPEN_DELAY_MS) } catch (_: InterruptedException) { return@repeat }
              if (!reading) return@repeat
              val ok = try {
                synchronized(portLock) {
                  val dev = findReattachedDevice(manager)
                  if (dev == null) {
                    false // périphérique introuvable (cette passe)
                  } else {
                    try { port?.close() } catch (_: Exception) {}
                    port = null
                    try {
                      openPortLocked(manager, dev, portBaud)
                      true
                    } catch (_: Exception) {
                      false
                    }
                  }
                }
              } catch (_: Exception) { false }
              if (ok) { reopened = true }
              if (reopened) return@repeat
            }
          }
          if (!reading) break
          if (reopened) {
            sendEvent("usbError", Arguments.createMap().apply {
              putString("message", "USB : erreur de bus — port rouvert automatiquement, liaison conservée")
            })
          } else {
            // périphérique vraiment parti (ou irrécupérable) : événement
            // explicite — le broadcast système DETACHED peut ne jamais
            // arriver après une re-énumération ratée, et la couche JS en
            // dépend pour remettre son état et retenter la connexion.
            val name = portDevice?.deviceName ?: ""
            synchronized(portLock) { closePortLocked() }
            sendEvent("usbDetached", Arguments.createMap().apply { putString("deviceName", name) })
            break
          }
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
