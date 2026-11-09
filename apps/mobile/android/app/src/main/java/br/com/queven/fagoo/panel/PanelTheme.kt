// SPDX-License-Identifier: AGPL-3.0-only
// Adaptado do Vinki v4; cores e fontes originais preservadas.
package br.com.queven.fagoo.panel

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import br.com.queven.fagoo.R


/**
 * O visual dos painéis por template (31/10/2026). Os painéis deixam a
 * identidade do protocolo web (monoespaçada e bege) e ganham fonte, paleta e
 * grade próprias, escolhidas para leitura a distância. Os valores vêm do
 * protótipo `Vinki_v3/docs/design/telas-v2-2026-10-31/index.html`, onde foram medidos
 * em 950 combinações de tela e aparelho; mudar aqui sem mudar lá desalinha os
 * dois.
 *
 * As fontes são OFL e vão empacotadas em `res/font`, com as licenças em
 * `assets/licencas-fontes`.
 */
@Immutable
data class PanelStyle(
    val template: PanelTemplate,
    val dark: Boolean,
    val display: FontFamily,
    val text: FontFamily,
    val displayWeight: FontWeight,
    val boldWeight: FontWeight,
    val bg: Color,
    val fg: Color,
    val muted: Color,
    val surface: Color,
    val line: Color,
    val headerBg: Color,
    val headerFg: Color,
    val headerLine: Color,
    val headerLineWidth: Dp,
    val heroBg: Color,
    val heroFg: Color,
    val destBg: Color,
    val destFg: Color,
    val prevDest: Color,
    val accent: Color,
    val accentFg: Color,
    val ok: Color,
    val wait: Color,
    val queues: List<Color>,
    val chipFg: Color,
    val readyBg: Color,
    val readyFg: Color,
    val radius: Dp,
    val radiusSmall: Dp,
    val border: Dp,
    /** Sombra dura deslocada, de cardápio (Vitrine). */
    val hardShadow: Boolean,
    /** Largura de "B042" em em: o número mede `largura / numEm`. */
    val numEm: Float,
    /** Fração máxima da altura do bloco que o número pode ocupar. */
    val numHeight: Float,
    val upperLabels: Boolean,
    val labelTracking: Float,
    val upperNames: Boolean,
    val upperDest: Boolean,
    /** Seta de saída antes do destino (Sinal). */
    val arrow: Boolean,
    /** Destino numa pílula centrada, em vez de faixa (Clínica, Vitrine). */
    val destPill: Boolean,
    /** Número e destino alinhados à esquerda (Terminal). */
    val alignStart: Boolean,
    /** Chamadas anteriores em tabela com hora (Terminal). */
    val boardTable: Boolean,
    /** "● Chamando" piscando ao lado da fila (Terminal). */
    val liveTag: Boolean,
    val roundChips: Boolean,
) {
    fun queueColor(index: Int): Color = queues[((index % queues.size) + queues.size) % queues.size]
}

private val Overpass =
    FontFamily(
        Font(R.font.panel_overpass_regular, FontWeight.Normal),
        Font(R.font.panel_overpass_bold, FontWeight.Bold),
        Font(R.font.panel_overpass_black, FontWeight.Black),
    )
private val Atkinson =
    FontFamily(Font(R.font.panel_atkinson_regular, FontWeight.Normal), Font(R.font.panel_atkinson_bold, FontWeight.Bold))
private val B612 = FontFamily(Font(R.font.panel_b612_regular, FontWeight.Normal), Font(R.font.panel_b612_bold, FontWeight.Bold))
private val Anton = FontFamily(Font(R.font.panel_anton_regular, FontWeight.Normal))
private val Archivo =
    FontFamily(Font(R.font.panel_archivo_regular, FontWeight.Normal), Font(R.font.panel_archivo_extrabold, FontWeight.ExtraBold))
private val Lexend =
    FontFamily(
        Font(R.font.panel_lexend_regular, FontWeight.Normal),
        Font(R.font.panel_lexend_semibold, FontWeight.SemiBold),
        Font(R.font.panel_lexend_extrabold, FontWeight.ExtraBold),
    )

object PanelStyles {
    /** A fonte de cada cartão na escolha do template: o nome dela já é a amostra. */
    fun displayFamily(template: PanelTemplate): FontFamily = of(template).display

    fun of(template: PanelTemplate): PanelStyle =
        when (template) {
            // Placa de estrada: azul-noite, amarelo de sinalização, Overpass.
            PanelTemplate.SINAL ->
                PanelStyle(
                    template, dark = true, display = Overpass, text = Overpass,
                    displayWeight = FontWeight.Black, boldWeight = FontWeight.Bold,
                    bg = Color(0xFF0C1A2E), fg = Color.White, muted = Color(0xFFA9B8CC),
                    surface = Color(0xFF15263F), line = Color(0xFF29405F),
                    headerBg = Color(0xFF081322), headerFg = Color.White, headerLine = Color(0xFFFFC72C), headerLineWidth = 4.dp,
                    heroBg = Color(0xFFFFC72C), heroFg = Color(0xFF0C1A2E), destBg = Color(0xFF0C1A2E), destFg = Color(0xFFFFC72C),
                    prevDest = Color(0xFFFFC72C), accent = Color(0xFFFFC72C), accentFg = Color(0xFF0C1A2E),
                    ok = Color(0xFF3DDC97), wait = Color(0xFFFF9F43),
                    queues = listOf(Color(0xFF4DA3FF), Color(0xFF3DDC97), Color(0xFFFF9F43), Color(0xFFD7A6FF)),
                    chipFg = Color(0xFF0C1A2E), readyBg = Color(0xFFFFC72C), readyFg = Color(0xFF0C1A2E),
                    radius = 10.dp, radiusSmall = 7.dp, border = 0.dp, hardShadow = false,
                    numEm = 2.75f, numHeight = 0.52f,
                    upperLabels = true, labelTracking = 0.08f, upperNames = false, upperDest = false,
                    arrow = true, destPill = false, alignStart = false, boardTable = false, liveTag = false, roundChips = false,
                )
            // Calma e clara: branco, petróleo, Atkinson Hyperlegible.
            PanelTemplate.CLINICA ->
                PanelStyle(
                    template, dark = false, display = Atkinson, text = Atkinson,
                    displayWeight = FontWeight.Bold, boldWeight = FontWeight.Bold,
                    bg = Color(0xFFEDF2F4), fg = Color(0xFF0B2530), muted = Color(0xFF4A6470),
                    surface = Color.White, line = Color(0xFFD3DEE3),
                    headerBg = Color.White, headerFg = Color(0xFF0B2530), headerLine = Color(0xFFD3DEE3), headerLineWidth = 1.dp,
                    heroBg = Color.White, heroFg = Color(0xFF0A5A69), destBg = Color(0xFF0A5A69), destFg = Color.White,
                    prevDest = Color(0xFF0A5A69), accent = Color(0xFF0A6E7E), accentFg = Color.White,
                    ok = Color(0xFF1E7F4F), wait = Color(0xFFA8510B),
                    queues = listOf(Color(0xFF0A6E7E), Color(0xFF5847C2), Color(0xFFA8510B), Color(0xFFB3245E)),
                    chipFg = Color.White, readyBg = Color(0xFF0A6E7E), readyFg = Color.White,
                    radius = 22.dp, radiusSmall = 14.dp, border = 1.dp, hardShadow = false,
                    numEm = 2.85f, numHeight = 0.50f,
                    upperLabels = false, labelTracking = 0f, upperNames = false, upperDest = false,
                    arrow = false, destPill = true, alignStart = false, boardTable = false, liveTag = false, roundChips = true,
                )
            // Quadro de partidas: preto, âmbar, B612.
            PanelTemplate.TERMINAL ->
                PanelStyle(
                    template, dark = true, display = B612, text = B612,
                    displayWeight = FontWeight.Bold, boldWeight = FontWeight.Bold,
                    bg = Color(0xFF050505), fg = Color(0xFFEDEDED), muted = Color(0xFF8C8C8C),
                    surface = Color(0xFF111111), line = Color(0xFF2A2A2A),
                    headerBg = Color(0xFF050505), headerFg = Color(0xFFFFB81C), headerLine = Color(0xFF2A2A2A), headerLineWidth = 1.dp,
                    heroBg = Color(0xFF111111), heroFg = Color(0xFFFFB81C), destBg = Color(0xFF111111), destFg = Color.White,
                    prevDest = Color.White, accent = Color(0xFFFFB81C), accentFg = Color(0xFF050505),
                    ok = Color(0xFF4ADE80), wait = Color(0xFFFF5C39),
                    queues = listOf(Color(0xFF38BDF8), Color(0xFF4ADE80), Color(0xFFFF5C39), Color(0xFFC084FC)),
                    chipFg = Color(0xFF050505), readyBg = Color(0xFF1C1504), readyFg = Color(0xFFFFB81C),
                    radius = 3.dp, radiusSmall = 2.dp, border = 1.dp, hardShadow = false,
                    numEm = 2.85f, numHeight = 0.50f,
                    upperLabels = true, labelTracking = 0.12f, upperNames = true, upperDest = true,
                    arrow = false, destPill = false, alignStart = true, boardTable = true, liveTag = true, roundChips = false,
                )
            // Quadro de lanchonete: amarelo-gema, preto, Anton e Archivo.
            PanelTemplate.VITRINE ->
                PanelStyle(
                    template, dark = false, display = Anton, text = Archivo,
                    displayWeight = FontWeight.Normal, boldWeight = FontWeight.ExtraBold,
                    bg = Color(0xFFFFD23F), fg = Color(0xFF141414), muted = Color(0xFF4D3F0C),
                    surface = Color.White, line = Color(0xFF141414),
                    headerBg = Color(0xFF141414), headerFg = Color(0xFFFFD23F), headerLine = Color(0xFF141414), headerLineWidth = 0.dp,
                    heroBg = Color(0xFF141414), heroFg = Color(0xFFFFD23F), destBg = Color.White, destFg = Color(0xFF141414),
                    prevDest = Color(0xFF141414), accent = Color(0xFF141414), accentFg = Color(0xFFFFD23F),
                    ok = Color(0xFF0B7A3B), wait = Color(0xFFC2261B),
                    queues = listOf(Color(0xFFD7261E), Color(0xFF1F5FBF), Color(0xFF0B7A3B), Color(0xFF7B2CBF)),
                    chipFg = Color.White, readyBg = Color(0xFFFFD23F), readyFg = Color(0xFF141414),
                    radius = 16.dp, radiusSmall = 11.dp, border = 3.dp, hardShadow = true,
                    numEm = 2.65f, numHeight = 0.56f,
                    upperLabels = true, labelTracking = 0.06f, upperNames = true, upperDest = true,
                    arrow = false, destPill = true, alignStart = false, boardTable = false, liveTag = false, roundChips = false,
                )
            // Contraste máximo: branco, preto, cobalto, Lexend.
            PanelTemplate.SOL ->
                PanelStyle(
                    template, dark = false, display = Lexend, text = Lexend,
                    displayWeight = FontWeight.ExtraBold, boldWeight = FontWeight.SemiBold,
                    bg = Color.White, fg = Color.Black, muted = Color(0xFF333333),
                    surface = Color(0xFFF2F2F2), line = Color.Black,
                    headerBg = Color.Black, headerFg = Color.White, headerLine = Color.Black, headerLineWidth = 0.dp,
                    heroBg = Color(0xFF0030C8), heroFg = Color.White, destBg = Color.Black, destFg = Color.White,
                    prevDest = Color.Black, accent = Color(0xFF0030C8), accentFg = Color.White,
                    ok = Color(0xFF00702E), wait = Color(0xFFB00020),
                    // Sem cobalto: a fila não pode sumir no bloco cobalto da senha.
                    queues = listOf(Color(0xFFD9480F), Color(0xFF00702E), Color(0xFFB00020), Color(0xFF6A1B9A)),
                    chipFg = Color.White, readyBg = Color(0xFF0030C8), readyFg = Color.White,
                    radius = 0.dp, radiusSmall = 0.dp, border = 3.dp, hardShadow = false,
                    numEm = 3.05f, numHeight = 0.50f,
                    upperLabels = true, labelTracking = 0.06f, upperNames = false, upperDest = false,
                    arrow = false, destPill = false, alignStart = false, boardTable = false, liveTag = false, roundChips = false,
                )
        }
}

val LocalPanelStyle = staticCompositionLocalOf { PanelStyles.of(PanelTemplate.DEFAULT) }

/**
 * Veste uma subárvore com o template: o estilo fica em [LocalPanelStyle] para
 * os quadros do painel, e o `MaterialTheme` derivado faz diálogos, botões e
 * pílulas existentes seguirem as mesmas cores e fontes. O resto do app
 * continua no `VinkiTheme`.
 */
@Composable
fun PanelTheme(template: PanelTemplate, content: @Composable () -> Unit) {
    val s = PanelStyles.of(template)
    val base =
        if (s.dark) {
            darkColorScheme(
                primary = s.accent, onPrimary = s.accentFg, primaryContainer = s.surface, onPrimaryContainer = s.fg,
                secondary = s.accent, onSecondary = s.accentFg, secondaryContainer = s.surface, onSecondaryContainer = s.fg,
                tertiary = s.wait, onTertiary = s.bg, tertiaryContainer = s.surface, onTertiaryContainer = s.wait,
                background = s.bg, onBackground = s.fg, surface = s.surface, onSurface = s.fg,
                surfaceVariant = s.surface, onSurfaceVariant = s.muted, outline = s.line, outlineVariant = s.line,
                error = s.wait, onError = s.bg, errorContainer = s.surface, onErrorContainer = s.wait,
                surfaceContainerHigh = s.surface, surfaceContainer = s.surface, surfaceContainerHighest = s.surface,
            )
        } else {
            lightColorScheme(
                primary = s.accent, onPrimary = s.accentFg, primaryContainer = s.surface, onPrimaryContainer = s.fg,
                secondary = s.accent, onSecondary = s.accentFg, secondaryContainer = s.surface, onSecondaryContainer = s.fg,
                tertiary = s.wait, onTertiary = Color.White, tertiaryContainer = s.surface, onTertiaryContainer = s.wait,
                background = s.bg, onBackground = s.fg, surface = s.surface, onSurface = s.fg,
                surfaceVariant = s.surface, onSurfaceVariant = s.muted, outline = s.line, outlineVariant = s.line,
                error = s.wait, onError = Color.White, errorContainer = s.surface, onErrorContainer = s.wait,
                surfaceContainerHigh = s.surface, surfaceContainer = s.surface, surfaceContainerHighest = s.surface,
            )
        }
    val t = MaterialTheme.typography
    fun TextStyle.text() = copy(fontFamily = s.text)
    fun TextStyle.display() = copy(fontFamily = s.display, fontWeight = s.displayWeight)
    val typography =
        Typography(
            displayLarge = t.displayLarge.display(), displayMedium = t.displayMedium.display(), displaySmall = t.displaySmall.display(),
            headlineLarge = t.headlineLarge.display(), headlineMedium = t.headlineMedium.display(), headlineSmall = t.headlineSmall.display(),
            titleLarge = t.titleLarge.text(), titleMedium = t.titleMedium.text(), titleSmall = t.titleSmall.text(),
            bodyLarge = t.bodyLarge.text(), bodyMedium = t.bodyMedium.text(), bodySmall = t.bodySmall.text(),
            labelLarge = t.labelLarge.text(), labelMedium = t.labelMedium.text(), labelSmall = t.labelSmall.text(),
        )
    val shape = RoundedCornerShape(s.radiusSmall)
    CompositionLocalProvider(LocalPanelStyle provides s) {
        MaterialTheme(
            colorScheme = base,
            typography = typography,
            shapes = Shapes(extraSmall = shape, small = shape, medium = RoundedCornerShape(s.radius), large = RoundedCornerShape(s.radius), extraLarge = RoundedCornerShape(s.radius)),
            content = content,
        )
    }
}
