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
      sendEvent("sensorsOrientation", Arguments.createMap().apply {
        putDouble("azimuthDeg", az)
        putDouble("pitchDeg", pitch)
        putDouble("rollDeg", roll)
        putDouble("accuracy", event.accuracy.toDouble())
        putDouble("ts", now.toDouble())
      })
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
  }

  override fun getName() = NAME

  override fun onCatalystInstanceDestroy() {
    stopListening()
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
}
