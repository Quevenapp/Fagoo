// Test-only time for the October 2026 synthetic fiscal policies and reviews.
// Both JavaScript and PGlite observe this clock. Elapsed time keeps advancing,
// so lease, abort, freshness and expiry tests retain their temporal behavior.
const NativeDate = globalThis.Date;
export const SYNTHETIC_SNAPSHOT_TIME = NativeDate.parse('2026-10-20T15:00:00.000Z');
const offset = NativeDate.now() - SYNTHETIC_SNAPSHOT_TIME;
class FiscalSnapshotDate extends NativeDate {
  constructor(...args) {
    if (args.length === 0) super(FiscalSnapshotDate.now());
    else super(...args);
  }
  static now() { return NativeDate.now() - offset; }
}
globalThis.Date = FiscalSnapshotDate;
