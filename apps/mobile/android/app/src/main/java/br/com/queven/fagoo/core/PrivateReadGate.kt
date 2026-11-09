package br.com.queven.fagoo.core

/** Rejects late reads after a newer read or a revocation; no payload is retained here. */
class PrivateReadGate {
    private var epoch = 0L
    fun begin(): Long = ++epoch
    fun current(read: Long): Boolean = read == epoch
    fun revoked(read: Long, status: Int?): Boolean {
        if (!current(read) || status !in setOf(401, 403, 404)) return false
        ++epoch
        return true
    }
    fun invalidate() { ++epoch }
    companion object {
        fun canAct(online: Boolean, capabilities: Collection<String>, capability: String): Boolean = online && capability in capabilities
    }
}
