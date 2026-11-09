package br.com.queven.fagoo.core.media

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import br.com.queven.fagoo.core.AppContainer
import br.com.queven.fagoo.core.model.UploadInit
import br.com.queven.fagoo.core.net.ApiClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.util.Locale

/** Origem dos bytes de um anexo escolhido pela pessoa. */
sealed class UploadSource {
    abstract fun open(context: Context): InputStream
    abstract fun localUri(): Uri

    data class UriSource(val uri: Uri) : UploadSource() {
        override fun open(context: Context): InputStream =
            context.contentResolver.openInputStream(uri) ?: throw IOException("Não foi possível ler o arquivo selecionado.")
        override fun localUri(): Uri = uri
    }

    data class FileSource(val file: File) : UploadSource() {
        override fun open(context: Context): InputStream = FileInputStream(file)
        override fun localUri(): Uri = Uri.fromFile(file)
    }
}

/** Arquivo pronto para subir: nome, tipo MIME, tamanho em bytes e origem. */
data class UploadItem(val name: String, val mime: String, val size: Long, val source: UploadSource)

/**
 * Upload em partes (docs/API.md "Arquivos e mensagens nativas"):
 * POST /media/uploads → PUT parts/{n} (Idempotency-Key "{uploadId}:{n}") → POST complete; abort em caso de falha.
 */
class MediaUploader(private val container: AppContainer) {
    private val octetStream = "application/octet-stream".toMediaType()

    /** Sobe o arquivo e devolve o ID de mídia para usar em `attachments`. [onProgress] recebe 0..100. */
    suspend fun upload(profileId: String, item: UploadItem, onProgress: (Int) -> Unit): String {
        if (item.size <= 0) throw IOException("Arquivo vazio ou de tamanho desconhecido.")
        if (item.size > MediaKinds.MAX_UPLOAD_BYTES) throw IOException("Cada arquivo pode ter até 100 MB.")
        val api = container.api
        val created = api.uploadCreate(
            profileId,
            ApiClient.newIdempotencyKey(),
            UploadInit(name = item.name.take(200), type = item.mime, size = item.size),
        )
        try {
            val partSize = created.part_size.toInt()
            withContext(Dispatchers.IO) {
                item.source.open(container.appContext).use { input ->
                    val buffer = ByteArray(partSize)
                    for (part in 1..created.parts) {
                        val expected = minOf(created.part_size, item.size - (part - 1).toLong() * created.part_size).toInt()
                        var read = 0
                        while (read < expected) {
                            val n = input.read(buffer, read, expected - read)
                            if (n < 0) throw IOException("O arquivo terminou antes do tamanho informado.")
                            read += n
                        }
                        val body = buffer.toRequestBody(octetStream, 0, expected)
                        api.uploadPart(profileId, created.id, part, "${created.id}:$part", body)
                        onProgress((part * 100) / created.parts)
                    }
                }
            }
            return api.uploadComplete(profileId, created.id, ApiClient.newIdempotencyKey()).id
        } catch (e: Throwable) {
            // Falha ou cancelamento: libera o envio aberto no servidor (limite de 5 por pessoa).
            withContext(NonCancellable) {
                runCatching { api.uploadAbort(profileId, created.id, ApiClient.newIdempotencyKey()) }
            }
            throw e
        }
    }

    companion object {
        /** Lê nome, tamanho e tipo de um Uri devolvido pelos seletores do sistema. */
        fun readUploadItem(context: Context, uri: Uri): UploadItem? {
            val resolver = context.contentResolver
            var name: String? = null
            var size = -1L
            runCatching {
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
                        val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                        if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
                    }
                }
            }
            if (size <= 0) {
                size = runCatching { resolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L }.getOrDefault(-1L)
            }
            if (size <= 0) {
                size = runCatching {
                    resolver.openInputStream(uri)?.use { stream ->
                        val chunk = ByteArray(64 * 1024)
                        var total = 0L
                        while (true) {
                            val n = stream.read(chunk)
                            if (n < 0) break
                            total += n
                        }
                        total
                    } ?: -1L
                }.getOrDefault(-1L)
            }
            if (size <= 0) return null
            val fallbackName = uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "arquivo"
            var finalName = name?.takeIf { it.isNotBlank() } ?: fallbackName
            val extension = finalName.substringAfterLast('.', "").lowercase(Locale.ROOT)
            val mime = resolver.getType(uri)
                ?: extension.takeIf { it.isNotEmpty() }?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }
                ?: "application/octet-stream"
            if (extension.isEmpty()) {
                val ext = MediaKinds.extensionFor(mime) ?: MimeTypeMap.getSingleton().getExtensionFromMimeType(MediaKinds.baseMime(mime))
                if (ext != null) finalName = "$finalName.$ext"
            }
            return UploadItem(name = finalName.take(200), mime = mime, size = size, source = UploadSource.UriSource(uri))
        }
    }
}
