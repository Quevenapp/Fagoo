// SPDX-License-Identifier: AGPL-3.0-only
package br.com.queven.fagoo.panel

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale
import java.util.UUID
import kotlin.coroutines.resume

class PanelSpeech(context: Context) {
    private var ready = false
    private var engine: TextToSpeech? = null
    init { engine = TextToSpeech(context.applicationContext) { status -> ready = status == TextToSpeech.SUCCESS; if (ready) engine?.language = Locale.forLanguageTag("pt-BR") } }
    suspend fun say(text: String, volume: Float): Boolean = withContext(Dispatchers.Main) {
        if (!ready) return@withContext false
        withTimeoutOrNull(20000) {
            suspendCancellableCoroutine { continuation ->
                val id = UUID.randomUUID().toString()
                fun finish(ok: Boolean) { if (continuation.isActive) continuation.resume(ok) }
                engine?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) = Unit
                    override fun onDone(utteranceId: String?) { if (utteranceId == id) finish(true) }
                    @Deprecated("TTS compatibility") override fun onError(utteranceId: String?) { if (utteranceId == id) finish(false) }
                })
                continuation.invokeOnCancellation { engine?.stop() }
                val params = Bundle().apply { putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume.coerceIn(0f, 1f)) }
                if (engine?.speak(text, TextToSpeech.QUEUE_FLUSH, params, id) != TextToSpeech.SUCCESS) finish(false)
            }
        } ?: false
    }
    fun stop() { engine?.stop() }
    fun close() { engine?.stop(); engine?.shutdown() }
}
