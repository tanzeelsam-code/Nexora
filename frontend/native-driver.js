/* Native bridge is injected only into the exact app origin; Java rejects subframes. */
(() => {
  "use strict";
  if (!window.NexoraNative?.postMessage) return;
  let sequence = 0;
  const pending = new Map();
  NexoraNative.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data),
        entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.error) entry.reject(new Error(data.error));
      else entry.resolve(data);
    } catch {
      /* Ignore malformed native messages. */
    }
  };
  function call(command, token) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            "Android did not confirm background updates. Keep Nexora open and try again.",
          ),
        );
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      NexoraNative.postMessage(
        JSON.stringify({ id, command, ...(token ? { token } : {}) }),
      );
    });
  }
  window.NexoraDriverNative = {
    start: (token) => call("start", token),
    stop: () => call("stop"),
    status: () => call("status"),
  };
})();
