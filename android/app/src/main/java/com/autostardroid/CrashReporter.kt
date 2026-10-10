package com.autostardroid

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Capture les crashs (natifs + exceptions JS fatales qui remontent en JSException)
 * dans un fichier log, pour diagnostic sans adb.
 *
 * Le fichier est écrit dans getExternalFilesDir(null)/crash.log (partagé au
 * lancement suivant — voir MainActivity.offerCrashLog). Cet objet ne doit
 * JAMAIS faire planter l'app : tout est protégé par try/catch.
 */
object CrashReporter {
    private const val MAX_LOG_BYTES = 256 * 1024

    fun logFile(context: Context): File {
        val dir = context.getExternalFilesDir(null) ?: context.filesDir
        return File(dir, "crash.log")
    }

    /** Installe le handler global. À appeler en PREMIER dans Application.onCreate. */
    fun install(context: Context) {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                append(context, describe(context, "UNCAUGHT", thread?.name ?: "?", throwable))
            } catch (_: Throwable) {
            }
            try {
                previous?.uncaughtException(thread, throwable)
            } catch (_: Throwable) {
            }
        }
    }

    /** Ajoute une entrée au log (truncation si > 256 Ko). */
    fun append(context: Context, text: String) {
        try {
            val f = logFile(context)
            if (f.length() > MAX_LOG_BYTES) {
                f.writeText("--- log tronqué ---\n")
            }
            f.appendText(text)
        } catch (_: Throwable) {
        }
    }

    fun describe(context: Context, kind: String, thread: String, t: Throwable): String {
        val sw = StringWriter()
        t.printStackTrace(PrintWriter(sw))
        val sb = StringBuilder()
        sb.append("==== CRASH ")
            .append(SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date()))
            .append(" ====\n")
        sb.append("Kind   : ").append(kind).append('\n')
        sb.append("Thread : ").append(thread).append('\n')
        sb.append("Device : ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
            .append(" - Android ").append(Build.VERSION.RELEASE)
            .append(" (API ").append(Build.VERSION.SDK_INT).append(")\n")
        sb.append("ABI    : ").append(Build.SUPPORTED_ABIS.joinToString(", ")).append('\n')
        try {
            val pm = context.packageManager.getPackageInfo(context.packageName, 0)
            sb.append("Version: ").append(pm.versionName)
                .append(" (").append(pm.longVersionCode).append(")\n")
        } catch (_: Throwable) {
        }
        sb.append(sw.toString()).append('\n')
        return sb.toString()
    }

    /** Log de crash en attente de partage, ou null. */
    fun pendingLog(context: Context): File? {
        val f = logFile(context)
        return if (f.exists() && f.length() > 0L) f else null
    }

    fun clear(context: Context) {
        try {
            logFile(context).delete()
        } catch (_: Throwable) {
        }
    }

    /**
     * Copie le log de crash dans Téléchargements (MediaStore) — visible dans
     * l'app Fichiers du téléphone, sans permission, sans feuille de partage.
     * C'est la voie de secours fiable si le partage échoue. Retourne l'Uri ou null.
     */
    fun exportToDownloads(context: Context): Uri? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        return try {
            val src = logFile(context)
            if (!src.exists() || src.length() == 0L) return null
            val resolver = context.contentResolver
            val name = "autostardroid-crash.log"
            // Supprime la copie précédente pour ne pas accumuler
            try {
                resolver.delete(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    "${MediaStore.MediaColumns.DISPLAY_NAME}=?",
                    arrayOf(name)
                )
            } catch (_: Throwable) {
            }
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, "text/plain")
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: return null
            resolver.openOutputStream(uri)?.use { out ->
                src.inputStream().use { it.copyTo(out) }
            } ?: return null
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            uri
        } catch (_: Throwable) {
            null
        }
    }
}
