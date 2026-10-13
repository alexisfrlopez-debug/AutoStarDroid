package com.autostardroid.camera

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.hardware.usb.UsbRequest
import android.os.Handler
import android.os.HandlerThread
import java.nio.ByteBuffer
import android.util.Base64
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.ByteArrayOutputStream
import java.util.Locale
import org.json.JSONObject

/**
 * Module natif CAMÉRA UVC USB-HOST (v2.7.0 — retour terrain : « l'application
 * détecte les caméras internes du téléphone mais pas la caméra UVC »).
 *
 * POURQUOI CE MODULE : la v2.5.0 listait les caméras uniquement via Camera2
 * (LENS_FACING_EXTERNAL) — or Android n'expose les webcams USB via Camera2
 * QUE si le constructeur embarque le HAL « external camera » (rare sur les
 * téléphones). Ce module parle DIRECTEMENT à la caméra en USB Host :
 *  - ÉNUMÉRATION : tout périphérique USB avec une interface classe VIDEO
 *    (0x0E) — indépendant du HAL caméra du constructeur ;
 *  - PERMISSION : UsbManager.requestPermission (broadcast, résultat en
 *    Promise — timeout 30 s) ;
 *  - DESCRIPTORS : parsing brut (rawDescriptors) — terminal caméra, unité
 *    de traitement, formats MJPEG/UNCOMPRESSED, frames + intervalles,
 *    alternate settings ;
 *  - FLUX : négociation UVC (PROBE/COMMIT — préremplie par GET_CUR),
 *    transport BULK (caméras astro — lecture synchrone par tranches ≤ 16 Ko)
 *    ou ISOCHRONOUS (webcams grand public : Logitech, ELP… — anneau de
 *    UsbRequest + setIsochronousPackets, API 31+ ; v2.8.1 — la v2.7/2.8
 *    visait l'alternate setting 0 de l'interface VS, qui n'a JAMAIS
 *    d'endpoint : « cette caméra n'expose pas d'endpoint » ; SET_INTERFACE
 *    explicite sur l'alt porteur, échelle de repli de bande passante),
 *    CLEAR_FEATURE(ENDPOINT_HALT) avant lecture BULK, RÉASSEMBLAGE des
 *    frames par bascule FID + marqueur JPEG EOI + troncature exacte
 *    dwMaxVideoFrameSize (v2.8.0 : la v2.7.0 confondait le bit EOH (fin
 *    d'EN-TÊTE) avec une fin de FRAME), frames JPEG émises vers le JS
 *    (événement 'cameraFrame', MÊME format que Camera2 — l'aperçu/l'autoguidage/l'acquisition fonctionnent sans
 *    changement) ; luminance réduite 192×144 + centroïde (verrou de
 *    suivi) calculés CÔTÉ NATIF comme pour Camera2 ;
 *  - CONTRÔLES : requêtes UVC (exposition auto/absolue, gain, luminosité,
 *    contraste, saturation, netteté, balance des blancs auto/température,
 *    zoom, focus auto/absolu) avec plages lues GET_MIN/GET_MAX/GET_RES/
 *    GET_DEF — alimente les curseurs de réglage manuel côté JS.
 *
 * LIMITES assumées : ISOCHRONOUS géré depuis la v2.8.1 via UsbRequest
 * (API 31+ — Android 12 ; le téléphone cible est en Android 15). Les
 * caméras ISO-only sur Android < 12 reçoivent une erreur claire.
 *
 * ⚠️ Règle de survie Hermes (v1.7.2) : TOUTES les méthodes sont basées sur
 * Promise, AUCUN callback JS ne traverse le pont — résultats par Promise
 * ou événements (RCTDeviceEventEmitter). Paramètres : uniquement des
 * scalaires/JSON string (sérialisables).
 */
class UvcCameraModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "NativeUvcCamera"
    private const val ACTION_UVC_PERMISSION = "com.autostardroid.UVC_PERMISSION"
    private const val PERM_TIMEOUT_MS = 30_000L
    private const val BULK_TIMEOUT_MS = 1500
    private const val MAX_READ_ERRORS = 40
    private const val LUMA_W = 192
    private const val LUMA_H = 144
    /** Longueurs PROBE/COMMIT essayées en repli : 26 = UVC 1.0/1.1,
     *  34/48 = firmwares étendus / UVC 1.5 — un SET_CUR à la mauvaise
     *  longueur est STALLÉ par la caméra (« PROBE refusé »). */
    private val PROBE_LENS_FALLBACK = intArrayOf(26, 34, 48)
    /** ISO — microtrames par requête et requêtes en vol (anneau). */
    private const val ISO_PACKETS_PER_REQ = 32
    private const val ISO_REQ_COUNT = 8

    // Descripteurs UVC (types / sous-types)
    private const val DT_INTERFACE = 0x04
    private const val DT_ENDPOINT = 0x05
    private const val DT_CS_INTERFACE = 0x24
    private const val SC_VIDEOCONTROL = 0x01
    private const val SC_VIDEOSTREAMING = 0x02
    private const val ST_VC_INPUT_TERMINAL = 0x02
    private const val ST_VC_PROCESSING_UNIT = 0x05
    private const val ST_VS_FORMAT_UNCOMPRESSED = 0x04
    private const val ST_VS_FRAME_UNCOMPRESSED = 0x05
    private const val ST_VS_FORMAT_MJPEG = 0x06
    private const val ST_VS_FRAME_MJPEG = 0x07
    private const val ST_VS_FORMAT_FRAME_BASED = 0x10
    private const val ST_VS_FRAME_FRAME_BASED = 0x11

    // Sélecteurs de contrôle (CS)
    private const val CS_PROBE = 0x01
    private const val CS_COMMIT = 0x02
  }

  private val usbManager: UsbManager?
    get() = reactApplicationContext.getSystemService(Context.USB_SERVICE) as? UsbManager

  /* ---------------- état du flux ---------------- */
  private var thread: HandlerThread? = null
  private var handler: Handler? = null
  private var readThread: Thread? = null
  @Volatile private var streaming = false
  private var connection: UsbDeviceConnection? = null
  private var vsInterface: UsbInterface? = null
  private var bulkEp: UsbEndpoint? = null
  /** ISO : requêtes + buffers d'anneau (UsbRequest — API 31+). */
  private var isoRequests: List<UsbRequest>? = null
  private var frameW = 0
  private var frameH = 0
  private var isMjpeg = true
  /** Taille attendue d'une frame UNCOMPRESSED (dwMaxVideoFrameSize) —
   *  troncature exacte du réassemblage (protège des zéros de bourrage). */
  private var expectedFrame = 0
  /** Réassemblage partagé bulk/ISO — l'accumulateur de frame courante. */
  private var acc = ByteArray(0)
  private var accLen = 0
  private var lastFid = -1
  private var frameSkip = 1
  private var frameCount = 0L
  private var jpegQuality = 75
  /** Verrou de suivi (autoguidage) — normalisé 0..1, NaN = absent. */
  private var lockX = Float.NaN
  private var lockY = Float.NaN
  private var lockHalf = 0.13f
  private val lumaRing = ArrayDeque<ByteArray>(8)
  private var pendingStill: Promise? = null
  private var pendingPermission: Promise? = null
  /** Handler principal (permission — le handler du flux n'existe que
   *  pendant un stream). */
  private val mainHandler = Handler(android.os.Looper.getMainLooper())
  private var controlUnitPu = 0
  private var controlUnitCt = 0
  private var vcIfNum = 0
  private var vsIfNum = 0
  /** Interface VS portant le contrôle probe/commit (v2.9.3) : l'interface VS
   *  du parsing par défaut — le repli peut BASCULER sur l'interface porteuse
   *  du scan SDK si celle-ci seule accepte la négociation. */
  private var vsCtrlIfNum = 0

  private val permReceiver = object : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
      val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
      val p = pendingPermission
      pendingPermission = null
      p?.resolve(granted)
    }
  }

  init {
    ContextCompat.registerReceiver(
        reactApplicationContext, permReceiver, IntentFilter(ACTION_UVC_PERMISSION),
        ContextCompat.RECEIVER_NOT_EXPORTED)
  }

  private fun sendEvent(name: String, params: WritableMap) {
    reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(name, params)
  }

  override fun getName() = NAME

  override fun onCatalystInstanceDestroy() {
    try { reactApplicationContext.unregisterReceiver(permReceiver) } catch (_: Exception) {}
    closeLocked()
  }

  /* ------------------------------------------------------------ */
  /* Énumération + permission                                       */
  /* ------------------------------------------------------------ */

  private fun isUvc(dev: UsbDevice): Boolean {
    for (i in 0 until dev.interfaceCount) {
      val f = dev.getInterface(i)
      if (f.interfaceClass == UsbConstants.USB_CLASS_VIDEO) return true
    }
    return false
  }

  @ReactMethod
  fun listUvcCameras(promise: Promise) {
    try {
      val mgr = usbManager ?: return promise.reject("USB", "UsbManager indisponible")
      val arr = Arguments.createArray()
      for (dev in mgr.deviceList.values) {
        if (!isUvc(dev)) continue
        val name = dev.productName ?: dev.manufacturerName ?: "UVC"
        arr.pushMap(Arguments.createMap().apply {
          putString("id", "uvc:${dev.deviceName}")
          putString("deviceName", dev.deviceName)
          putInt("vid", dev.vendorId)
          putInt("pid", dev.productId)
          putBoolean("external", true)
          putBoolean("manual", true) // contrôles UVC manuels toujours disponibles
          putString("label", String.format(Locale.US, "UVC — %s (%04X:%04X)",
              name, dev.vendorId, dev.productId))
        })
      }
      promise.resolve(arr)
    } catch (e: Exception) {
      promise.reject("LIST", e.message, e)
    }
  }

  @ReactMethod
  fun hasUvcPermission(deviceName: String, promise: Promise) {
    val mgr = usbManager ?: return promise.reject("USB", "UsbManager indisponible")
    val dev = mgr.deviceList.values.firstOrNull { it.deviceName == deviceName }
        ?: return promise.reject("USB", "Périphérique non trouvé : $deviceName")
    promise.resolve(mgr.hasPermission(dev))
  }

  /** Demande la permission USB — resolve(true) si accordée, false si
   *  refusée/timeout. (Aucun callback JS : résultat par Promise.) */
  @ReactMethod
  fun requestUvcPermission(deviceName: String, promise: Promise) {
    try {
      val mgr = usbManager ?: return promise.reject("USB", "UsbManager indisponible")
      val dev = mgr.deviceList.values.firstOrNull { it.deviceName == deviceName }
          ?: return promise.reject("USB", "Périphérique non trouvé : $deviceName")
      if (mgr.hasPermission(dev)) return promise.resolve(true)
      pendingPermission = promise
      val pi = PendingIntent.getBroadcast(
          reactApplicationContext, 0,
          Intent(ACTION_UVC_PERMISSION).setPackage(reactApplicationContext.packageName),
          PendingIntent.FLAG_MUTABLE)
      mgr.requestPermission(dev, pi)
      mainHandler.postDelayed({
        val p = pendingPermission
        if (p != null && p === promise) {
          pendingPermission = null
          p.resolve(false)
        }
      }, PERM_TIMEOUT_MS)
    } catch (e: Exception) {
      pendingPermission = null
      promise.reject("PERM", e.message, e)
    }
  }

  /* ------------------------------------------------------------ */
  /* Parsing des descripteurs                                      */
  /* ------------------------------------------------------------ */

  private class UvcFrame(
      val index: Int, val w: Int, val h: Int, val intervals: IntArray)
  private class UvcFormat(
      val index: Int, val mjpeg: Boolean,
      val frames: MutableList<UvcFrame> = ArrayList())

  /** Endpoint IN de l'interface VS (descripteurs bruts). alt = alternate
   *  setting porteur — alt 0 n'a JAMAIS d'endpoint (zéro bande passante).
   *  rawMaxPacket = wMaxPacketSize BRUT du descripteur ; maxPacket = taille
   *  réelle (raw & 0x7FF × multiplicateur haut-débit bits 11-12 pour ISO). */
  private class VsEp(val alt: Int, val addr: Int, val bulk: Boolean, val rawMaxPacket: Int) {
    val maxPacket: Int = if (bulk) rawMaxPacket
    else (rawMaxPacket and 0x7FF) * (((rawMaxPacket shr 11) and 0x3) + 1)
  }

  private class UvcDesc {
    var vcIfNum = -1
    var puId = 0
    var ctId = 0
    var vsIfNum = -1
    val formats = ArrayList<UvcFormat>()
    val vsEps = ArrayList<VsEp>()
    /** Diagnostic — tous les alternate settings VS vus au parsing. */
    val vsAlts = LinkedHashSet<Int>()
    /** Diagnostic — tous les endpoints VS vus (tous sens/types),
     *  "addr=0x88 attr=0x01 raw=1024" : alimente le message d'erreur si
     *  aucun endpoint exploitable n'est trouvé (retour terrain v2.9.1). */
    val rawEps = ArrayList<String>()
  }

  private fun parseDescriptors(conn: UsbDeviceConnection): UvcDesc {
    val d = conn.rawDescriptors ?: throw IllegalStateException("Descripteurs illisibles")
    val out = UvcDesc()
    var curIfNum = -1
    var curIfSub = -1
    var curIfAlt = 0
    var curFormat: UvcFormat? = null
    var i = 0
    while (i < d.size) {
      val len = d[i].toInt() and 0xFF
      if (len < 2 || i + len > d.size) break
      val type = d[i + 1].toInt() and 0xFF
      when (type) {
        DT_INTERFACE -> {
          val num = d[i + 2].toInt() and 0xFF
          val alt = d[i + 3].toInt() and 0xFF
          val cls = d[i + 5].toInt() and 0xFF
          val sub = d[i + 6].toInt() and 0xFF
          curIfNum = num; curIfSub = sub; curIfAlt = alt
          if (cls == UsbConstants.USB_CLASS_VIDEO && sub == SC_VIDEOCONTROL &&
              out.vcIfNum < 0) {
            out.vcIfNum = num
          }
          if (cls == UsbConstants.USB_CLASS_VIDEO && sub == SC_VIDEOSTREAMING &&
              out.vsIfNum < 0) {
            out.vsIfNum = num
          }
        }
        DT_CS_INTERFACE -> {
          val sub = d[i + 2].toInt() and 0xFF
          if (curIfSub == SC_VIDEOCONTROL) {
            when (sub) {
              ST_VC_INPUT_TERMINAL -> {
                val termType = (d[i + 4].toInt() and 0xFF) or ((d[i + 5].toInt() and 0xFF) shl 8)
                if (termType == 0x0201) { // camera terminal
                  out.ctId = d[i + 3].toInt() and 0xFF
                }
              }
              ST_VC_PROCESSING_UNIT -> {
                out.puId = d[i + 3].toInt() and 0xFF
              }
            }
          } else if (curIfSub == SC_VIDEOSTREAMING) {
            when (sub) {
              ST_VS_FORMAT_MJPEG -> {
                curFormat = UvcFormat(d[i + 3].toInt() and 0xFF, true)
                out.formats.add(curFormat)
              }
              ST_VS_FORMAT_UNCOMPRESSED, ST_VS_FORMAT_FRAME_BASED -> {
                curFormat = UvcFormat(d[i + 3].toInt() and 0xFF, false)
                out.formats.add(curFormat)
              }
              ST_VS_FRAME_MJPEG, ST_VS_FRAME_UNCOMPRESSED, ST_VS_FRAME_FRAME_BASED -> {
                // ⚠️ PAS de `break` ici : dans un `when` imbriqué, break sort
                // de la BOUCLE while — le parsing serait tronqué et les
                // endpoints (après les descripteurs de classe) jamais vus
                // (retour terrain : « Aucun endpoint VideoStreaming IN »).
                // Format inconnu → frame simplement ignorée.
                val f = curFormat
                if (f != null) {
                  val idx = d[i + 3].toInt() and 0xFF
                  val w = (d[i + 4].toInt() and 0xFF) or ((d[i + 5].toInt() and 0xFF) shl 8)
                  val h = (d[i + 6].toInt() and 0xFF) or ((d[i + 7].toInt() and 0xFF) shl 8)
                  val nTypes = d[i + 28].toInt() and 0xFF
                  val intervals = ArrayList<Int>()
                  if (nTypes == 0 && i + 41 <= i + len) {
                    // continu : min / max / pas
                    val lo = le32(d, i + 29); val hi = le32(d, i + 33); val step = le32(d, i + 37).coerceAtLeast(1)
                    var v = lo
                    while (v <= hi && intervals.size < 32) { intervals.add(v); v += step }
                  } else {
                    var k = 0
                    while (k < nTypes && i + 29 + k * 4 + 3 < i + len) {
                      intervals.add(le32(d, i + 29 + k * 4)); k += 1
                    }
                  }
                  f.frames.add(UvcFrame(idx, w, h, intervals.toIntArray()))
                }
              }
              // formats non décodables (H264, stream-based, DV, VP8…) :
              // on neutralise curFormat pour que leurs frames ne se rattachent
              // PAS au format précédent (et n'arrêtent jamais le parsing)
              else -> curFormat = null
            }
          }
        }
        DT_ENDPOINT -> if (curIfSub == SC_VIDEOSTREAMING && i + 6 <= d.size) {
          // endpoints de l'interface VS courante — IN bulk (astronomiques)
          // ou IN isochrone (webcams grand public : Logitech, ELP…)
          val addr = d[i + 2].toInt() and 0xFF
          val attr = d[i + 3].toInt() and 0x03
          val raw = (d[i + 4].toInt() and 0xFF) or ((d[i + 5].toInt() and 0xFF) shl 8)
          out.vsAlts.add(curIfAlt)
          out.rawEps.add("0x%02X/0x%02X/%d".format(Locale.US, addr, attr, raw))
          // ⚠️ v2.9.1 : l'isochrone est attr = 0x01 (la v2.8.1 testait
          // 0x00 — control — et REJETAIT donc toutes les webcams ISO :
          // « Aucun endpoint VideoStreaming IN » sur les webcams grand public).
          if ((addr and 0x80) != 0 && (attr == 0x02 || attr == 0x01)) {
            out.vsEps.add(VsEp(curIfAlt, addr, attr == 0x02, raw))
          }
        }
      }
      i += len
    }
    return out
  }

  private fun le32(d: ByteArray, off: Int): Int {
    return (d[off].toInt() and 0xFF) or ((d[off + 1].toInt() and 0xFF) shl 8) or
        ((d[off + 2].toInt() and 0xFF) shl 16) or ((d[off + 3].toInt() and 0xFF) shl 24)
  }

  private fun pickFrame(formats: List<UvcFormat>, wantW: Int, wantH: Int): Pair<UvcFormat, UvcFrame>? {
    var best: Pair<UvcFormat, UvcFrame>? = null
    var bestScore = Double.MAX_VALUE
    for (f in formats) {
      // préférence MJPEG (payload = JPEG direct, pas de ré-encodage)
      val bias = if (f.mjpeg) 0.0 else 0.5
      for (fr in f.frames) {
        val score = Math.abs(fr.w - wantW).toDouble() / wantW +
            Math.abs(fr.h - wantH).toDouble() / wantH + bias
        if (score < bestScore) { bestScore = score; best = Pair(f, fr) }
      }
    }
    return best
  }

  /* ------------------------------------------------------------ */
  /* Requêtes de contrôle UVC                                       */
  /*   VS (probe/commit)   : wIndex = numéro de l'interface VS       */
  /*   Unité (PU/CT)       : wIndex = (unitId << 8) | interface VC   */
  /* ------------------------------------------------------------ */

  /** GET sur l'interface VS (probe) — wIndex = vsCtrlIfNum (v2.9.3). */
  private fun ctrlGetVs(conn: UsbDeviceConnection, cs: Int, req: Int, len: Int): ByteArray? {
    val buf = ByteArray(len)
    val n = conn.controlTransfer(0xA1, req, (cs shl 8) and 0xFFFF, vsCtrlIfNum and 0xFF, buf, len, 300)
    return if (n == len) buf else null
  }

  /** SET sur l'interface VS (probe/commit) — wIndex = vsCtrlIfNum. */
  private fun ctrlSetVs(conn: UsbDeviceConnection, cs: Int, data: ByteArray): Boolean {
    return conn.controlTransfer(0x21, 0x01, (cs shl 8) and 0xFFFF, vsCtrlIfNum and 0xFF, data, data.size, 300) == data.size
  }

  /** GET sur une unité (PU/CT) — wIndex = (unitId << 8) | vcIfNum. */
  private fun ctrlGet(conn: UsbDeviceConnection, entity: Int, cs: Int, req: Int, len: Int): ByteArray? {
    val buf = ByteArray(len)
    val n = conn.controlTransfer(
        0xA1, req, (cs shl 8) and 0xFFFF, (entity shl 8) or (vcIfNum and 0xFF), buf, len, 300)
    return if (n == len) buf else null
  }

  /** SET sur une unité (PU/CT) — wIndex = (unitId << 8) | vcIfNum. */
  private fun ctrlSet(conn: UsbDeviceConnection, entity: Int, cs: Int, data: ByteArray): Boolean {
    return conn.controlTransfer(
        0x21, 0x01, (cs shl 8) and 0xFFFF, (entity shl 8) or (vcIfNum and 0xFF), data, data.size, 300) == data.size
  }

  /* ------------------------------------------------------------ */
  /* Flux                                                           */
  /* ------------------------------------------------------------ */

  /** Ouverture classique (v2.7.0) : la meilleure frame pour width×height
   *  + intervalle le plus proche de fpsMax — délègue à openStreamInternal. */
  @ReactMethod
  fun openUvcStream(deviceName: String, width: Int, height: Int, fpsMax: Int, quality: Int, promise: Promise) {
    openStreamInternal(deviceName, null, null, null, width, height, fpsMax, quality, promise)
  }

  /** Ouverture EXPLICITE (v2.8.0 — « choisir la résolution, framerate ») :
   *  format/frame/intervalle choisis dans les listes de getUvcRanges
   *  (interval en unités UVC 100 ns). */
  @ReactMethod
  fun openUvcStreamEx(deviceName: String, formatIndex: Int, frameIndex: Int, interval: Int, quality: Int, promise: Promise) {
    openStreamInternal(deviceName, formatIndex, frameIndex, interval, 0, 0, 0, quality, promise)
  }

  private fun openStreamInternal(
      deviceName: String, formatIndex: Int?, frameIndex: Int?, interval: Int?,
      width: Int, height: Int, fpsMax: Int, quality: Int, promise: Promise,
  ) {
    try {
      val mgr = usbManager ?: return promise.reject("USB", "UsbManager indisponible")
      val dev = mgr.deviceList.values.firstOrNull { it.deviceName == deviceName }
          ?: return promise.reject("USB", "Périphérique non trouvé : $deviceName")
      if (!mgr.hasPermission(dev)) return promise.reject("PERM", "Permission USB refusée")
      closeLocked()
      val conn = mgr.openDevice(dev) ?: return promise.reject("OPEN", "Ouverture USB impossible")
      val desc = parseDescriptors(conn)
      if (desc.vsIfNum < 0) { conn.close(); return promise.reject("UVC", "Interface VideoStreaming absente") }
      vcIfNum = desc.vcIfNum
      vsIfNum = desc.vsIfNum
      vsCtrlIfNum = desc.vsIfNum // probe/commit : interface VS du parsing (le repli peut basculer)
      controlUnitPu = desc.puId
      controlUnitCt = desc.ctId
      // Interface PORTEUSE des endpoints — distincte de vsIfNum (contrôle)
      // depuis le fallback v2.9.2 : un périphérique exotique peut publier ses
      // endpoints sur une interface que le parsing brut n'attribue pas à la VS.
      var epIfNum = desc.vsIfNum

      // FALLBACK SCAN SDK (v2.9.2 — « Aucun endpoint VideoStreaming IN »
      // persistait sur la caméra de l'utilisateur même avec le parsing ISO) :
      // si le parsing des descripteurs BRUTS n'a trouvé AUCUN endpoint,
      // rescanner les interfaces exposées par le noyau (UsbDevice) — tous
      // alternate settings, tous types. Hiérarchie : interface VS du
      // parsing → classe VIDEO sous-classe VS → classe VIDEO → toute
      // interface hors AUDIO/HID (les micros ont des endpoints ISO IN qui
      // ne doivent JAMAIS être pris pour du vidéo).
      if (desc.vsEps.isEmpty()) {
        val cands = ArrayList<Pair<VsEp, Int>>() // endpoint + interface propriétaire
        for (k in 0 until dev.interfaceCount) {
          val itf = dev.getInterface(k)
          for (j in 0 until itf.endpointCount) {
            val e = itf.getEndpoint(j)
            if (e.direction != UsbConstants.USB_DIR_IN) continue
            val bulk = e.type == UsbConstants.USB_ENDPOINT_XFER_BULK
            val iso = e.type == UsbConstants.USB_ENDPOINT_XFER_ISOC
            if (!bulk && !iso) continue
            cands.add(Pair(VsEp(itf.alternateSetting, e.address, bulk, e.maxPacketSize), itf.id))
          }
        }
        fun itfOf(id: Int): UsbInterface? {
          for (k in 0 until dev.interfaceCount) {
            val f = dev.getInterface(k)
            if (f.id == id) return f
          }
          return null
        }
        val pick = cands.firstOrNull { (_, id) -> id == desc.vsIfNum }
            ?: cands.firstOrNull { (_, id) ->
              val f = itfOf(id)
              f != null && f.interfaceClass == UsbConstants.USB_CLASS_VIDEO &&
                  f.interfaceSubclass == SC_VIDEOSTREAMING }
            ?: cands.firstOrNull { (_, id) ->
              val f = itfOf(id)
              f != null && f.interfaceClass == UsbConstants.USB_CLASS_VIDEO }
            ?: cands.firstOrNull { (_, id) ->
              val f = itfOf(id)
              f != null && f.interfaceClass != UsbConstants.USB_CLASS_AUDIO &&
                  f.interfaceClass != UsbConstants.USB_CLASS_HID }
        if (pick != null) {
          desc.vsEps.add(pick.first)
          if (pick.second != desc.vsIfNum) epIfNum = pick.second
        }
      }

      val picked = if (formatIndex != null && frameIndex != null) {
        val f = desc.formats.firstOrNull { it.index == formatIndex }
        val fr = f?.frames?.firstOrNull { it.index == frameIndex }
        if (f != null && fr != null) Pair(f, fr) else null
      } else pickFrame(desc.formats, width, height)
      picked ?: run {
        conn.close()
        return promise.reject("UVC", "Format/frame UVC introuvable dans les descripteurs")
      }
      val (format, frame) = picked
      // intervalle explicite, sinon le plus rapide sous 1/(fpsMax) ; sinon le plus rapide
      val wantInt = 10_000_000 / (if (fpsMax in 1..59) fpsMax else 60)
      val intervalVal = interval
          ?: frame.intervals.minByOrNull { Math.abs(it - wantInt) }
          ?: frame.intervals.minOrNull() ?: 10_000_000

      // TRANSPORT — scan des endpoints VS depuis les DESCRIPTEURS BRUTS.
      // ⚠️ CAUSE DE « cette caméra n'expose pas d'endpoint » (v2.7/v2.8) :
      // l'alternate setting 0 de l'interface VS n'a JAMAIS d'endpoint
      // (zéro bande passante) et dev.interfaceCount liste TOUTES les
      // variantes — le 1er UsbInterface correspondant était donc alt 0.
      // BULK privilégié (caméras astronomiques) ; ISO sinon (webcams grand
      // public : Logitech, ELP…) via UsbRequest.setIsochronousPackets
      // (API 31+ — le téléphone cible est en Android 15).
      val bulkEpDesc = desc.vsEps.firstOrNull { it.bulk }
      val isoEpDescs = desc.vsEps.filterNot { it.bulk }.sortedBy { it.maxPacket }
      if (bulkEpDesc == null && isoEpDescs.isEmpty()) {
        conn.close()
        // message enrichi v2.9.1/2 : ce que le parsing a VU (formats, alts,
        // endpoints bruts, nb d'interfaces au scan SDK) — indispensable pour
        // diagnostiquer une caméra exotique d'après le seul retour utilisateur.
        return promise.reject("UVC",
            "Aucun endpoint VideoStreaming IN (formats=%d, alts=[%s], eps=[%s], ifaces=%d, epIf=%d)"
                .format(Locale.US, desc.formats.size,
                    desc.vsAlts.joinToString(",") { it.toString() },
                    desc.rawEps.joinToString(" "),
                    dev.interfaceCount, epIfNum))
      }
      val isoMode = bulkEpDesc == null

      // négociation PROBE — ÉCHELLE DE REPLI (v2.9.3, « PROBE refusé par
      // la caméra ») : un SET_CUR unique ne suffit pas, les firmwares UVC
      // sont capricieux — et un refus EP0 s'EFFACE TOUT SEUL au SETUP
      // suivant (STALL auto-clear), donc réessayer est sans danger :
      //  1. LONGUEUR : GET_LEN (0x85) d'abord ; s'il échoue, 26 (UVC
      //     1.0/1.1), 34 et 48 (firmwares étendus/UVC 1.5) — un SET_CUR à
      //     la mauvaise longueur est STALLÉ.
      //  2. BASE : GET_CUR prérempli (certains firmwares refusent une
      //     structure tout-zéro) PUIS structure canonique propre — le
      //     prérempli peut AUSSI être refusé (état interne douteux).
      //  3. INTERFACE : le contrôle va sur l'interface VS du parsing
      //     (spec UVC) ; si elle refuse tout, retenter sur l'interface
      //     PORTEUSE du scan SDK (epIfNum) — des descripteurs exotiques
      //     déclarent la VS ailleurs.
      var probeLen = -1
      var got: ByteArray? = null
      val triedLens = LinkedHashSet<Int>()
      var curOk = 0
      val ctrlIfs = LinkedHashSet<Int>()
      ctrlIfs.add(desc.vsIfNum)
      if (epIfNum != desc.vsIfNum) ctrlIfs.add(epIfNum)
      probeLoop@ for (ifc in ctrlIfs) {
        vsCtrlIfNum = ifc
        // claim best-effort de l'interface (alt 0) — même précaution que
        // libuvc ; sans effet si le noyau la référence déjà
        for (k in 0 until dev.interfaceCount) {
          val f = dev.getInterface(k)
          if (f.id == ifc && f.alternateSetting == 0) {
            try { conn.claimInterface(f, false) } catch (_: Exception) {}
            break
          }
        }
        val lens = ArrayList<Int>()
        ctrlGetLen(conn)?.let { lens.add(it) }
        for (c in PROBE_LENS_FALLBACK) if (!lens.contains(c)) lens.add(c)
        for (len in lens) {
          triedLens.add(len)
          val base = ctrlGetVs(conn, CS_PROBE, 0x81, len)
          if (base != null) curOk += 1
          val cands = ArrayList<ByteArray>(2)
          if (base != null) cands.add(base.copyOf())
          cands.add(ByteArray(len))
          for (cand in cands) {
            cand[2] = format.index.toByte()
            cand[3] = frame.index.toByte()
            if (len >= 8) putLe32(cand, 4, intervalVal)
            if (ctrlSetVs(conn, CS_PROBE, cand)) {
              probeLen = len
              // GET_CUR post-SET ×3 — certains firmwares répondent au 2e tour
              for (t in 0 until 3) {
                got = ctrlGetVs(conn, CS_PROBE, 0x81, len)
                if (got != null) break
              }
              if (got != null) break@probeLoop
            }
          }
        }
      }
      if (got == null) {
        conn.close()
        return promise.reject("UVC",
            if (probeLen >= 0)
              "PROBE accepté (len=%d) mais GET_CUR muet (curOK=%d, fmt=%d, frame=%d, interval=%d, ifVS=%d, epIf=%d)"
                  .format(Locale.US, probeLen, curOk, format.index, frame.index,
                      intervalVal, desc.vsIfNum, epIfNum)
            else
              "PROBE refusé par la caméra (lens=%s, curOK=%d, fmt=%d, frame=%d, interval=%d, ifVS=%d, epIf=%d)"
                  .format(Locale.US, triedLens.joinToString(","), curOk, format.index, frame.index,
                      intervalVal, desc.vsIfNum, epIfNum))
      }
      // ⚠️ offsets VS_PROBE_CONTROL : dwMaxVideoFrameSize à 18,
      // dwMaxPayloadTransferSize à 22 (v2.8.0 lisait 20/24 — décalés)
      val maxFrameBytes = le32(got, 18)
      val maxPayload = le32(got, 22)
      val commit = got.copyOf()

      // interface + endpoint + alternate setting porteur
      var vsIf: UsbInterface? = null
      var ep: UsbEndpoint? = null
      var chosenRawPacket = 0
      var chosenActualPacket = 0
      if (bulkEpDesc != null) {
        val bd = bulkEpDesc
        for (k in 0 until dev.interfaceCount) {
          val f = dev.getInterface(k)
          // epIfNum (v2.9.2) : l'interface PORTEUSE de l'endpoint — identique
          // à vsIfNum sauf si le fallback SDK a trouvé les endpoints ailleurs
          if (f.id == epIfNum && f.alternateSetting == bd.alt) { vsIf = f; break }
        }
        vsIf ?: run {
          conn.close()
          return promise.reject("UVC", "Interface VS alt ${bd.alt} introuvable (if $epIfNum)")
        }
        for (j in 0 until vsIf.endpointCount) {
          val e = vsIf.getEndpoint(j)
          if (e.direction == UsbConstants.USB_DIR_IN &&
              e.type == UsbConstants.USB_ENDPOINT_XFER_BULK) { ep = e; break }
        }
        ep ?: run {
          conn.close()
          return promise.reject("UVC", "Endpoint BULK introuvable sur alt ${bd.alt}")
        }
        if (!conn.claimInterface(vsIf, true)) {
          conn.close()
          return promise.reject("UVC", "Claim interface VS échoué")
        }
        // ACTIVE l'alternate setting porteur de l'endpoint — sans cela le
        // périphérique reste à alt 0 et chaque bulkTransfer échoue
        if (!setAltSetting(conn, epIfNum, bd.alt)) {
          conn.close()
          return promise.reject("UVC", "SET_INTERFACE(${bd.alt}) refusé")
        }
        // CLEAR_FEATURE(ENDPOINT_HALT) : débloque un endpoint resté coincé
        // par une session précédente (même précaution que libusb)
        try { conn.controlTransfer(0x02, 0x01, 0, ep.address, null, 0, 200) } catch (_: Exception) {}
      } else {
        // ISO — SDK public : UsbRequest.queue() coupe le buffer en tranches
        // wMaxPacketSize BRUT (libusbhost) ; le haut-débit (mult > 1) n'est
        // pas exploitable de façon fiable → besoin plafonné à 1024 octets
        // par microframe, alt SANS multiplicateur (raw == réel) privilégié.
        val fps = (10_000_000.0 / intervalVal).coerceIn(1.0, 120.0)
        val need = if (maxPayload > 0) maxPayload else {
          val rawBytes = if (maxFrameBytes > 0) maxFrameBytes else frame.w * frame.h * 2
          val comp = if (format.mjpeg) 8.0 else 1.0
          (rawBytes / comp * fps / 8000.0 * 1.2).toInt().coerceAtLeast(128)
        }
        val needCapped = minOf(need, 1024)
        val cand = isoEpDescs.firstOrNull { it.maxPacket >= needCapped && it.rawMaxPacket == it.maxPacket }
            ?: isoEpDescs.firstOrNull { it.maxPacket >= needCapped }
            ?: isoEpDescs.last() // aucune tranche simple : la plus large bande
        // échelle de repli : candidat → plus petits (moins de bande :
        // SET_INTERFACE réussit, frames partielles possibles) → plus grands
        val ladder = (listOf(cand)
            + isoEpDescs.filter { it !== cand && it.maxPacket <= cand.maxPacket }
                .sortedByDescending { it.maxPacket }
            + isoEpDescs.filter { it !== cand && it.maxPacket > cand.maxPacket }
                .sortedByDescending { it.maxPacket }).distinctBy { it.alt }
        var altErr: String? = null
        for (cd in ladder) {
          var f: UsbInterface? = null
          for (k in 0 until dev.interfaceCount) {
            val itf = dev.getInterface(k)
            if (itf.id == epIfNum && itf.alternateSetting == cd.alt) { f = itf; break }
          }
          f ?: continue
          if (!conn.claimInterface(f, true)) { altErr = "claim alt ${cd.alt}"; continue }
          if (!setAltSetting(conn, epIfNum, cd.alt)) { altErr = "SET_INTERFACE(${cd.alt})"; continue }
          var e2: UsbEndpoint? = null
          for (j in 0 until f.endpointCount) {
            val e = f.getEndpoint(j)
            if (e.direction == UsbConstants.USB_DIR_IN &&
                e.type == UsbConstants.USB_ENDPOINT_XFER_ISOC) { e2 = e; break }
          }
          e2 ?: continue
          vsIf = f; ep = e2
          chosenRawPacket = cd.rawMaxPacket
          chosenActualPacket = cd.maxPacket
          altErr = null
          break
        }
        if (vsIf == null || ep == null) {
          conn.close()
          return promise.reject("ISO",
              "Allocation USB impossible (${altErr ?: "aucun alternate setting"})")
        }
        // la caméra doit connaître la bande allouée par l'hôte
        if (maxPayload <= 0) putLe32(commit, 22, chosenActualPacket)
      }

      if (!ctrlSetVs(conn, CS_COMMIT, commit)) {
        conn.close()
        return promise.reject("UVC",
            "COMMIT refusé par la caméra (len=%d, curOK=%d, ifVS=%d, epIf=%d)"
                .format(Locale.US, commit.size, curOk, vsCtrlIfNum, epIfNum))
      }

      // état
      connection = conn
      vsInterface = vsIf
      bulkEp = ep
      frameW = frame.w; frameH = frame.h
      isMjpeg = format.mjpeg
      expectedFrame = if (!isMjpeg && maxFrameBytes in 1..(32 * 1024 * 1024)) maxFrameBytes else 0
      jpegQuality = quality.coerceIn(40, 95)
      frameSkip = if (fpsMax >= 30) 1 else maxOf(1, 30 / maxOf(1, fpsMax))
      frameCount = 0
      val cap = if (maxFrameBytes in 1..(32 * 1024 * 1024)) maxFrameBytes else frame.w * frame.h * 2
      acc = ByteArray(maxOf(cap, 96 * 1024))
      accLen = 0
      lastFid = -1
      streaming = true
      synchronized(lumaRing) { lumaRing.clear() }

      thread = HandlerThread("autostar-uvc").apply { start() }
      handler = Handler(thread!!.looper)
      if (isoMode) {
        // ISO : anneau de UsbRequest — le buffer est coupé automatiquement
        // en tranches chosenRawPacket par microframe (libusbhost) ;
        // complétion via requestWait() (FIFO — le même anneau tourne).
        // 32 tranches par requête, 8 requêtes en vol ≈ 32 ms de marge.
        val reqs = ArrayList<UsbRequest>(ISO_REQ_COUNT)
        val bufs = HashMap<UsbRequest, ByteBuffer>(ISO_REQ_COUNT)
        try {
          for (i in 0 until ISO_REQ_COUNT) {
            val r = UsbRequest()
            if (!r.initialize(conn, ep)) throw IllegalStateException("UsbRequest init échoué")
            val b = ByteBuffer.allocateDirect(chosenRawPacket * ISO_PACKETS_PER_REQ)
            if (!r.queue(b)) throw IllegalStateException("File ISO refusée")
            reqs.add(r); bufs[r] = b
          }
        } catch (e: Exception) {
          for (r in reqs) { try { r.cancel() } catch (_: Exception) {}; try { r.close() } catch (_: Exception) {} }
          closeLocked()
          return promise.reject("ISO", e.message ?: "Flux ISO impossible", e)
        }
        isoRequests = reqs
        val t = Thread { isoReadLoop(conn, reqs, bufs, chosenRawPacket) }
        readThread = t
        t.start()
      } else {
        // ⚠️ UsbDeviceConnection.bulkTransfer est plafonné à 16384 octets
        // par appel — au-delà chaque transfert échoue (v2.7.0 : bufSize =
        // maxPayload pouvait dépasser → aucun flux). Les GRANDES frames
        // sont réassemblées par la boucle (accumulateur partagé).
        val t = Thread { bulkReadLoop(conn, ep, 16_384) }
        readThread = t
        t.start()
      }
      promise.resolve(true)
    } catch (e: Exception) {
      closeLocked()
      promise.reject("OPEN", e.message, e)
    }
  }

  /** GET_LEN de la structure probe/commit — null si la caméra ne répond
   *  pas ou renvoie une longueur invraisemblable (le repli essaye alors
   *  26/34/48 : un SET_CUR à la mauvaise longueur est STALLÉ). */
  private fun ctrlGetLen(conn: UsbDeviceConnection): Int? {
    val buf = ByteArray(2)
    val n = conn.controlTransfer(0xA1, 0x85, (CS_PROBE shl 8) and 0xFFFF,
        vsCtrlIfNum and 0xFF, buf, 2, 300)
    if (n == 2) {
      val v = (buf[0].toInt() and 0xFF) or ((buf[1].toInt() and 0xFF) shl 8)
      if (v in 26..64) return v
    }
    return null
  }

  private fun putLe32(b: ByteArray, off: Int, v: Int) {
    b[off] = (v and 0xFF).toByte()
    b[off + 1] = ((v shr 8) and 0xFF).toByte()
    b[off + 2] = ((v shr 16) and 0xFF).toByte()
    b[off + 3] = ((v shr 24) and 0xFF).toByte()
  }

  /** SET_INTERFACE — active l'alternate setting (alloue la bande passante
   *  ISO / expose l'endpoint bulk). Absent de l'API SDK : requête de
   *  contrôle USB standard (bmRequestType 0x01, bRequest 0x0B). */
  private fun setAltSetting(conn: UsbDeviceConnection, ifNum: Int, alt: Int): Boolean {
    return try {
      conn.controlTransfer(0x01, 0x0B, alt, ifNum and 0xFF, null, 0, 300) >= 0
    } catch (_: Exception) { false }
  }

  private fun allZeros(b: ByteArray, from: Int, to: Int): Boolean {
    var k = from
    while (k < to) { if (b[k].toInt() != 0) return false; k += 1 }
    return true
  }

  /**
   * Réassemblage PARTAGÉ bulk/ISO — ingest d'UN paquet UVC (en-tête +
   * payload) : les paquets UVC sont des FRAGMENTS de frame, la frame
   * complète est réassemblée dans l'accumulateur (acc/accLen/lastFid).
   * Frontières de frame :
   *  - bascule du bit FID (bmHeaderInfo bit 0 — s'inverse à chaque frame)
   *    → la frame précédente est complète ;
   *  - pour MJPEG : marqueur EOI (FF D9) en fin de payload — émission
   *    immédiate (certaines caméras ne basculent FID qu'au paquet suivant) ;
   *  - pour UNCOMPRESSED : taille exacte dwMaxVideoFrameSize — troncature
   *    qui neutralise les zéros de bourrage ISO en fin de frame.
   * bit 5 (0x20) = ERR → frame à jeter. NB : le bit 6 (0x40) est EOH (fin
   * d'EN-TÊTE, pas fin de frame) — la v2.7.0 le prenait pour une fin de
   * frame et émettait chaque paquet comme une « frame » JPEG incomplète
   * (décodage impossible → AUCUN flux visible).
   */
  private fun ingestPacket(buf: ByteArray, off: Int, end: Int) {
    if (end - off < 2) return
    val hlen = buf[off].toInt() and 0xFF
    if (hlen < 2 || off + hlen > end) return // en-tête invalide : paquet jeté
    val hdr = buf[off + 1].toInt() and 0xFF
    val fid = hdr and 0x01            // Frame Identifier (bascule par frame)
    val err = (hdr and 0x20) != 0     // ERR : frame corrompue → jetée
    val plen = end - (off + hlen)
    if (err) { accLen = 0; return }
    if (fid != lastFid && lastFid >= 0 && accLen > 0) {
      // bascule FID = début d'une NOUVELLE frame → la précédente est complète
      val frame = acc.copyOf(accLen)
      accLen = 0
      emitFrame(frame)
    }
    lastFid = fid
    if (plen > 0) {
      if (accLen + plen > acc.size) {
        // frame trop grande : réalloue (caméra renvoyant plus que annoncé)
        acc = acc.copyOf(maxOf(acc.size * 2, accLen + plen))
      }
      System.arraycopy(buf, off + hlen, acc, accLen, plen)
      accLen += plen
      if (isMjpeg) {
        // EOI en bout de payload = frame complète, émission immédiate
        if (accLen >= 4 && acc[0] == 0xFF.toByte() && acc[1] == 0xD8.toByte() &&
            acc[accLen - 2] == 0xFF.toByte() && acc[accLen - 1] == 0xD9.toByte()) {
          val frame = acc.copyOf(accLen)
          accLen = 0
          emitFrame(frame)
        }
      } else if (expectedFrame > 0 && accLen >= expectedFrame) {
        // YUY2 : taille exacte annoncée — coupe au juste octet (le bourrage
        // ISO des zéros après le dernier paquet partiel est éliminé)
        val frame = acc.copyOf(expectedFrame)
        accLen = 0
        emitFrame(frame)
      }
    }
  }

  /** Boucle de lecture BULK — chaque bulkTransfer (≤ 16 Ko, plafond
   *  Android) transporte UN paquet UVC ; l'accumulateur réassemble. */
  private fun bulkReadLoop(conn: UsbDeviceConnection, ep: UsbEndpoint, bufSize: Int) {
    val buf = ByteArray(bufSize)
    var errors = 0
    while (streaming) {
      val n = try { conn.bulkTransfer(ep, buf, buf.size, BULK_TIMEOUT_MS) } catch (_: Exception) { -1 }
      if (n < 0) {
        errors += 1
        if (errors > MAX_READ_ERRORS) { notifyDead(); return }
        continue
      }
      errors = 0
      ingestPacket(buf, 0, n)
    }
  }

  /**
   * Boucle de lecture ISO (webcams grand public) — anneau de UsbRequest :
   * libusbhost coupe chaque buffer en tranches wMaxPacketSize BRUT (une
   * tranche par microframe) ; requestWait() rend les requêtes complétées
   * dans l'ordre. Parsing par tranche : en-tête UVC présent = paquet
   * utile, payload intégralement nul = microtrame sans donnée ; puis
   * zero-fill + re-queue. Les zéros de bourrage en fin de frame sont
   * neutralisés par la troncature exacte (UNCOMPRESSED) ou l'EOI/FID
   * (MJPEG).
   */
  private fun isoReadLoop(
      conn: UsbDeviceConnection, reqs: List<UsbRequest>,
      bufs: Map<UsbRequest, ByteBuffer>, packetSize: Int,
  ) {
    val total = packetSize * ISO_PACKETS_PER_REQ
    val chunk = ByteArray(total)
    val zeros = ByteArray(16_384)
    var idx = 0
    var errors = 0
    while (streaming && reqs.isNotEmpty()) {
      val r = try { conn.requestWait() } catch (_: Exception) { null }
      if (r == null || !reqs.contains(r)) {
        errors += 1
        if (errors > MAX_READ_ERRORS) { notifyDead(); return }
        continue
      }
      val b = bufs[r]
      if (b == null) { errors += 1; continue }
      errors = 0
      b.rewind()
      b.get(chunk)
      var off = 0
      for (p in 0 until ISO_PACKETS_PER_REQ) {
        val end = off + packetSize
        if (end <= total) {
          val hlen = chunk[off].toInt() and 0xFF
          if (hlen in 2..32 && !allZeros(chunk, off + hlen, end)) {
            ingestPacket(chunk, off, end)
          }
        }
        off = end
      }
      // zero-fill (les paquets vides restent à zéro → ignorés au prochain
      // tour) puis re-queue immédiate
      b.clear(); b.rewind()
      var p = 0
      while (p < total) { val n = minOf(zeros.size, total - p); b.put(zeros, 0, n); p += n }
      b.rewind()
      val re = try { r.queue(b) } catch (_: Exception) { false }
      if (!re) { notifyDead(); return }
      idx = (idx + 1) % reqs.size
    }
  }

  private fun notifyDead() {
    if (!streaming) return
    streaming = false
    handler?.post {
      closeLocked()
      val mp = Arguments.createMap()
      mp.putString("error", "uvcStreamLost")
      sendEvent("uvcStreamLost", mp)
    }
  }

  private fun emitFrame(payload: ByteArray) {
    frameCount += 1
    val emit = frameCount % frameSkip == 0L
    // JPEG unique supporté par l'aperçu : MJPEG déjà encodé, YUY2 converti
    val jpeg: ByteArray? = if (isMjpeg) payload else yuy2ToJpeg(payload, frameW, frameH)
    if (jpeg == null) return
    // luminance + centroïde à chaque frame (pas cher, 192×144)
    var luma: ByteArray? = null
    var w = frameW; var h = frameH
    if (!isMjpeg) {
      luma = lumaFromYuy2(payload, frameW, frameH)
      if (luma == null) return // YUY2 partiel : frame perdue
    } else {
      val bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
      if (bmp != null) { w = bmp.width; h = bmp.height; luma = lumaFromBitmap(bmp) }
    }
    if (luma != null) {
      synchronized(lumaRing) {
        if (lumaRing.size >= 8) lumaRing.removeFirst()
        lumaRing.addLast(luma)
      }
    }
    if (!emit) {
      // pose demandée : la forcer même si la frame n'était pas émise
      val p = pendingStill
      if (p != null) {
        pendingStill = null
        p.resolve(Base64.encodeToString(jpeg, Base64.NO_WRAP))
      }
      return
    }
    val mp = Arguments.createMap().apply {
      putString("data", Base64.encodeToString(jpeg, Base64.NO_WRAP))
      putInt("w", w)
      putInt("h", h)
      putDouble("ts", System.currentTimeMillis().toDouble())
      putString("source", "uvc")
    }
    if (luma != null && !lockX.isNaN() && !lockY.isNaN()) {
      val c = centroidInLuma(luma, LUMA_W, LUMA_H, lockX, lockY, lockHalf)
      if (c != null) {
        mp.putDouble("cx", c.first.toDouble())
        mp.putDouble("cy", c.second.toDouble())
        mp.putDouble("peak", c.third.first.toDouble())
        mp.putDouble("flux", c.third.second.toDouble())
      }
    }
    if (pendingStill != null) {
      val p = pendingStill
      pendingStill = null
      p?.resolve(Base64.encodeToString(jpeg, Base64.NO_WRAP))
    } else {
      sendEvent("cameraFrame", mp)
    }
  }

  /** YUY2 → NV21 → JPEG (YuvImage Android standard). */
  private fun yuy2ToJpeg(yuy2: ByteArray, w: Int, h: Int): ByteArray? {
    return try {
      if (yuy2.size < w * h * 2) return null
      val nv21 = ByteArray(w * h * 3 / 2)
      System.arraycopy(yuy2, 0, nv21, 0, w * h)
      var pos = w * h
      var src = w * h
      while (src + 3 < w * h * 2) {
        nv21[pos++] = yuy2[src + 3]  // V
        nv21[pos++] = yuy2[src + 1]  // U
        src += 4
      }
      val yuv = YuvImage(nv21, android.graphics.ImageFormat.NV21, w, h, null)
      val out = ByteArrayOutputStream()
      yuv.compressToJpeg(Rect(0, 0, w, h), jpegQuality, out)
      out.toByteArray()
    } catch (_: Exception) { null }
  }

  /** Luminance 192×144 depuis un Bitmap ARGB (caméras MJPEG). */
  private fun lumaFromBitmap(bmp: Bitmap): ByteArray? {
    return try {
      val small = Bitmap.createScaledBitmap(bmp, LUMA_W, LUMA_H, true)
      val px = IntArray(LUMA_W * LUMA_H)
      small.getPixels(px, 0, LUMA_W, 0, 0, LUMA_W, LUMA_H)
      val out = ByteArray(LUMA_W * LUMA_H)
      for (i in px.indices) {
        val p = px[i]
        val r = (p shr 16) and 0xFF
        val g = (p shr 8) and 0xFF
        val b = p and 0xFF
        out[i] = ((r * 299 + g * 587 + b * 114) / 1000).toByte()
      }
      if (small !== bmp) small.recycle()
      out
    } catch (_: Exception) { null }
  }

  /** Luminance 192×144 depuis YUY2 (format uncompressed UVC). */
  private fun lumaFromYuy2(yuy2: ByteArray, w: Int, h: Int): ByteArray? {
    if (yuy2.size < w * h * 2) return null
    val out = ByteArray(LUMA_W * LUMA_H)
    val sx = w / LUMA_W; val sy = h / LUMA_H
    for (ly in 0 until LUMA_H) {
      var idx = ly * LUMA_W
      val row = ly * sy * w * 2
      for (lx in 0 until LUMA_W) {
        val p = row + lx * sx * 2
        out[idx++] = if (p < yuy2.size) yuy2[p] else 0
      }
    }
    return out
  }

  /** Centroïde lumineux dans la fenêtre de verrouillage (comme Camera2). */
  private fun centroidInLuma(
      luma: ByteArray, w: Int, h: Int, nx: Float, ny: Float, half: Float,
  ): Triple<Float, Float, Pair<Int, Long>>? {
    val cx0 = (nx * w).toInt().coerceIn(1, w - 2)
    val cy0 = (ny * h).toInt().coerceIn(1, h - 2)
    val rx = (half * w).toInt().coerceIn(2, w / 2 - 1)
    val ry = (half * h).toInt().coerceIn(2, h / 2 - 1)
    val x0 = (cx0 - rx).coerceAtLeast(0)
    val x1 = (cx0 + rx).coerceAtMost(w - 1)
    val y0 = (cy0 - ry).coerceAtLeast(0)
    val y1 = (cy0 + ry).coerceAtMost(h - 1)
    var peak = 0
    for (yy in y0..y1) for (xx in x0..x1) {
      val v = luma[yy * w + xx].toInt() and 0xFF
      if (v > peak) peak = v
    }
    val threshold = peak * 55 / 100 + 15
    var sx = 0L; var sy = 0L; var flux = 0L; var n = 0L
    for (yy in y0..y1) for (xx in x0..x1) {
      val v = (luma[yy * w + xx].toInt() and 0xFF) - threshold
      if (v > 0) {
        sx += xx.toLong() * v; sy += yy.toLong() * v; flux += v.toLong(); n += 1
      }
    }
    if (flux <= 0 || n * 1000L < (x1 - x0) * (y1 - y0).toLong() * 3L) return null
    return Triple(sx.toFloat() / flux, sy.toFloat() / flux, Pair(peak, flux))
  }

  /* ------------------------------------------------------------ */
  /* Réglages UVC (contrôles)                                       */
  /* ------------------------------------------------------------ */

  /** Connexion de travail pour les contrôles : RÉUTILISE la connexion du
   *  flux actif si présent (deux connexions ouvertes sur le même appareil
   *  perturbent certains firmware, et la v2.7.0 fuyait la temporaire).
   *  Retour : (connexion, temporaire ?) — la temporaire est à fermer. */
  private fun acquireConn(deviceName: String): Pair<UsbDeviceConnection, Boolean>? {
    val active = connection
    if (active != null) return Pair(active, false)
    val mgr = usbManager ?: return null
    val dev = mgr.deviceList.values.firstOrNull { it.deviceName == deviceName } ?: return null
    if (!mgr.hasPermission(dev)) return null
    val conn = mgr.openDevice(dev) ?: return null
    return Pair(conn, true)
  }

  /** Valeur de contrôle : GET_MIN/GET_MAX/GET_RES/GET_DEF/GET_CUR selon req. */
  private fun getShortCtrl(conn: UsbDeviceConnection, entity: Int, cs: Int, req: Int): Int? {
    val b = ctrlGet(conn, entity, cs, req, 2) ?: return null
    var v = (b[0].toInt() and 0xFF) or ((b[1].toInt() and 0xFF) shl 8)
    if (v >= 0x8000) v -= 0x10000
    return v
  }

  private fun getDwordCtrl(conn: UsbDeviceConnection, entity: Int, cs: Int, req: Int): Int? {
    val b = ctrlGet(conn, entity, cs, req, 4) ?: return null
    return le32(b, 0)
  }

  private fun setShortCtrl(conn: UsbDeviceConnection, entity: Int, cs: Int, v: Int): Boolean {
    val b = ByteArray(2)
    b[0] = (v and 0xFF).toByte()
    b[1] = ((v shr 8) and 0xFF).toByte()
    return ctrlSet(conn, entity, cs, b)
  }

  private fun setDwordCtrl(conn: UsbDeviceConnection, entity: Int, cs: Int, v: Int): Boolean {
    val b = ByteArray(4)
    putLe32(b, 0, v)
    return ctrlSet(conn, entity, cs, b)
  }

  /** Plages des contrôles disponibles (deviceName) — alimente les curseurs.
   *  Réponse : {controls:{<key>:{min,max,step,def}}, hasPu, hasCt,
   *  formats:[{index, mjpeg, label, frames:[{index, w, h, fpsOptions:
   *  [{fps, interval}]}]}]} — formats/frames = listes de RÉSOLUTION et
   *  FPS exactement annoncées par la caméra (v2.8.0, sélecteurs). */
  @ReactMethod
  fun getUvcRanges(deviceName: String, promise: Promise) {
    var conn: UsbDeviceConnection? = null
    var isTemp = false
    try {
      val tmp = acquireConn(deviceName)
          ?: return promise.reject("PERM", "Permission USB absente ou appareil indisponible")
      conn = tmp.first
      isTemp = tmp.second
      val desc = parseDescriptors(conn)
      vcIfNum = if (desc.vcIfNum >= 0) desc.vcIfNum else 0
      controlUnitPu = desc.puId
      controlUnitCt = desc.ctId
      val out = Arguments.createMap()
      val ctrls = Arguments.createMap()
      if (desc.puId != 0) {
        addRange(ctrls, "brightness", 0x02, 2, conn, desc.puId)
        addRange(ctrls, "contrast", 0x03, 2, conn, desc.puId)
        addRange(ctrls, "saturation", 0x07, 2, conn, desc.puId)
        addRange(ctrls, "sharpness", 0x0F, 2, conn, desc.puId)
        addRange(ctrls, "whiteBalanceTemp", 0x0B, 2, conn, desc.puId)
        addRange(ctrls, "gain", 0x4D, 2, conn, desc.puId)
      }
      if (desc.ctId != 0) {
        // exposition absolue en ms (UVC = 0,1 ms)
        addRange(ctrls, "exposureMs", 0x04, 4, conn, desc.ctId) { v -> v / 10.0 }
        addRange(ctrls, "zoom", 0x0D, 4, conn, desc.ctId)
        addRange(ctrls, "focusAbsolute", 0x08, 2, conn, desc.ctId)
      }
      out.putMap("controls", ctrls)
      out.putBoolean("hasPu", desc.puId != 0)
      out.putBoolean("hasCt", desc.ctId != 0)
      // formats + frames + cadences (descripteurs — exactement ce que la
      // caméra sait faire : sélecteurs résolution/framerate v2.8.0)
      val fmts = Arguments.createArray()
      for (f in desc.formats) {
        val fm = Arguments.createMap()
        fm.putInt("index", f.index)
        fm.putBoolean("mjpeg", f.mjpeg)
        fm.putString("label", if (f.mjpeg) "MJPEG" else "YUV")
        val frs = Arguments.createArray()
        for (fr in f.frames.sortedBy { it.w * it.h }) {
          val frm = Arguments.createMap()
          frm.putInt("index", fr.index)
          frm.putInt("w", fr.w)
          frm.putInt("h", fr.h)
          val opts = Arguments.createArray()
          val seen = HashSet<Int>()
          for (iv in fr.intervals.filter { it > 0 }.sorted()) {
            val fps = Math.round(10_000_000.0 / iv).toInt()
            if (fps < 1 || fps > 120 || !seen.add(fps)) continue
            val om = Arguments.createMap()
            om.putInt("fps", fps)
            om.putInt("interval", iv)
            opts.pushMap(om)
          }
          // liste triée desc (plus rapide d'abord), plafonnée à 14 entrées
          val capped = Arguments.createArray()
          var pushed = 0
          for (k in opts.size() - 1 downTo 0) {
            if (pushed >= 14) break
            capped.pushMap(opts.getMap(k))
            pushed += 1
          }
          frm.putArray("fpsOptions", capped)
          frs.pushMap(frm)
        }
        fm.putArray("frames", frs)
        fmts.pushMap(fm)
      }
      out.putArray("formats", fmts)
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject("RANGES", e.message, e)
    } finally {
      if (isTemp) { try { conn?.close() } catch (_: Exception) {} }
    }
  }

  /** Ajoute la plage d'un contrôle (conversion optionnelle vers l'unité JS). */
  private fun addRange(
      ctrls: com.facebook.react.bridge.WritableMap, key: String,
      cs: Int, len: Int, conn: UsbDeviceConnection, entity: Int,
      conv: (Int) -> Double = { it.toDouble() },
  ) {
    val mn = if (len == 2) getShortCtrl(conn, entity, cs, 0x82) else getDwordCtrl(conn, entity, cs, 0x82)
    val mx = if (len == 2) getShortCtrl(conn, entity, cs, 0x83) else getDwordCtrl(conn, entity, cs, 0x83)
    val rs = if (len == 2) getShortCtrl(conn, entity, cs, 0x84) else getDwordCtrl(conn, entity, cs, 0x84)
    val df = if (len == 2) getShortCtrl(conn, entity, cs, 0x87) else getDwordCtrl(conn, entity, cs, 0x87)
    if (mn != null && mx != null && mn != mx) {
      val m = Arguments.createMap()
      m.putDouble("min", conv(mn))
      m.putDouble("max", conv(mx))
      m.putDouble("step", conv(rs ?: 1))
      m.putDouble("def", conv(df ?: mn))
      ctrls.putMap(key, m)
    }
  }

  /** Applique des réglages UVC (JSON string — règle de survie Hermes :
   *  aucun objet JS complexe ni callback). Clés reconnues :
   *  autoExposure(bool), exposureMs, gain, brightness, contrast,
   *  saturation, sharpness, whiteBalanceAuto(bool), whiteBalanceTemp,
   *  zoom, focusAuto(bool), focusAbsolute.
   *  Réponse : {applied:[…], failed:[…]}. */
  @ReactMethod
  fun setUvcControls(deviceName: String, json: String, promise: Promise) {
    try {
      val o = JSONObject(json)
      val tmp = acquireConn(deviceName)
          ?: return promise.reject("PERM", "Permission USB absente ou appareil indisponible")
      val conn = tmp.first
      try {
        val desc = parseDescriptors(conn)
        vcIfNum = if (desc.vcIfNum >= 0) desc.vcIfNum else 0
        val applied = Arguments.createArray()
        val failed = Arguments.createArray()
        val pu = desc.puId
        val ct = desc.ctId

        fun ok(k: String, v: Boolean) { if (v) applied.pushString(k) else failed.pushString(k) }

        if (o.has("autoExposure") && ct != 0) {
          val auto = o.getBoolean("autoExposure")
          // CT_AE_MODE : 1 = manuel, 2 = auto (8 = priorité ouverture en secours)
          var done = setShortCtrl(conn, ct, 0x02, if (auto) 2 else 1)
          if (!done && auto) done = setShortCtrl(conn, ct, 0x02, 8)
          ok("autoExposure", done)
        }
        if (o.has("exposureMs") && ct != 0) {
          val ms = o.getDouble("exposureMs").coerceAtLeast(0.0)
          ok("exposureMs", setDwordCtrl(conn, ct, 0x04, Math.round(ms * 10).toInt()))
        }
        if (o.has("gain") && pu != 0) ok("gain", setShortCtrl(conn, pu, 0x4D, o.getInt("gain")))
        if (o.has("brightness") && pu != 0) ok("brightness", setShortCtrl(conn, pu, 0x02, o.getInt("brightness")))
        if (o.has("contrast") && pu != 0) ok("contrast", setShortCtrl(conn, pu, 0x03, o.getInt("contrast")))
        if (o.has("saturation") && pu != 0) ok("saturation", setShortCtrl(conn, pu, 0x07, o.getInt("saturation")))
        if (o.has("sharpness") && pu != 0) ok("sharpness", setShortCtrl(conn, pu, 0x0F, o.getInt("sharpness")))
        if (o.has("whiteBalanceAuto") && pu != 0) {
          ok("whiteBalanceAuto", setShortCtrl(conn, pu, 0x0D, if (o.getBoolean("whiteBalanceAuto")) 1 else 0))
        }
        if (o.has("whiteBalanceTemp") && pu != 0) {
          ok("whiteBalanceTemp", setShortCtrl(conn, pu, 0x0B, o.getInt("whiteBalanceTemp")))
        }
        if (o.has("zoom") && ct != 0) ok("zoom", setDwordCtrl(conn, ct, 0x0D, o.getInt("zoom")))
        if (o.has("focusAuto") && ct != 0) {
          ok("focusAuto", setShortCtrl(conn, ct, 0x0C, if (o.getBoolean("focusAuto")) 1 else 0))
        }
        if (o.has("focusAbsolute") && ct != 0) {
          ok("focusAbsolute", setShortCtrl(conn, ct, 0x08, o.getInt("focusAbsolute")))
        }
        val out = Arguments.createMap()
        out.putArray("applied", applied)
        out.putArray("failed", failed)
        promise.resolve(out)
      } finally {
        if (tmp.second) { try { conn.close() } catch (_: Exception) {} }
      }
    } catch (e: Exception) {
      promise.reject("CTRL", e.message, e)
    }
  }

  /* ------------------------------------------------------------ */
  /* Divers (même interface JS que Camera2)                         */
  /* ------------------------------------------------------------ */

  @ReactMethod
  fun setLock(x: Double, y: Double, halfWindow: Double, promise: Promise) {
    lockX = x.toFloat(); lockY = y.toFloat()
    lockHalf = halfWindow.toFloat().coerceIn(0.03f, 0.45f)
    promise.resolve(true)
  }

  @ReactMethod
  fun clearLock(promise: Promise) {
    lockX = Float.NaN; lockY = Float.NaN
    promise.resolve(true)
  }

  @ReactMethod
  fun captureStill(promise: Promise) {
    if (!streaming) return promise.reject("NOSESSION", "Aucun flux UVC actif")
    pendingStill = promise
    handler?.postDelayed({
      val p = pendingStill
      if (p != null && p === promise) {
        pendingStill = null
        p.reject("TIMEOUT", "Aucune frame reçue pour la pose")
      }
    }, 4000)
  }

  @ReactMethod
  fun getLumaHistory(promise: Promise) {
    val arr = Arguments.createArray()
    synchronized(lumaRing) {
      for (b in lumaRing) arr.pushString(Base64.encodeToString(b, Base64.NO_WRAP))
    }
    promise.resolve(arr)
  }

  @ReactMethod
  fun closeUvcStream(promise: Promise) {
    closeLocked()
    promise.resolve(true)
  }

  @ReactMethod
  fun isUvcStreaming(promise: Promise) = promise.resolve(streaming)

  /** Fermeture complète (thread lecteur, interface, connexion). */
  private fun closeLocked() {
    streaming = false
    try { readThread?.interrupt() } catch (_: Exception) {}
    readThread = null
    val reqs = isoRequests
    isoRequests = null
    if (reqs != null) {
      for (r in reqs) {
        try { r.cancel() } catch (_: Exception) {}
        try { r.close() } catch (_: Exception) {}
      }
    }
    val conn = connection
    connection = null
    val vsIf = vsInterface
    vsInterface = null
    bulkEp = null
    pendingStill?.let { it.reject("CLOSED", "Flux fermé") }
    pendingStill = null
    synchronized(lumaRing) { lumaRing.clear() }
    try { if (vsIf != null && conn != null) conn.releaseInterface(vsIf) } catch (_: Exception) {}
    try { conn?.close() } catch (_: Exception) {}
    thread?.quitSafely()
    thread = null; handler = null
    lockX = Float.NaN; lockY = Float.NaN
  }

  // Stubs requis par NativeEventEmitter côté JS.
  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}
}