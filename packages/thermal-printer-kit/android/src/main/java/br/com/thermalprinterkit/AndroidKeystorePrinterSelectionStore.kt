package br.com.thermalprinterkit

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// Mesmo motivo do `AndroidPrinterProfileStore.kt`: o que a instalação GUARDA — o formato, as
// regras de identidade física e a validação de `profileId` — é núcleo, e `PrinterProfileStore`
// depende dessas regras. Só a caixa-forte é plataforma: SharedPreferences, Base64 do Android e o
// AndroidKeyStore. Enquanto as duas coisas moravam no mesmo arquivo, levar o formato para a JVM
// arrastava o Keystore junto. Nada renomeado, nada com visibilidade mexida.
//
// O FORMATO saiu deste arquivo e virou `BinaryPrinterSelectionCodec`, em `PrinterSelectionStore.kt`,
// que atravessa para a JVM de mesa. O que sobrou aqui é a caixa-forte, e só ela: chave do
// AndroidKeyStore, IV, tag, AAD de Android, Base64 e SharedPreferences. A extração é byte a byte —
// os métodos mudaram de casa, não de conteúdo —, e o que prova isso é
// `PrinterSelectionCodecGravadoTest`, cujos literais foram medidos do código publicado ANTES de
// qualquer linha ser movida. Se aquele teste ficar vermelho, alguém quebrou o chaveiro de quem já
// tem impressora adotada.
//
// **O AAD continua morando aqui, e é decisão.** Ele é o separador de domínio desta caixa-forte e não
// do formato: a de mesa tem o dela (`thermal-printer-kit:windows:selection:v1`), e as duas precisam
// diferir para que um texto cifrado de um lado não abra no outro. Compartilhá-lo pelo núcleo
// convidaria exatamente a confusão que dado associado existe para transformar em falha audível.

/** Preserva a instalação confirmada em payload autenticado e criptografado pelo Android Keystore. */
class AndroidKeystorePrinterSelectionStore(context: Context) : PrinterSelectionStore {
    private val preferences =
        context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    @Synchronized
    override fun read(): PersistedPrinterSelections {
        val stored = preferences.getString(KEY_PAYLOAD, null) ?: return PersistedPrinterSelections()
        return runCatching {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            require(bytes.size > IV_SIZE + AUTH_TAG_SIZE)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                key(),
                GCMParameterSpec(AUTH_TAG_BITS, bytes.copyOfRange(0, IV_SIZE)),
            )
            cipher.updateAAD(AAD)
            val plaintext = cipher.doFinal(bytes.copyOfRange(IV_SIZE, bytes.size))
            try {
                BinaryPrinterSelectionCodec.decode(plaintext)
            } finally {
                plaintext.fill(0)
            }
        }.getOrElse {
            preferences.edit().remove(KEY_PAYLOAD).commit()
            PersistedPrinterSelections()
        }
    }

    @Synchronized
    override fun save(selections: PersistedPrinterSelections) {
        val plaintext = BinaryPrinterSelectionCodec.encode(selections)
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key())
            cipher.updateAAD(AAD)
            val encoded = Base64.encodeToString(cipher.iv + cipher.doFinal(plaintext), Base64.NO_WRAP)
            check(preferences.edit().putString(KEY_PAYLOAD, encoded).commit()) {
                "Não foi possível preservar a impressora selecionada."
            }
        } finally {
            plaintext.fill(0)
        }
    }

    @Synchronized
    override fun clear() {
        check(preferences.edit().remove(KEY_PAYLOAD).commit()) {
            "Não foi possível remover a impressora selecionada."
        }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
            generateKey()
        }
    }

    private companion object {
        // O consumidor importa formatos antigos pelo protocolo genérico e só então os remove.
        const val PREFERENCES_NAME = "thermal_printer_kit_selection"
        const val KEY_PAYLOAD = "selection"
        const val KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "thermal_printer_kit_selection_aes_v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_SIZE = 12
        const val AUTH_TAG_SIZE = 16
        const val AUTH_TAG_BITS = 128
        val AAD = "thermal-printer-kit:android:selection:v1".toByteArray(Charsets.UTF_8)
    }
}
