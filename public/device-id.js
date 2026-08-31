// public/device-id.js
// A persistent, random identifier for this specific browser/app install -
// NOT fingerprinting (no canvas, no hardware signals, nothing derived
// from the device itself). Just a random ID generated once and stored in
// localStorage, conceptually the same as a "remember this device" cookie.
// Used to support device registration for the operational roles - see
// lib/deviceAuth.js for the actual approval logic, which lives entirely
// server-side; this file only generates and remembers the ID.

const DeviceId = (() => {
  const KEY = 'kegTracker.deviceId';

  function get() {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : ('dev-' + Date.now() + '-' + Math.random().toString(36).slice(2)));
      localStorage.setItem(KEY, id);
    }
    return id;
  }

  return { get };
})();
