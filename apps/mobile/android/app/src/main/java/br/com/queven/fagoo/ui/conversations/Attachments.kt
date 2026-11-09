@file:OptIn(ExperimentalMaterial3Api::class)
// Media3 marca as APIs instáveis com @RequiresOptIn do androidx.annotation; o OptIn do Kotlin não vale para elas.
@file:androidx.annotation.OptIn(UnstableApi::class)

package br.com.queven.fagoo.ui.conversations

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import br.com.queven.fagoo.core.AppContainer
import br.com.queven.fagoo.core.media.AuthenticatedMedia
import br.com.queven.fagoo.core.media.MediaDownloader
import br.com.queven.fagoo.core.media.MediaKinds
import br.com.queven.fagoo.core.model.MediaFile
import coil.compose.AsyncImage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

/**
 * ExoPlayer que fala com o servidor pelo OkHttp autenticado (Authorization) e continua lendo
 * arquivos locais (file:// e content://) pelo DefaultDataSource, usado nas prévias de gravação.
 */
internal fun buildPlayer(context: Context, okHttp: OkHttpClient): ExoPlayer {
    val http = OkHttpDataSource.Factory(okHttp)
    val dataSource = DefaultDataSource.Factory(context, http)
    return ExoPlayer.Builder(context)
        .setMediaSourceFactory(DefaultMediaSourceFactory(dataSource))
        .build()
}

private val imageMimes = setOf("image/jpeg", "image/png", "image/webp", "image/gif")

/** Escolhe a visualização conforme o tipo do anexo (lista `media` do detalhe da conversa). */
@Composable
internal fun AttachmentView(
    media: MediaFile,
    profileId: String,
    container: AppContainer,
    onOpenImage: (MediaFile) -> Unit,
    modifier: Modifier = Modifier,
) {
    val base = MediaKinds.baseMime(media.type)
    when {
        base in imageMimes -> ImageAttachment(media, profileId, container, onOpenImage, modifier)
        base.startsWith("video/") -> VideoAttachment(media, profileId, container, modifier)
        base.startsWith("audio/") -> Column(modifier.fillMaxWidth()) {
            AudioPlayerBar(uri = AuthenticatedMedia.url(container, profileId, media.id, inline = true), container = container)
            if (media.name.isNotBlank() && !media.name.startsWith("voz-") && media.name != "mensagem-de-voz.ogg") {
                Text(
                    "${media.name} · ${MediaKinds.formatSize(media.size)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = LocalContentColor.current.copy(alpha = 0.7f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        else -> DocumentAttachment(media, profileId, container, modifier)
    }
}

@Composable
private fun ImageAttachment(media: MediaFile, profileId: String, container: AppContainer, onOpenImage: (MediaFile) -> Unit, modifier: Modifier) {
    val url = AuthenticatedMedia.url(container, profileId, media.id, inline = true)
    AsyncImage(
        model = url,
        contentDescription = media.name.ifBlank { "Imagem" },
        imageLoader = AuthenticatedMedia.imageLoader(container),
        modifier = modifier
            .fillMaxWidth()
            .widthIn(max = 300.dp)
            .height(220.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(Color.Black.copy(alpha = 0.08f))
            .clickable { onOpenImage(media) },
        contentScale = ContentScale.Crop,
    )
}

@Composable
private fun VideoAttachment(media: MediaFile, profileId: String, container: AppContainer, modifier: Modifier) {
    val context = LocalContext.current
    val url = AuthenticatedMedia.url(container, profileId, media.id, inline = true)
    var player by remember(media.id) { mutableStateOf<ExoPlayer?>(null) }
    DisposableEffect(media.id) {
        onDispose {
            player?.release()
            player = null
        }
    }
    Box(
        modifier
            .fillMaxWidth()
            .widthIn(max = 300.dp)
            .height(220.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(Color.Black),
        contentAlignment = Alignment.Center,
    ) {
        val current = player
        if (current == null) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                IconButton(
                    onClick = {
                        val created = buildPlayer(context, container.okHttp)
                        created.setMediaItem(MediaItem.fromUri(url))
                        created.prepare()
                        created.playWhenReady = true
                        player = created
                    },
                    modifier = Modifier.size(64.dp),
                ) {
                    Icon(Icons.Filled.PlayArrow, contentDescription = "Reproduzir vídeo", tint = Color.White, modifier = Modifier.size(48.dp))
                }
                Text(
                    "${media.name.ifBlank { "Vídeo" }} · ${MediaKinds.formatSize(media.size)}",
                    color = Color.White,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = 8.dp),
                )
            }
        } else {
            AndroidView(
                factory = { ctx ->
                    val view = PlayerView(ctx)
                    view.player = current
                    view.useController = true
                    view
                },
                update = { view -> view.player = current },
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

/** Player de áudio/voz com tocar/pausar, barra de progresso e tempo. Funciona com URLs do servidor e arquivos locais. */
@Composable
internal fun AudioPlayerBar(uri: String, container: AppContainer, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var player by remember(uri) { mutableStateOf<ExoPlayer?>(null) }
    var playing by remember(uri) { mutableStateOf(false) }
    var buffering by remember(uri) { mutableStateOf(false) }
    var positionMs by remember(uri) { mutableLongStateOf(0L) }
    var durationMs by remember(uri) { mutableLongStateOf(0L) }

    DisposableEffect(uri) {
        onDispose {
            player?.release()
            player = null
        }
    }
    LaunchedEffect(playing) {
        while (playing) {
            val current = player
            if (current != null) {
                positionMs = current.currentPosition
                val d = current.duration
                if (d > 0) durationMs = d
            }
            delay(250)
        }
    }

    fun ensurePlayer(): ExoPlayer {
        player?.let { return it }
        val created = buildPlayer(context, container.okHttp)
        created.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                playing = isPlaying
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                buffering = playbackState == Player.STATE_BUFFERING
                if (playbackState == Player.STATE_READY) {
                    val d = created.duration
                    if (d > 0) durationMs = d
                }
                if (playbackState == Player.STATE_ENDED) {
                    created.pause()
                    created.seekTo(0)
                    positionMs = 0
                }
            }
        })
        created.setMediaItem(MediaItem.fromUri(uri))
        created.prepare()
        player = created
        return created
    }

    Row(modifier.fillMaxWidth().widthIn(min = 200.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = {
            val p = ensurePlayer()
            if (p.isPlaying) p.pause() else p.play()
        }) {
            if (buffering && !playing) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            } else {
                Icon(
                    if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                    contentDescription = if (playing) "Pausar" else "Reproduzir áudio",
                )
            }
        }
        Slider(
            value = if (durationMs > 0) (positionMs.toFloat() / durationMs.toFloat()).coerceIn(0f, 1f) else 0f,
            onValueChange = { fraction ->
                val p = ensurePlayer()
                val target = (fraction * durationMs).toLong()
                positionMs = target
                p.seekTo(target)
            },
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(4.dp))
        Text(
            formatClock(if (playing || positionMs > 0) positionMs else durationMs),
            style = MaterialTheme.typography.labelSmall,
        )
    }
}

/** Documento: nome, tamanho e botões Abrir / Compartilhar (baixa para o cache com Authorization). */
@Composable
private fun DocumentAttachment(media: MediaFile, profileId: String, container: AppContainer, modifier: Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val downloader = remember(container) { MediaDownloader(container) }
    var busy by remember { mutableStateOf(false) }
    var percent by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }

    fun run(action: (java.io.File) -> Boolean, failure: String) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try {
                val file = downloader.download(profileId, media) { percent = it }
                if (!action(file)) error = failure
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = container.handleError(e)
            } finally {
                busy = false
            }
        }
    }

    Surface(
        color = LocalContentColor.current.copy(alpha = 0.08f),
        shape = RoundedCornerShape(10.dp),
        modifier = modifier.fillMaxWidth().widthIn(max = 300.dp),
    ) {
        Column(Modifier.padding(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Description, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text(media.name.ifBlank { "Anexo" }, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(
                        listOf(MediaKinds.formatSize(media.size).takeIf { media.size > 0 }, MediaKinds.baseMime(media.type).substringAfter('/').uppercase()).filterNotNull().joinToString(" · "),
                        style = MaterialTheme.typography.labelSmall,
                        color = LocalContentColor.current.copy(alpha = 0.7f),
                    )
                }
                IconButton(
                    onClick = { run({ downloader.open(context, it, media.type) }, "Nenhum aplicativo consegue abrir este arquivo. Use Compartilhar.") },
                    enabled = !busy,
                ) { Icon(Icons.Filled.OpenInNew, contentDescription = "Abrir documento") }
                IconButton(
                    onClick = { run({ downloader.share(context, it, media.type, "Compartilhar ${media.name}") }, "Não foi possível compartilhar o arquivo.") },
                    enabled = !busy,
                ) { Icon(Icons.Filled.Share, contentDescription = "Compartilhar documento") }
            }
            if (busy) {
                LinearProgressIndicator(progress = { percent / 100f }, modifier = Modifier.fillMaxWidth().padding(top = 4.dp))
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 4.dp)) }
        }
    }
}

/** Visualizador de imagem em tela cheia com zoom (pinça) e compartilhamento. */
@Composable
internal fun ImageViewerDialog(media: MediaFile, profileId: String, container: AppContainer, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val downloader = remember(container) { MediaDownloader(container) }
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var sharing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val transformState = rememberTransformableState { zoom, pan, _ ->
        scale = (scale * zoom).coerceIn(1f, 6f)
        offset = if (scale <= 1f) Offset.Zero else offset + pan
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            AsyncImage(
                model = AuthenticatedMedia.url(container, profileId, media.id, inline = true),
                contentDescription = media.name.ifBlank { "Imagem" },
                imageLoader = AuthenticatedMedia.imageLoader(container),
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .transformable(transformState)
                    .graphicsLayer {
                        scaleX = scale
                        scaleY = scale
                        translationX = offset.x
                        translationY = offset.y
                    },
            )
            Row(
                Modifier.fillMaxWidth().statusBarsPadding().padding(8.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onDismiss) { Icon(Icons.Filled.Close, contentDescription = "Fechar", tint = Color.White) }
                Text(
                    media.name,
                    color = Color.White,
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                )
                IconButton(
                    onClick = {
                        if (sharing) return@IconButton
                        sharing = true
                        error = null
                        scope.launch {
                            try {
                                val file = downloader.download(profileId, media)
                                if (!downloader.share(context, file, media.type, "Compartilhar imagem")) error = "Não foi possível compartilhar."
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                error = container.handleError(e)
                            } finally {
                                sharing = false
                            }
                        }
                    },
                ) {
                    if (sharing) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = Color.White)
                    else Icon(Icons.Filled.Share, contentDescription = "Compartilhar imagem", tint = Color.White)
                }
            }
            error?.let {
                Text(
                    it,
                    color = Color.White,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
                )
            }
        }
    }
}
