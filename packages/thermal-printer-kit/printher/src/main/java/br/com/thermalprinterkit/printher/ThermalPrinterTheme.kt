package br.com.thermalprinterkit.printher

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Aparência da interface opcional do kit.
 *
 * O tema é autocontido para o módulo não depender do design system do app hospedeiro. Tipografia,
 * botões e diálogos ainda respeitam o [androidx.compose.material3.MaterialTheme] instalado pelo
 * host; estas cores cobrem somente as superfícies próprias do kit.
 */
@Immutable
data class ThermalPrinterTheme(
    val usesPrintherLayout: Boolean,
    val printerImageResources: Map<String, Int> = emptyMap(),
    val printerDisplayNames: Map<String, String> = emptyMap(),
    val contentPadding: Dp,
    val sectionSpacing: Dp,
    val cardContainerColor: Color,
    val cardContentColor: Color,
    val outlineColor: Color,
    val accentColor: Color,
    val onAccentColor: Color,
    val infoContainerColor: Color,
    val onInfoContainerColor: Color,
    val successContainerColor: Color,
    val onSuccessContainerColor: Color,
    val warningContainerColor: Color,
    val onWarningContainerColor: Color,
    val dangerContainerColor: Color,
    val onDangerContainerColor: Color,
) {
    companion object {
        /** Tema neutro, sem cores ou componentes de nenhum app consumidor. */
        val neutral =
            ThermalPrinterTheme(
                usesPrintherLayout = false,
                contentPadding = 16.dp,
                sectionSpacing = 16.dp,
                cardContainerColor = Color(0xFFF9FAFB),
                cardContentColor = Color(0xFF1F2937),
                outlineColor = Color(0xFFD1D5DB),
                accentColor = Color(0xFF315E7D),
                onAccentColor = Color.White,
                infoContainerColor = Color(0xFFE8F1F8),
                onInfoContainerColor = Color(0xFF173B53),
                successContainerColor = Color(0xFFE4F3E8),
                onSuccessContainerColor = Color(0xFF174C2A),
                warningContainerColor = Color(0xFFFFF2D5),
                onWarningContainerColor = Color(0xFF664600),
                dangerContainerColor = Color(0xFFFFE6E5),
                onDangerContainerColor = Color(0xFF6C1D1A),
            )

        /** Identidade visual do app Printher; consumidores continuam usando [neutral]. */
        val printher =
            ThermalPrinterTheme(
                usesPrintherLayout = true,
                contentPadding = 20.dp,
                sectionSpacing = 18.dp,
                cardContainerColor = Color.White,
                cardContentColor = Color(0xFF111111),
                outlineColor = Color(0xFFD5D5D5),
                accentColor = Color(0xFF0D6EED),
                onAccentColor = Color.White,
                infoContainerColor = Color(0xFFE9F2FF),
                onInfoContainerColor = Color(0xFF075CCB),
                successContainerColor = Color(0xFFE1F5E4),
                onSuccessContainerColor = Color(0xFF126B2A),
                warningContainerColor = Color(0xFFFFF3D6),
                onWarningContainerColor = Color(0xFF6A4800),
                dangerContainerColor = Color(0xFFFFE8E7),
                onDangerContainerColor = Color(0xFF781F1A),
            )
    }
}
