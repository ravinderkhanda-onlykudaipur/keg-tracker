// public/offline-queue-v2.js
// v2 equivalent of offline-queue.js - adapted for v2's endpoint shape
// (transitionId + details, posted to either /initiate or /execute
// depending on whether the transition is two-scan) rather than v1's
// single /events endpoint with actionType. Kept as a separate file
// rather than modifying offline-queue.js itself, since v1's file is
// frozen reference at this point (see lib/v2/DATA_MODEL.md's clean
// cutover note) and scan.html no longer loads it at all.
//
// Same design choice as v1's version: only one pending action per keg
// at a time. Chaining several offline actions on the same keg would
// need client-side state-machine validation to give correct optimistic
// feedback, which duplicates the transition engine and risks drifting
// out of sync with it - not worth the complexity for what's genuinely
// a rare case (a user with no signal logging one action).

const OfflineQueueV2 = (() => {
  const QUEUE_KEY = 'kegTracker.v2.pendingActions';

  function getQueue() {
    try {
      return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    } catch {
      return [];
    }
  }

  function saveQueue(queue) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  }

  function canQueueFor(kegId) {
    return !getQueue().some((item) => item.kegId === kegId);
  }

  function enqueue({ kegId, transitionId, twoScan, endpoint, details }) {
    const queue = getQueue();
    const item = {
      id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      kegId, transitionId, twoScan, endpoint, details,
      queuedAt: new Date().toISOString(),
    };
    queue.push(item);
    saveQueue(queue);
    return item;
  }

  function removeById(id) {
    saveQueue(getQueue().filter((q) => q.id !== id));
  }

  function pendingFor(kegId) {
    return getQueue().find((q) => q.kegId === kegId) || null;
  }

  function count() {
    return getQueue().length;
  }

  // Same stop-on-network-failure, continue-past-rejection behavior as
  // v1's version - see that file's own comment for the full reasoning.
  async function syncAll() {
    const queue = getQueue();
    const outcome = { synced: [], rejected: [], stillOffline: false };

    for (const item of queue) {
      // endpoint is 'confirm' for a bare confirm-receipt action (no
      // transitionId/details needed), otherwise 'initiate' or 'execute'
      // with the transition body - matches exactly what submitAction()/
      // submitConfirm() send when actually online.
      const url = `/api/v2/kegs/${item.kegId}/${item.endpoint}`;
      const body = item.endpoint === 'confirm' ? undefined : JSON.stringify({ transitionId: item.transitionId, details: item.details });

      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: body ? { 'Content-Type': 'application/json' } : {},
          credentials: 'include',
          cache: 'no-store',
          body,
        });
      } catch (err) {
        outcome.stillOffline = true;
        break; // genuinely offline - leave remaining items queued, try again later
      }

      if (res.ok) {
        removeById(item.id);
        outcome.synced.push(item);
      } else {
        const data = await res.json().catch(() => ({}));
        outcome.rejected.push({ item, error: data.error || `HTTP ${res.status}` });
        // Left queued rather than silently dropped - a rejection (e.g.
        // someone else already moved the keg) needs a human to see it.
      }
    }
    return outcome;
  }

  return { enqueue, removeById, pendingFor, canQueueFor, count, syncAll };
})();
