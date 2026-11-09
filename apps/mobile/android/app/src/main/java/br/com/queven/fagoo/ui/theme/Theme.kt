package br.com.queven.fagoo.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

val Brand = Color(0xFF6842A6)
val BrandLight = Color(0xFFB99BF3)
val IncomingBubble = Color(0xFFFFFFFF)
val OutgoingBubble = Color(0xFFEADFFC)
val NoteBubble = Color(0xFFFFF4C2)
val IncomingBubbleDark = Color(0xFF302A3E)
val OutgoingBubbleDark = Color(0xFF50356F)
val NoteBubbleDark = Color(0xFF4A4320)
val Overdue = Color(0xFFC62828)
val DueSoon = Color(0xFFEF6C00)

private val Light = lightColorScheme(
    primary = Brand,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFEADFFC),
    secondary = Color(0xFF705C8C),
    tertiary = BrandLight,
    background = Color(0xFFFAF7FD),
    surface = Color.White,
)
private val Dark = darkColorScheme(
    primary = Color(0xFFB99BF3),
    onPrimary = Color(0xFF30213F),
    primaryContainer = Color(0xFF6842A6),
    secondary = Color(0xFFB99BF3),
    background = Color(0xFF1D1925),
    surface = Color(0xFF252131),
)

@Composable
fun FagooTheme(darkTheme: Boolean = isSystemInDarkTheme(), dynamicColor: Boolean = false, content: @Composable () -> Unit) {
    val scheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> Dark
        else -> Light
    }
    MaterialTheme(colorScheme = scheme, content = content)
}
