package com.autostardroid.sensors

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Module natif capteurs d'attitude pour Android (React Native).
 *
 * Expose l'orientation fusionnée du téléphone (boussole + accéléromètre +
 * gyroscope) via le capteur virtuel TYPE_ROTATION_VECTOR d'Android, qui
 * fusionne déjà les trois capteurs physiques avec un filtre de Kalman.
 *
 * Conventions (identiques à SensorManager.getOrientation) :
 *  - azimuthDeg : 0° = nord magnétique, 90° = est, 180° = sud (cap du bord
 *    supérieur du téléphone, écran vers le ciel).
 *  - pitchDeg   : inclinaison du bord supérieur autour de l'axe X
 *    (positif = bord supérieur remonté vers le ciel).
 *  - rollDeg    : roulis autour de l'axe Y (positif = bord droit baissé).
 *
 * Usage mise en station :
 *  - téléphone à plat sur la base  -> niveau à bulle (pitch/roll = 0)
 *  - téléphone calé le long de l'axe horaire -> pitch = latitude du site,
 *    azimuth = 0° (nord) pour une monture équatoriale bien en station.
 */
class SensorsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "NativeSensors"
  }

  private val sensorManager: SensorManager?
    get() = reactApplicationContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager

  private var listening = false
  private var intervalMs = 100L
  private var lastEmit = 0L
  private val rotMatrix = FloatArray(9)
  private val ori = FloatArray(3)

  // --- Gyroscope brut (v2.0.0) : taux angulaires instantanés (rad/s),
  //     SANS le lissage du filtre de Kalman du rotation vector. Indispensable
  //     au calibrage moteurs (mesure des taux réels, détection du backlash :
  //     il faut voir le démarrage du mouvement, pas une moyenne lissée).
  private var gyroListening = false
  private var gyroIntervalMs = 50L
  private var gyroLastEmit = 0L

  private val listener = object : SensorEventListener {
    override fun onSensorChanged(event: SensorEvent) {
      if (event.sensor.type != Sensor.TYPE_ROTATION_VECTOR) return
      val now = System.currentTimeMillis()
      if (now - lastEmit < intervalMs) return
      lastEmit = now
      try {
        SensorManager.getRotationMatrixFromVector(rotMatrix, event.values)
        SensorManager.getOrientation(rotMatrix, ori)
      } catch (_: Exception) {
        return
      }
      val az = (Math.toDegrees(ori[0].toDouble()) + 360.0) % 360.0
      val pitch = Math.toDegrees(ori[1].toDouble())
      val roll = Math.toDegrees(ori[2].toDouble())
      // Quaternion brut du rotation vector (v1.9.0) : [x·sin(θ/2), y·sin(θ/2),
      // z·sin(θ/2), cos(θ/2)]. v_monde = R(q)·v_téléphone (cf. quatToMat JS).
      // Sans 4ᵉ composante (vieux capteurs) : cos(θ/2) = √(1 − ‖v‖²).
      val v = event.values
      val vx = v[0].toDouble(); val vy = v[1].toDouble(); val vz = v[2].toDouble()
      val sinHalf2 = vx * vx + vy * vy + vz * vz
      val qw = if (v.size >= 4) v[3].toDouble()
               else Math.sqrt(Math.max(0.0, 1.0 - sinHalf2))
      sendEvent("sensorsOrientation", Arguments.createMap().apply {
        putDouble("azimuthDeg", az)
        putDouble("pitchDeg", pitch)
        putDouble("rollDeg", roll)
        putDouble("qw", qw)
        putDouble("qx", vx)
        putDouble("qy", vy)
        putDouble("qz", vz)
        putDouble("accuracy", event.accuracy.toDouble())
        putDouble("ts", now.toDouble())
      })
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
  }

  private val gyroListener = object : SensorEventListener {
    override fun onSensorChanged(event: SensorEvent) {
      if (event.sensor.type != Sensor.TYPE_GYROSCOPE) return
      val now = System.currentTimeMillis()
      if (now - gyroLastEmit < gyroIntervalMs) return
      gyroLastEmit = now
      val v = event.values
      sendEvent("sensorsGyro", Arguments.createMap().apply {
        putDouble("x", v[0].toDouble())
        putDouble("y", v[1].toDouble())
        putDouble("z", v[2].toDouble())
        putDouble("accuracy", event.accuracy.toDouble())
        putDouble("ts", now.toDouble())
      })
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
  }

  override fun getName() = NAME

  override fun onCatalystInstanceDestroy() {
    stopListening()
    stopGyroListening()
  }

  private fun sendEvent(name: String, params: WritableMap) {
    reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(name, params)
  }

  /** Liste les capteurs disponibles (pour afficher un diagnostic côté JS). */
  @ReactMethod
  fun isAvailable(promise: Promise) {
    try {
      val sm = sensorManager
      val map = Arguments.createMap()
      map.putBoolean("rotationVector", sm?.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR) != null)
      map.putBoolean("accelerometer", sm?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null)
      map.putBoolean("magnetometer", sm?.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD) != null)
      map.putBoolean("gyroscope", sm?.getDefaultSensor(Sensor.TYPE_GYROSCOPE) != null)
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("SENSORS", e)
    }
  }

  /**
   * Démarre le flux d'orientation à la fréquence demandée (min ~33 ms).
   * Les événements arrivent sur le canal JS « sensorsOrientation ».
   */
  @ReactMethod
  fun startOrientation(intervalMs: Double, promise: Promise) {
    try {
      val sm = sensorManager
      val rv = sm?.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
      if (sm == null || rv == null) {
        promise.reject("NO_SENSOR", "Rotation vector sensor unavailable")
        return
      }
      stopListening()
      this.intervalMs = intervalMs.toLong().coerceAtLeast(33L)
      listening = true
      sm.registerListener(listener, rv, SensorManager.SENSOR_DELAY_GAME)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("SENSORS", e)
    }
  }

  @ReactMethod
  fun stopOrientation(promise: Promise) {
    stopListening()
    promise.resolve(true)
  }

  private fun stopListening() {
    if (!listening) return
    try {
      sensorManager?.unregisterListener(listener)
    } catch (_: Exception) {}
    listening = false
  }

  /**
   * Démarre le flux GYROSCOPE BRUT à la fréquence demandée (min ~20 ms).
   * Événements « sensorsGyro » : x/y/z en rad/s (convention Android) + ts.
   * Indépendant du flux d'orientation (inscription capteur séparée).
   */
  @ReactMethod
  fun startGyro(intervalMs: Double, promise: Promise) {
    try {
      val sm = sensorManager
      val g = sm?.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
      if (sm == null || g == null) {
        promise.reject("NO_SENSOR", "Gyroscope unavailable")
        return
      }
      stopGyroListening()
      this.gyroIntervalMs = intervalMs.toLong().coerceAtLeast(20L)
      gyroListening = true
      sm.registerListener(gyroListener, g, SensorManager.SENSOR_DELAY_GAME)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("SENSORS", e)
    }
  }

  @ReactMethod
  fun stopGyro(promise: Promise) {
    stopGyroListening()
    promise.resolve(true)
  }

  private fun stopGyroListening() {
    if (!gyroListening) return
    try {
      sensorManager?.unregisterListener(gyroListener)
    } catch (_: Exception) {}
    gyroListening = false
  }
}
