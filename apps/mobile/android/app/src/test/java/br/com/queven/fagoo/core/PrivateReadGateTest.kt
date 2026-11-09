package br.com.queven.fagoo.core

import org.junit.Assert.*
import org.junit.Test

class PrivateReadGateTest {
    @Test fun lateReadCannotRestoreTransferredConversation() {
        val gate = PrivateReadGate()
        val oldRequest = gate.begin()
        val currentRequest = gate.begin()
        assertTrue(gate.revoked(currentRequest, 403))
        assertFalse(gate.current(oldRequest))
        assertFalse(gate.current(currentRequest))
        val authorizedAgain = gate.begin()
        assertTrue(gate.current(authorizedAgain))
    }
    @Test fun oldFailureCannotClearNewlyAuthorizedChatAndMissingChatRevokes() {
        val gate = PrivateReadGate()
        val oldRequest = gate.begin()
        val freshRequest = gate.begin()
        assertFalse(gate.revoked(oldRequest, 403))
        assertTrue(gate.current(freshRequest))
        assertTrue(gate.revoked(freshRequest, 404))
        assertFalse(gate.current(freshRequest))
    }
    @Test fun readsNeverGrantAnUnassignedWriteCapabilityAndOfflineCannotWrite() {
        assertFalse(PrivateReadGate.canAct(true, listOf("communication.read"), "communication.reply"))
        assertFalse(PrivateReadGate.canAct(false, listOf("communication.reply"), "communication.reply"))
        assertTrue(PrivateReadGate.canAct(true, listOf("communication.reply"), "communication.reply"))
        val gate = PrivateReadGate(); val pending = gate.begin(); gate.invalidate(); assertFalse(gate.current(pending))
    }
}
