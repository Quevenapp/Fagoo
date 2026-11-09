package br.com.queven.fagoo.core.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Reserved for notification dismissals; no privileged actions execute from broadcasts. */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = Unit
}
