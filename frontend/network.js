/* Connectivity recovery never queues bookings, payments, PINs or driver actions. */
(() => {
  "use strict";
  const stale = new Map();
  let disconnected = navigator.onLine === false;
  let notice;
  function render() {
    if (!document.body) return;
    if (!notice) {
      notice = document.createElement("aside");
      notice.className = "connection-notice";
      notice.setAttribute("role", "status");
      notice.setAttribute("aria-live", "polite");
      document.body.prepend(notice);
    }
    notice.hidden = !disconnected && !stale.size;
    notice.textContent = disconnected
      ? "Connection interrupted. Your entries stay on this device. Bookings and driver actions need a connection and server confirmation."
      : stale.size
        ? "Showing saved details from " +
          new Date(Math.min(...stale.values())).toLocaleTimeString() +
          ". These are not live updates. Reconnecting…"
        : "";
    document.documentElement.classList.toggle(
      "connection-interrupted",
      disconnected || !!stale.size,
    );
  }
  function networkError(sent) {
    return Object.assign(
      new Error(
        sent
          ? "Connection lost. This action may have reached Nexora. Reconnect and check the latest status before retrying."
          : "You are offline. Reconnect to confirm this action. Your entries have been kept.",
      ),
      { code: "network_unavailable" },
    );
  }
  async function request(url, options = {}) {
    const read = !options.method || options.method.toUpperCase() === "GET";
    if (navigator.onLine === false) {
      disconnected = true;
      render();
      throw networkError(false);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(url, {
          ...options,
          signal: options.signal || AbortSignal.timeout(15000),
        });
        if ([502, 503, 504].includes(response.status)) {
          if (read && attempt === 0 && !options.signal?.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 600));
            continue;
          }
          disconnected = true;
          render();
        } else {
          disconnected = false;
          render();
        }
        return response;
      } catch (error) {
        if (
          options.signal?.aborted &&
          options.signal.reason?.name !== "TimeoutError"
        )
          throw error;
        if (
          read &&
          attempt === 0 &&
          navigator.onLine !== false &&
          !options.signal?.aborted
        ) {
          await new Promise((resolve) => setTimeout(resolve, 600));
          continue;
        }
        disconnected = true;
        render();
        throw networkError(!read);
      }
    }
  }
  const draftPrefix = "nexora_form_";
  function clearDrafts() {
    try {
      Object.keys(sessionStorage)
        .filter((key) => key.startsWith(draftPrefix))
        .forEach((key) => sessionStorage.removeItem(key));
    } catch {
      /* Private browsing may disable storage. */
    }
  }
  function setup() {
    render();
    // Only planning forms are eligible: never authentication, PIN, payout or card inputs.
    for (const id of ["start-journey", "ride", "delivery"]) {
      const form = document.getElementById(id);
      if (!form) continue;
      const key = draftPrefix + id;
      const fields = () =>
        [...form.querySelectorAll("input, textarea, select")].filter(
          (field) =>
            (field.id || field.name) &&
            !["password", "hidden", "file"].includes(field.type),
        );
      try {
        const draft = JSON.parse(sessionStorage.getItem(key));
        if (draft?.expires > Date.now())
          for (const field of fields()) {
            const value = draft.values[field.id || field.name];
            if (value == null) continue;
            if (field.type === "checkbox") field.checked = value === true;
            else if (!field.value) field.value = String(value);
            field.dispatchEvent(new Event("input", { bubbles: true }));
          }
        else sessionStorage.removeItem(key);
      } catch {
        /* Ignore an expired or malformed draft. */
      }
      form.addEventListener("input", () => {
        const values = Object.fromEntries(
          fields().map((field) => [
            field.id || field.name,
            field.type === "checkbox"
              ? field.checked
              : field.value.slice(0, 500),
          ]),
        );
        try {
          sessionStorage.setItem(
            key,
            JSON.stringify({ values, expires: Date.now() + 1800000 }),
          );
        } catch {}
      });
      form.addEventListener("reset", () => {
        try {
          sessionStorage.removeItem(key);
        } catch {}
      });
    }
    if ("serviceWorker" in navigator && window.isSecureContext)
      navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  window.addEventListener("offline", () => {
    disconnected = true;
    render();
  });
  window.addEventListener("online", () => {
    // A network interface returning does not prove that Nexora can be reached.
    window.dispatchEvent(new Event("nexora:reconnected"));
    request("/api/v1/config", { cache: "no-store" }).catch(() => {});
  });
  window.NexoraNetwork = {
    request,
    clearDrafts,
    stale(path, saved) {
      stale.set(path, saved);
      render();
    },
    fresh(path) {
      stale.delete(path);
      render();
    },
    clear() {
      stale.clear();
      clearDrafts();
      render();
    },
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", setup, { once: true });
  else setup();
})();
