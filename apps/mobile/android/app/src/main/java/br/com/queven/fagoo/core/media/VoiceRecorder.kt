package br.com.queven.fagoo.core.media

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File
import java.io.IOException

/**
 * Gravador de mensagens de voz. Em API 29+ grava OGG/Opus (o único formato aceito como `voice`);
 * abaixo disso grava MPEG-4/AAC, que é enviado como `audio` comum (docs/MOBILE.md, limites conhecidos).
 */
class VoiceRecorder(private val context: Context) {
    val isOpus: Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
    val mime: String get() = if (isOpus) "audio/ogg; codecs=opus" else "audio/mp4"
    /** `voice` (OGG/Opus) ou `audio` (AAC), para `content.type`. */
    val contentType: String get() = if (isOpus) "voice" else "audio"

    var file: File? = null
        private set
    private var recorder: MediaRecorder? = null
    val isRecording: Boolean get() = recorder != null

    @Throws(IOException::class)
    fun start(maxDurationMs: Int = 120_000): File {
        cancel()
        val dir = File(context.cacheDir, "voice").apply { mkdirs() }
        val out = File(dir, "voz-${System.currentTimeMillis()}.${if (isOpus) "ogg" else "m4a"}")
        val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            if (isOpus) {
                r.setOutputFormat(MediaRecorder.OutputFormat.OGG)
                r.setAudioEncoder(MediaRecorder.AudioEncoder.OPUS)
                r.setAudioSamplingRate(48_000)
                r.setAudioEncodingBitRate(24_000)
            } else {
                r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                r.setAudioSamplingRate(44_100)
                r.setAudioEncodingBitRate(64_000)
            }
            r.setAudioChannels(1)
            r.setMaxDuration(maxDurationMs)
            r.setOutputFile(out.absolutePath)
            r.prepare()
            r.start()
        } catch (e: Exception) {
            runCatching { r.release() }
            out.delete()
            throw IOException("Não foi possível iniciar a gravação.", e)
        }
        recorder = r
        file = out
        return out
    }

    /** Para a gravação e devolve o arquivo (null quando a gravação foi curta demais ou falhou). */
    fun stop(): File? {
        val r = recorder ?: return file
        recorder = null
        val out = file
        return try {
            r.stop()
            out?.takeIf { it.exists() && it.length() > 0 }
        } catch (e: RuntimeException) {
            // stop() lança quando não há dados gravados (toque muito rápido).
            out?.delete()
            file = null
            null
        } finally {
            runCatching { r.release() }
        }
    }

    /** Descarta a gravação em andamento (ou o último arquivo gravado). */
    fun cancel() {
        recorder?.let { r ->
            recorder = null
            runCatching { r.stop() }
            runCatching { r.release() }
        }
        file?.delete()
        file = null
    }
}
