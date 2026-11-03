// Test-only clock for the October 2026 synthetic snapshots. Their signed fiscal
// policy/profile validity is intentionally unchanged. Elapsed time still moves,
// and individual tests can advance Date.now to verify expiration boundaries.
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
