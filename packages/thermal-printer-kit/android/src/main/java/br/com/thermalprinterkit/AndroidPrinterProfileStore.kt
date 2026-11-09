package br.com.thermalprinterkit

import android.content.Context
import android.util.Base64

// Separado de `PrinterProfileStore.kt` porque o FORMATO do store é núcleo e a PERSISTÊNCIA é
// plataforma. `BinaryPrinterProfileStore` grava o formato binário fechado e não conhece Android;
// só as duas classes abaixo precisam de `Context` e do Base64 da plataforma. Enquanto as três
// moravam no mesmo arquivo, a JVM de mesa não conseguia levar o formato sem arrastar o SDK — e
// duplicar o formato faria Windows e Android divergirem no disco. Nada foi renomeado nem teve a
// visibilidade mexida: é a mesma declaração, no mesmo pacote e no mesmo módulo.

/** Persistência Android neutra; nenhum alias ou namespace de app consumidor aparece aqui. */
class AndroidPreferencesPrinterProfileStorage(context: Context) : PrinterProfileStorage {
    private val preferences =
        context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    override fun read(): ByteArray? =
        preferences.getString(KEY_PROFILES, null)?.let { encoded ->
            runCatching { Base64.decode(encoded, Base64.NO_WRAP) }.getOrNull()
        }

    override fun write(value: ByteArray) {
        val encoded = Base64.encodeToString(value, Base64.NO_WRAP)
        check(preferences.edit().putString(KEY_PROFILES, encoded).commit()) {
            "Não foi possível preservar os perfis medidos."
        }
    }

    override fun clear() {
        check(preferences.edit().remove(KEY_PROFILES).commit()) {
            "Não foi possível remover os perfis medidos."
        }
    }

    private companion object {
        const val PREFERENCES_NAME = "thermal_printer_kit_profiles"
        const val KEY_PROFILES = "measured_profiles"
    }
}

class AndroidPrinterProfileStore(context: Context) : PrinterProfileStore by
    BinaryPrinterProfileStore(AndroidPreferencesPrinterProfileStorage(context))
