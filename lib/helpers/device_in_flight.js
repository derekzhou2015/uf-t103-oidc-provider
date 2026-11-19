import epochTime from './epoch_time.js';

// Upper bound on how long a single end-user confirmation request may keep a
// device code in the in-flight state. A lock younger than this is treated as a
// live, concurrent confirmation and remains exclusive. A lock older than this
// can only belong to a request that died mid-flight (closed tab, crashed
// process, lost network), so another confirmation may take over.
//
// The value is deliberately independent of the device code's own TTL: it bounds
// a single HTTP interaction, not the user interaction as a whole. The
// confirmation request's work is a handful of local adapter reads/writes plus
// page rendering, so it completes in well under a second in normal operation;
// 30s gives generous headroom for slow stores and GC/multi-tenant pauses while
// staying short enough that a user re-entering a code after an interrupted
// session only ever waits for the remainder of this box before they can finish
// the flow again. It also matches the common slow-polling interval devices use
// against the token endpoint, so an interrupted confirmation is recovered
// within roughly one polling round.
export const DEVICE_CODE_IN_FLIGHT_GRACE = 30;

export function isInFlightStale(code, now = epochTime()) {
  if (!code?.inFlight) {
    return false;
  }
  // Records written before the grace box existed carry no inFlightAt; treat
  // them as stale rather than locking the code out for the rest of its TTL.
  if (typeof code.inFlightAt !== 'number') {
    return true;
  }
  return (now - code.inFlightAt) >= DEVICE_CODE_IN_FLIGHT_GRACE;
}
