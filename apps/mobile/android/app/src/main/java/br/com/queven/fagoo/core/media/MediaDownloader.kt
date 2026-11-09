package br.com.queven.fagoo.core.media

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import br.com.queven.fagoo.core.AppContainer
import br.com.queven.fagoo.core.model.MediaFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.io.File
import java.io.IOException

/**
 * Baixa anexos privados para o cache do app (com Authorization) e os abre/compartilha
 * por FileProvider (authority "${applicationId}.files", caminho cache-path do manifest).
 */
class MediaDownloader(private val container: AppContainer) {
    private val context: Context get() = container.appContext

    /** Baixa (ou reaproveita do cache) o arquivo e devolve o File local. */
    suspend fun download(profileId: String, media: MediaFile, onProgress: ((Int) -> Unit)? = null): File = withContext(Dispatchers.IO) {
        val generation=container.generation
        val dir = File(context.cacheDir, "media/${safe(media.id)}").apply { mkdirs() }
        val target = File(dir, safe(media.name.ifBlank { media.id }))
        // Always reauthorize before reading an attachment; an assignment may have changed.
        val request = Request.Builder().url(AuthenticatedMedia.url(container, profileId, media.id, inline = false)).build()
        container.okHttp.newCall(request).execute().use { response ->
            val body = response.body ?: throw IOException("O servidor não devolveu o arquivo.")
            val total = if (media.size > 0) media.size else body.contentLength()
            val partial = File(dir, target.name + ".part")
            partial.outputStream().use { out ->
                body.byteStream().use { input ->
                    val buffer = ByteArray(64 * 1024)
                    var copied = 0L
                    while (true) {
                        if(generation!=container.generation || !container.auth.value.isLoggedIn) throw IOException("Sessão alterada")
                        val n = input.read(buffer)
                        if (n < 0) break
                        out.write(buffer, 0, n)
                        copied += n
                        if (onProgress != null && total > 0) onProgress(((copied * 100) / total).toInt().coerceIn(0, 100))
                    }
                }
            }
            if(generation!=container.generation || !container.auth.value.isLoggedIn) { partial.delete(); throw IOException("Sessão alterada") }
            if (target.exists()) target.delete()
            if (!partial.renameTo(target)) {
                partial.copyTo(target, overwrite = true)
                partial.delete()
            }
        }
        target
    }

    fun shareUri(file: File): Uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)

    /** Abre o arquivo em outro aplicativo. Devolve false quando nenhum app consegue abri-lo. */
    fun open(activity: Context, file: File, mime: String): Boolean {
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(shareUri(file), MediaKinds.baseMime(mime).ifBlank { "*/*" })
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return try {
            activity.startActivity(intent)
            true
        } catch (e: ActivityNotFoundException) {
            false
        }
    }

    fun share(activity: Context, file: File, mime: String, title: String = "Compartilhar"): Boolean {
        val intent = Intent(Intent.ACTION_SEND)
            .setType(MediaKinds.baseMime(mime).ifBlank { "*/*" })
            .putExtra(Intent.EXTRA_STREAM, shareUri(file))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return try {
            activity.startActivity(Intent.createChooser(intent, title))
            true
        } catch (e: ActivityNotFoundException) {
            false
        }
    }

    private fun safe(name: String): String {
        val cleaned = name.replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1f]"), "_").trim().take(120)
        return cleaned.ifBlank { "arquivo" }
    }
}
