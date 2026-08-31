// public/offline-queue.js
// Handles the "no signal" case for scan.html: if submitting an event
// fails due to no connectivity, queue it in localStorage instead of
// losing the work, then sync automatically once the connection returns.
//
// Deliberately simple for the MVP: only one pending action per keg is
// allowed at a time (see canQueueFor below). Chaining several offline
// actions on the same keg (e.g. wash then fill, both offline) would need
// client-side state-machine validation to give correct optimistic
// feedback, which duplicates server logic and risks drifting out of sync
// with it - not worth the complexity yet. One pending action per keg
// covers the realistic case (a driver logging one delivery with no
// signal), and keeps "what will happen when this syncs" unambiguous.

const OfflineQueue = (() => {
  const QUEUE_KEY = 'kegTracker.pendingEvents';
  const KEG_CACHE_PREFIX = 'kegTracker.lastKnown.';

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

  function enqueue({ kegId, actionType, details }) {
    const queue = getQueue();
    const item = {
      id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      kegId, actionType, details,
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

  // Attempts to push every queued event to the server, in the order they
  // were queued. Stops at the first network failure (still offline) but
  // keeps going past a *server-rejected* item (e.g. someone else already
  // moved the keg) so one stale item doesn't block everything else.
  async function syncAll() {
    const queue = getQueue();
    const outcome = { synced: [], rejected: [], stillOffline: false };

    for (const item of queue) {
      let res;
      try {
        res = await fetch(`/api/kegs/${item.kegId}/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ actionType: item.actionType, details: item.details }),
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
        // Leave it queued - a rejection needs a human to look at it, not
        // a silent drop. The scan.html UI shows the error and offers a
        // "Discard" button that calls removeById(item.id) directly, so
        // the item doesn't get stuck here forever with no way out.
      }
    }
    return outcome;
  }

  function cacheKeg(keg) {
    localStorage.setItem(KEG_CACHE_PREFIX + keg.id, JSON.stringify(keg));
  }

  function getCachedKeg(kegId) {
    try {
      return JSON.parse(localStorage.getItem(KEG_CACHE_PREFIX + kegId) || 'null');
    } catch {
      return null;
    }
  }

  return { enqueue, removeById, pendingFor, canQueueFor, count, syncAll, cacheKeg, getCachedKeg };
})();
