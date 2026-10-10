package com.autostardroid

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.core.content.FileProvider
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  override fun getMainComponentName(): String = "AutoStarDroid"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, false)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    offerCrashLog()
  }

  /**
   * Si un crash a été capturé au lancement précédent :
   * 1) copie fiable dans Téléchargements (MediaStore, visible dans l'app Fichiers) ;
   * 2) propose en plus le partage direct (email, messagerie…).
   * Le fichier local est retiré après coup (la copie Téléchargements subsiste).
   */
  private fun offerCrashLog() {
    try {
      val file = CrashReporter.pendingLog(this) ?: return
      val exported = CrashReporter.exportToDownloads(this)
      if (exported != null) {
        android.widget.Toast.makeText(
            this, getString(R.string.crash_saved_downloads),
            android.widget.Toast.LENGTH_LONG).show()
      }
      try {
        val uri: Uri = FileProvider.getUriForFile(
            this, "$packageName.crashfiles", file)
        val send = Intent(Intent.ACTION_SEND).apply {
          type = "text/plain"
          putExtra(Intent.EXTRA_SUBJECT,
              "AutoStar Droid — rapport de crash v${BuildConfig.VERSION_NAME}")
          putExtra(Intent.EXTRA_STREAM, uri)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(send, getString(R.string.share_crash_log)))
      } catch (_: Throwable) {
        // La feuille de partage peut être indisponible : la copie Téléchargements
        // reste la voie de récupération garantie.
      }
      CrashReporter.clear(this)
    } catch (_: Throwable) {
    }
  }
}
