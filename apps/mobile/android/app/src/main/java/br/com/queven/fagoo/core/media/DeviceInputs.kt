package br.com.queven.fagoo.core.media

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.net.Uri
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** Leitura de dados do aparelho usados pelo composer: posição atual e contato da agenda. */
object DeviceInputs {
    fun hasPermission(context: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    fun hasLocationPermission(context: Context): Boolean =
        hasPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) || hasPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION)

    /** Posição atual via FusedLocationProviderClient; exige permissão concedida antes da chamada. */
    @SuppressLint("MissingPermission")
    suspend fun currentLocation(context: Context, timeoutMs: Long = 15_000): Location? {
        if (!hasLocationPermission(context)) return null
        val client = LocationServices.getFusedLocationProviderClient(context)
        val priority = if (hasPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)) Priority.PRIORITY_HIGH_ACCURACY else Priority.PRIORITY_BALANCED_POWER_ACCURACY
        return try {
            val tokenSource = CancellationTokenSource()
            withTimeoutOrNull(timeoutMs) { client.getCurrentLocation(priority, tokenSource.token).await() }
                ?: runCatching { client.lastLocation.await() }.getOrNull()
        } catch (e: Exception) {
            null
        }
    }

    /** Nome e telefone (somente dígitos, com "+" opcional) do contato escolhido em ActivityResultContracts.PickContact. */
    suspend fun readContact(context: Context, uri: Uri): Pair<String, String>? = withContext(Dispatchers.IO) {
        val resolver = context.contentResolver
        var id: String? = null
        var name: String? = null
        runCatching {
            resolver.query(uri, arrayOf(ContactsContract.Contacts._ID, ContactsContract.Contacts.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    id = cursor.getString(0)
                    name = cursor.getString(1)
                }
            }
        }
        val contactId: String = id ?: return@withContext null
        var phone: String? = null
        runCatching {
            resolver.query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER),
                "${ContactsContract.CommonDataKinds.Phone.CONTACT_ID}=?",
                arrayOf(contactId),
                null,
            )?.use { cursor -> if (cursor.moveToFirst()) phone = cursor.getString(0) }
        }
        Pair(name.orEmpty().trim(), normalizePhone(phone.orEmpty()))
    }

    /** Mantém "+" inicial e dígitos, no formato aceito pelo servidor (^\+?\d{8,16}$). */
    fun normalizePhone(raw: String): String {
        val digits = raw.filter { it.isDigit() }
        return if (raw.trim().startsWith("+")) "+$digits" else digits
    }
}
