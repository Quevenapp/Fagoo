package br.com.queven.fagoo.core.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import br.com.queven.fagoo.MainActivity

/** Generic local notifications only, after an online authorization check. No private history is persisted. */
object Notifications {
    @Volatile var visibleConversationId: String? = null
    fun ensureChannels(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("messages", "Atendimento Fagoo", NotificationManager.IMPORTANCE_DEFAULT))
    }
    fun cancelConversation(context: Context, conversationId: String) { NotificationManagerCompat.from(context).cancel(conversationId, 1) }
    fun show(context: Context, title: String, body: String, data: Map<String, String>) {
        if(data["conversation_id"] == visibleConversationId && visibleConversationId != null) return
        val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        // The shell opens its authorized list; untrusted notification URLs never select another account/unit.
        val pending = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, "messages").setSmallIcon(br.com.queven.fagoo.R.drawable.ic_notification)
            .setContentTitle("Fagoo").setContentText("Novo aviso de atendimento").setContentIntent(pending).setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build()
        runCatching { NotificationManagerCompat.from(context).notify(data["conversation_id"] ?: data["chat_id"] ?: "queue", 1, notification) }
    }
}
