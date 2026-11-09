package br.com.queven.fagoo.core.media

import java.util.Locale

/**
 * Classificação de mídia igual à do servidor (src/media.ts `mediaKind`) e limites por canal
 * (docs/WHATSAPP.md, src/whatsapp.ts `validateMedia`). A conferência local evita um upload
 * de vários MB que o servidor recusaria no fim; a validação definitiva continua no servidor.
 */
object MediaKinds {
    const val MAX_UPLOAD_BYTES: Long = 100L * 1024 * 1024
    const val MAX_ATTACHMENTS = 10
    const val MAX_TEXT = 3800

    fun baseMime(mime: String): String = mime.substringBefore(';').trim().lowercase(Locale.ROOT)

    /** image | video | audio | document | sticker, como o servidor infere para `content.type == text`. */
    fun kindOf(mime: String): String {
        val m = baseMime(mime)
        return when {
            m == "image/webp" -> "sticker"
            m.startsWith("image/") -> "image"
            m.startsWith("video/") -> "video"
            m.startsWith("audio/") -> "audio"
            else -> "document"
        }
    }

    fun label(kind: String): String = when (kind) {
        "image" -> "imagem"
        "video" -> "vídeo"
        "audio" -> "áudio"
        "voice" -> "mensagem de voz"
        "document" -> "documento"
        "sticker" -> "figurinha"
        "location" -> "localização"
        "contacts" -> "cartão de contato"
        "reply" -> "citação"
        "reaction" -> "reação"
        "mentions" -> "menção"
        "edit" -> "edição"
        "delete" -> "exclusão"
        "read" -> "marcar como lida"
        "calls" -> "ligação"
        else -> kind
    }

    private val metaLimitsMb = mapOf("image" to 5, "video" to 16, "audio" to 16, "voice" to 16, "document" to 100)
    private val qrLimitsMb = mapOf("image" to 20, "video" to 100, "audio" to 100, "voice" to 16, "document" to 100, "sticker" to 1)
    private val metaFormats = mapOf(
        "image" to listOf("image/jpeg", "image/png"),
        "video" to listOf("video/mp4", "video/3gpp"),
        "audio" to listOf("audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg"),
        "voice" to listOf("audio/ogg"),
        "sticker" to listOf("image/webp"),
        "document" to listOf(
            "text/plain",
            "application/pdf",
            "application/msword",
            "application/vnd.ms-excel",
            "application/vnd.ms-powerpoint",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ),
    )

    /**
     * Devolve uma mensagem de erro em pt-BR ou null quando o arquivo passa nos limites.
     * [metaChannel] aplica os limites mais estritos da Meta (imagem 5 MB, vídeo/áudio 16 MB, formatos fixos).
     */
    fun checkLimit(kind: String, mime: String, size: Long, metaChannel: Boolean): String? {
        if (size <= 0) return "Arquivo vazio ou de tamanho desconhecido."
        if (size > MAX_UPLOAD_BYTES) return "Cada arquivo pode ter até 100 MB. Este tem ${formatSize(size)}."
        val m = baseMime(mime)
        if (kind == "sticker" && metaChannel) {
            if (size > 500L * 1024) return "Na Meta, figurinha pode ter até 500 KB. Esta tem ${formatSize(size)}."
        } else {
            val limitMb = (if (metaChannel) metaLimitsMb else qrLimitsMb)[kind] ?: 100
            if (size > limitMb.toLong() * 1024 * 1024) {
                val channel = if (metaChannel) "da Meta" else "deste canal"
                return "O limite $channel para ${label(kind)} é $limitMb MB. Este arquivo tem ${formatSize(size)}."
            }
        }
        if (kind == "voice" && m != "audio/ogg") return "Mensagem de voz exige OGG/Opus. Grave pelo aplicativo ou envie como áudio."
        if (kind == "sticker" && m != "image/webp") return "Figurinha exige imagem WebP."
        if (kind in setOf("image", "audio", "video") && !m.startsWith("$kind/")) {
            return "O tipo do arquivo ($m) não corresponde a ${label(kind)}. Use \"Enviar como documento\"."
        }
        if (metaChannel) {
            val allowed = metaFormats[kind]
            if (allowed != null && m !in allowed) {
                return "Formato não aceito pela Meta ($m). Use JPG/PNG, MP4 (H.264/AAC), áudio MP3/M4A/OGG, documento PDF/TXT/Office ou envie como documento."
            }
        }
        return null
    }

    fun formatSize(bytes: Long): String = when {
        bytes < 1024 -> "$bytes B"
        bytes < 1024 * 1024 -> String.format(Locale.getDefault(), "%.0f KB", bytes / 1024.0)
        else -> String.format(Locale.getDefault(), "%.1f MB", bytes / (1024.0 * 1024.0))
    }

    fun extensionFor(mime: String): String? = when (baseMime(mime)) {
        "image/jpeg" -> "jpg"
        "image/png" -> "png"
        "image/webp" -> "webp"
        "image/gif" -> "gif"
        "video/mp4" -> "mp4"
        "video/3gpp" -> "3gp"
        "audio/ogg" -> "ogg"
        "audio/mp4" -> "m4a"
        "audio/mpeg" -> "mp3"
        "audio/aac" -> "aac"
        "application/pdf" -> "pdf"
        "text/plain" -> "txt"
        else -> null
    }
}
