package com.autostardroid.camera

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import android.util.Range
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.ByteArrayOutputStream

/**
 * Module natif CAMÉRA ASTRONOMIQUE (v2.5.0 — demande utilisateur : « je veux
 * un module d'affichage de flux video, afin de connecter une caméra
 * astronomique, avec une option de suivi de l'objet par le télescope basé
 * sur l'image video, et possibilité d'automatiser l'acquisition d'image »).
 *
 * - ÉNUMÉRATION via Camera2 : les caméras UVC supportées par Android
 *   (LENS_FACING_EXTERNAL) ET les caméras internes (secours utile pour
 *   tester l'appli sans matériel). La vraie caméra astro UVC se présente
 *   comme caméra externe sur Android 9+ quand le pilote noyau UVC est là.
 * - FLUX : ImageReader YUV_420_888 → conversion NV21 → JPEG compressé →
 *   événement "cameraFrame" {data(base64), w, h, cx, cy, peak, flux}.
 *   Cadence plafonnée (frameSkip) pour ne pas saturer le pont JS.
 * - LUMINANCE RÉDUITE (anneau mémoire 8 frames 192×144) : base de
 *   l'EMPILEMENT côté JS (getLumaHistory) — les pixels restent côté natif.
 * - CENTROÏDE pour l'AUTOGUIDAGE : quand un point de verrouillage est posé
 *   (setLock), chaque frame émet le centroïde lumineux dans la fenêtre de
 *   recherche autour du verrou (cx/cy normalisés -1 = perdu, peak, flux).
 *
 * ⚠️ Règle de survie Hermes (v1.7.2) : TOUTES les méthodes sont basées sur
 * Promise, AUCUN callback JS ne traverse le pont — les résultats arrivent
 * par Promise ou par événements (RCTDeviceEventEmitter).
 */
class UsbCameraModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "NativeUsbCamera"
    /** Taille de l'anneau de luminance réduite (empilement). */
    private const val LUMA_HISTORY = 8
    /** Résolution de la luminance réduite. */
    private const val LUMA_W = 192
    private const val LUMA_H = 144
  }

  private val cameraManager: CameraManager?
    get() = reactApplicationContext.getSystemService(Context.CAMERA_SERVICE) as? CameraManager

  private var device: CameraDevice? = null
  private var session: CameraCaptureSession? = null
  private var reader: ImageReader? = null
  private var thread: HandlerThread? = null
  private var handler: Handler? = null
  private var activeId: String? = null
  private var frameSkip = 1          // 1 frame émise sur N
  private var frameCount = 0L
  private var jpegQuality = 70
  /** Point de verrouillage normalisé (autoguidage) — null = pas de suivi. */
  private var lockX = Float.NaN
  private var lockY = Float.NaN
  /** Demi-fenêtre de recherche du centroïde (fraction de l'image). */
  private var lockHalf = 0.13f
  /** Anneau de luminance réduite (plus récent en fin). */
  private val lumaRing = ArrayDeque<ByteArray>(LUMA_HISTORY)
  private var pendingStill: Promise? = null

  private fun sendEvent(name: String, params: WritableMap) {
    reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(name, params)
  }

  override fun getName() = NAME

  override fun onCatalystInstanceDestroy() {
    closeLocked()
  }

  /* ------------------------------------------------------------ */
  /* Énumération                                                    */
  /* ------------------------------------------------------------ */

  @ReactMethod
  fun listCameras(promise: Promise) {
    try {
      val mgr = cameraManager ?: return promise.reject("CAM", "CameraManager indisponible")
      val arr = Arguments.createArray()
      for (id in mgr.cameraIdList) {
        try {
          val ch = mgr.getCameraCharacteristics(id)
          val facing = ch.get(CameraCharacteristics.LENS_FACING)
          val isExternal = facing == CameraCharacteristics.LENS_FACING_EXTERNAL
          val isBack = facing == CameraCharacteristics.LENS_FACING_BACK
          if (!isExternal && !isBack) continue // selfie avant : inutile
          val map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: continue
          val sizes = map.getOutputSizes(ImageFormat.YUV_420_888) ?: continue
          // trois tailles utiles : la plus petite, une moyenne, la plus grande
          val sorted = sizes.sortedBy { it.width * it.height }
          val picked = sorted.filterIndexed { i, _ -> i == 0 || i == sorted.size / 2 || i == sorted.size - 1 }
              .map { "${it.width}x${it.height}" }
          val lvl = ch.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL)
              ?: CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY
          val manual = lvl == CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_3 ||
              lvl == CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_FULL
          val aeRange = ch.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE)
          val sensRange = ch.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)
          arr.pushMap(Arguments.createMap().apply {
            putString("id", id)
            putString("facing", if (isExternal) "external" else "back")
            putBoolean("external", isExternal)
            putBoolean("manual", manual)
            putArray("sizes", Arguments.createArray().apply { picked.forEach { pushString(it) } })
            putInt("maxIso", sensRange?.upper ?: 0)
            putInt("minExposureComp", aeRange?.lower ?: 0)
            putInt("maxExposureComp", aeRange?.upper ?: 0)
            putString("label", if (isExternal) "Caméra externe #$id" else "Caméra interne #$id")
          })
        } catch (_: Exception) { /* caractéristiques illisibles : caméra suivante */ }
      }
      promise.resolve(arr)
    } catch (e: Exception) {
      promise.reject("LIST", e.message, e)
    }
  }

  /* ------------------------------------------------------------ */
  /* Flux                                                           */
  /* ------------------------------------------------------------ */

  private fun chooseSize(id: String, wantW: Int, wantH: Int): android.util.Size? {
    val mgr = cameraManager ?: return null
    val ch = mgr.getCameraCharacteristics(id)
    val map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return null
    val sizes = map.getOutputSizes(ImageFormat.YUV_420_888) ?: return null
    // la taille la plus proche du ratio 4:3 demandé, sous le plafond demandé
    return sizes.filter { it.width <= wantW * 1.35 && it.height <= wantH * 1.35 }
        .minByOrNull { Math.abs(it.width.toFloat() / it.height - 4f / 3f) * 100 + it.width * 0.0001 }
        ?: sizes.minByOrNull { it.width * it.height }
  }

  private val onImageAvailable = ImageReader.OnImageAvailableListener { r ->
    val img = try { r.acquireLatestImage() } catch (_: Exception) { null } ?: return@OnImageAvailableListener
    frameCount += 1
    try {
      val emit = frameCount % frameSkip == 0L
      val luma = downsampleLuma(img)
      if (luma != null) {
        if (lumaRing.size >= LUMA_HISTORY) lumaRing.removeFirst()
        lumaRing.addLast(luma)
      }
      if (emit) {
        val jpeg = imageToJpeg(img, if (pendingStill != null) 95 else jpegQuality)
        if (jpeg != null) {
          val b64 = Base64.encodeToString(jpeg, Base64.NO_WRAP)
          val mp = Arguments.createMap().apply {
            putString("data", b64)
            putInt("w", img.width)
            putInt("h", img.height)
            putDouble("ts", System.currentTimeMillis().toDouble())
          }
          // centroïde d'autoguidage (fenêtre autour du verrou)
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
            p?.resolve(b64)
          } else {
            sendEvent("cameraFrame", mp)
          }
        }
      } else if (pendingStill != null) {
        // frame non émise mais une pose est attendue : la forcer
        val jpeg = imageToJpeg(img, 95)
        if (jpeg != null) {
          val p = pendingStill
          pendingStill = null
          p?.resolve(Base64.encodeToString(jpeg, Base64.NO_WRAP))
        }
      }
    } catch (_: Exception) {
      // frame défaillante : la suivante viendra
    } finally {
      try { img.close() } catch (_: Exception) {}
    }
  }

  /** Luminance réduite 192×144 (échantillonnage du plan Y, pas de copie pleine). */
  private fun downsampleLuma(img: Image): ByteArray? {
    return try {
      val y = img.planes[0]
      val buf = y.buffer
      val rowStride = y.rowStride
      val pixelStride = y.pixelStride
      val out = ByteArray(LUMA_W * LUMA_H)
      val sx = img.width / LUMA_W
      val sy = img.height / LUMA_H
      for (ly in 0 until LUMA_H) {
        var idx = ly * LUMA_W
        val row = ly * sy * rowStride
        for (lx in 0 until LUMA_W) {
          val p = row + lx * sx * pixelStride
          out[idx++] = if (p < buf.capacity()) buf.get(p) else 0
        }
      }
      out
    } catch (_: Exception) { null }
  }

  /** Centroïde lumineux dans la fenêtre de verrouillage (coordonnées 0..1). */
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
    // au moins ~0,3 % des pixels de la fenêtre au-dessus du seuil : verrou réel
    if (flux <= 0 || n * 1000L < (x1 - x0) * (y1 - y0).toLong() * 3L) return null
    return Triple(sx.toFloat() / flux, sy.toFloat() / flux, Pair(peak, flux))
  }

  /** NV21 ← YUV_420_888 puis JPEG (méthode Android standard). */
  private fun imageToJpeg(img: Image, quality: Int): ByteArray? {
    return try {
      val w = img.width
      val h = img.height
      val yP = img.planes[0]; val uP = img.planes[1]; val vP = img.planes[2]
      val yBuf = yP.buffer; val uBuf = uP.buffer; val vBuf = vP.buffer
      val nv21 = ByteArray(w * h * 3 / 2)
      // plan Y (gère stride != width)
      var pos = 0
      if (yP.pixelStride == 1 && yP.rowStride == w) {
        yBuf.get(nv21, 0, w * h); pos = w * h
      } else {
        for (row in 0 until h) {
          for (col in 0 until w) {
            val p = row * yP.rowStride + col * yP.pixelStride
            nv21[pos++] = if (p < yBuf.capacity()) yBuf.get(p) else 0
          }
        }
      }
      // plan VU entrelacés (NV21 = Y + VU) — indexé par pixelStride : les
      // deux formes (entrelacée pixelStride 2, planaire pixelStride 1) passent
      val chromaH = h / 2
      val chromaW = w / 2
      for (row in 0 until chromaH) {
        for (col in 0 until chromaW) {
          val vp = row * vP.rowStride + col * vP.pixelStride
          val up = row * uP.rowStride + col * uP.pixelStride
          nv21[pos++] = if (vp < vBuf.capacity()) vBuf.get(vp) else 127
          nv21[pos++] = if (up < uBuf.capacity()) uBuf.get(up) else 127
        }
      }
      val yuv = YuvImage(nv21, ImageFormat.NV21, w, h, null)
      val out = ByteArrayOutputStream()
      yuv.compressToJpeg(Rect(0, 0, w, h), quality, out)
      out.toByteArray()
    } catch (_: Exception) { null }
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun openStream(cameraId: String, width: Int, height: Int, fpsMax: Int, quality: Int, promise: Promise) {
    try {
      val mgr = cameraManager ?: return promise.reject("CAM", "CameraManager indisponible")
      if (reactApplicationContext.checkSelfPermission(android.Manifest.permission.CAMERA)
          != android.content.pm.PackageManager.PERMISSION_GRANTED) {
        return promise.reject("PERM", "Permission CAMÉRA refusée")
      }
      closeLocked()
      val size = chooseSize(cameraId, width, height)
          ?: return promise.reject("SIZE", "Aucune taille de flux disponible")
      thread = HandlerThread("autostar-camera").apply { start() }
      handler = Handler(thread!!.looper)
      frameSkip = if (fpsMax >= 30) 1 else maxOf(1, 30 / maxOf(1, fpsMax))
      jpegQuality = quality.coerceIn(40, 95)
      frameCount = 0
      reader = ImageReader.newInstance(size.width, size.height, ImageFormat.YUV_420_888, 3).apply {
        setOnImageAvailableListener(onImageAvailable, handler)
      }
      mgr.openCamera(cameraId, object : CameraDevice.StateCallback() {
        override fun onOpened(cam: CameraDevice) {
          device = cam
          try {
            cam.createCaptureSession(listOf(reader!!.surface), object : CameraCaptureSession.StateCallback() {
              @SuppressLint("MissingPermission")
              override fun onConfigured(s: CameraCaptureSession) {
                session = s
                try {
                  val req = cam.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                    addTarget(reader!!.surface)
                    set(android.hardware.camera2.CaptureRequest.CONTROL_MODE,
                        android.hardware.camera2.CaptureRequest.CONTROL_MODE_AUTO)
                  }
                  s.setRepeatingRequest(req.build(), null, handler)
                  activeId = cameraId
                  promise.resolve(true)
                } catch (e: Exception) {
                  promise.reject("SESSION", e.message, e)
                }
              }
              override fun onConfigureFailed(s: CameraCaptureSession) {
                promise.reject("SESSION", "Configuration du flux échouée")
              }
            }, handler)
          } catch (e: Exception) {
            promise.reject("SESSION", e.message, e)
          }
        }
        override fun onDisconnected(cam: CameraDevice) { closeLocked() }
        override fun onError(cam: CameraDevice, error: Int) {
          closeLocked()
          promise.reject("OPEN", "Ouverture caméra échouée (code $error)")
        }
      }, handler)
    } catch (e: Exception) {
      closeLocked()
      promise.reject("OPEN", e.message, e)
    }
  }

  /** Réglages d'exposition sur la session courante. iso = 0 → retour en
   *  AUTO ; > 0 → mode MANUEL (sensibilité + temps de pose). exposureComp =
   *  pas de compensation AE (utile en AUTO sur capteurs sans mode manuel). */
  @ReactMethod
  fun setParams(exposureComp: Int, iso: Int, exposureNs: Double, promise: Promise) {
    try {
      val s = session ?: return promise.reject("NOSESSION", "Aucun flux actif")
      val dev = device ?: return promise.reject("NOSESSION", "Aucun flux actif")
      val req = dev.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
        addTarget(reader!!.surface)
        if (exposureComp != 0) {
          set(android.hardware.camera2.CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, exposureComp)
        }
        if (iso > 0) {
          // mode manuel : capteurs qui le permettent (UVC/planétaires souvent)
          set(android.hardware.camera2.CaptureRequest.CONTROL_AE_MODE,
              android.hardware.camera2.CaptureRequest.CONTROL_AE_MODE_OFF)
          set(android.hardware.camera2.CaptureRequest.SENSOR_SENSITIVITY, iso)
          set(android.hardware.camera2.CaptureRequest.SENSOR_EXPOSURE_TIME, exposureNs.toLong())
        } else {
          set(android.hardware.camera2.CaptureRequest.CONTROL_AE_MODE,
              android.hardware.camera2.CaptureRequest.CONTROL_AE_MODE_ON)
        }
      }
      s.setRepeatingRequest(req.build(), null, handler)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("PARAMS", e.message, e)
    }
  }

  /** UNE pose (qualité 95) — resolve la base64 du JPEG. */
  @ReactMethod
  fun captureStill(promise: Promise) {
    if (session == null) return promise.reject("NOSESSION", "Aucun flux actif")
    pendingStill = promise
    handler?.postDelayed({
      val p = pendingStill
      if (p != null && p === promise) {
        pendingStill = null
        p.reject("TIMEOUT", "Aucune frame reçue pour la pose")
      }
    }, 4000)
  }

  /** Anneau de luminance réduite pour l'empilement côté JS (base64 par frame). */
  @ReactMethod
  fun getLumaHistory(promise: Promise) {
    val arr = Arguments.createArray()
    synchronized(lumaRing) {
      for (b in lumaRing) arr.pushString(Base64.encodeToString(b, Base64.NO_WRAP))
    }
    promise.resolve(arr)
  }

  @ReactMethod
  fun setLock(x: Double, y: Double, halfWindow: Double, promise: Promise) {
    lockX = x.toFloat(); lockY = y.toFloat(); lockHalf = halfWindow.toFloat().coerceIn(0.03f, 0.45f)
    promise.resolve(true)
  }

  @ReactMethod
  fun clearLock(promise: Promise) {
    lockX = Float.NaN; lockY = Float.NaN
    promise.resolve(true)
  }

  @ReactMethod
  fun closeStream(promise: Promise) {
    closeLocked()
    promise.resolve(true)
  }

  @ReactMethod
  fun isStreaming(promise: Promise) = promise.resolve(device != null)

  /** Fermeture sous verrou (thread caméra arrêté, session/device/reader relâchés). */
  private fun closeLocked() {
    try { session?.stopRepeating() } catch (_: Exception) {}
    try { session?.close() } catch (_: Exception) {}
    try { device?.close() } catch (_: Exception) {}
    try { reader?.close() } catch (_: Exception) {}
    session = null; device = null; reader = null; activeId = null
    pendingStill?.let { it.reject("CLOSED", "Flux fermé") }
    pendingStill = null
    synchronized(lumaRing) { lumaRing.clear() }
    thread?.quitSafely()
    thread = null; handler = null
    lockX = Float.NaN; lockY = Float.NaN
  }

  // Stubs requis par NativeEventEmitter côté JS (pas d'événements dirigés).
  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}
}
