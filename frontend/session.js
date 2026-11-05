/* Shared customer/driver authentication with refresh coalescing and sign-out guards. */
(() => {
  "use strict";
  window.NexoraSession = function (prefix, onExpired = () => {}) {
    const get = (key) => sessionStorage.getItem(prefix + "_" + key);
    const set = (key, value) =>
      value == null
        ? sessionStorage.removeItem(prefix + "_" + key)
        : sessionStorage.setItem(prefix + "_" + key, value);
    let generation = 0,
      refreshPromise;
    function clear() {
      generation++;
      refreshPromise = null;
      window.NexoraNetwork?.clear();
      [
        "token",
        "refresh",
        "name",
        "trip",
        "pending_booking",
        "pending_delivery",
        "offline_cache",
        "user_id",
      ].forEach((k) => set(k, null));
    }
    function revoke(token, refresh) {
      if (!token) return;
      fetch("/api/v1/auth/logout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({ refresh_token: refresh }),
        keepalive: true,
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
    function save(data) {
      set("offline_cache", null);
      generation++;
      refreshPromise = null;
      set("token", data.token);
      set("refresh", data.refresh_token);
      set("user_id", data.user.id || null);
      set(
        "name",
        [data.user.first_name, data.user.last_name].filter(Boolean).join(" "),
      );
    }
    async function api(path, options = {}, retry = true) {
      const version = generation;
      const read = !options.method || options.method === "GET";
      const cacheable =
        read &&
        get("token") &&
        (/^\/trips(?:\/[a-f0-9-]{36})?$/.test(path) ||
          path === "/deliveries" ||
          path === "/driver/jobs/current");
      const snapshot = () => {
        if (!cacheable || version !== generation) return null;
        try {
          const item = JSON.parse(get("offline_cache") || "{}")[path];
          if (!item || item.expires < Date.now()) return null;
          window.NexoraNetwork?.stale(path, item.saved);
          return { ...item.data, offline: true, saved_at: item.saved };
        } catch {
          return null;
        }
      };
      let res;
      try {
        res = await (window.NexoraNetwork?.request || fetch)("/api/v1" + path, {
          ...options,
          body:
            options.body === undefined
              ? undefined
              : typeof options.body === "string"
                ? options.body
                : JSON.stringify(options.body),
          headers: {
            "Content-Type": "application/json",
            ...(get("token")
              ? { Authorization: "Bearer " + get("token") }
              : {}),
            ...options.headers,
          },
          signal: options.signal || AbortSignal.timeout(20000),
        });
      } catch (err) {
        const saved = snapshot();
        if (
          saved &&
          (err.code === "network_unavailable" ||
            err.name === "TypeError" ||
            err.name === "TimeoutError")
        )
          return saved;
        throw err;
      }
      const data = await res.json().catch(() => ({
        error: "The service returned an unexpected response.",
      }));
      if (version !== generation) {
        if (path.startsWith("/auth/") && data.token)
          revoke(data.token, data.refresh_token);
        throw Object.assign(new Error("This session has ended."), {
          status: 401,
        });
      }
      if ([502, 503, 504].includes(res.status)) {
        const saved = snapshot();
        if (saved) return saved;
      }
      if (res.status === 401 && !path.startsWith("/auth/")) {
        if (retry && get("refresh")) {
          try {
            if (!refreshPromise) {
              const promise = api(
                "/auth/refresh",
                { method: "POST", body: { refresh_token: get("refresh") } },
                false,
              )
                .then((fresh) => {
                  if (version !== generation) {
                    revoke(fresh.token, fresh.refresh_token);
                    throw Object.assign(new Error("Session ended"), {
                      status: 401,
                    });
                  }
                  set("token", fresh.token);
                  set("refresh", fresh.refresh_token);
                })
                .finally(() => {
                  if (refreshPromise === promise) refreshPromise = null;
                });
              refreshPromise = promise;
            }
            await refreshPromise;
          } catch (err) {
            if (version === generation && [401, 403].includes(err.status)) {
              clear();
              onExpired();
            }
            throw err;
          }
          if (version !== generation)
            throw Object.assign(new Error("Session ended"), { status: 401 });
          return api(path, options, false);
        }
        clear();
        onExpired();
      }
      if (!res.ok)
        throw Object.assign(
          new Error(
            Object.values(data.details?.fieldErrors || {})
              .flat()
              .join(" ") ||
              data.error ||
              "Request failed",
          ),
          { status: res.status },
        );
      window.NexoraNetwork?.fresh(path);
      if (cacheable) {
        try {
          const cache = JSON.parse(get("offline_cache") || "{}");
          for (const key of Object.keys(cache))
            if (cache[key].expires < Date.now()) delete cache[key];
          const now = Date.now();
          cache[path] = { data, saved: now, expires: now + 2 * 60 * 60 * 1000 };
          // Bound storage; credentials never enter these response snapshots.
          const entries = Object.entries(cache)
            .sort((a, b) => b[1].saved - a[1].saved)
            .slice(0, 8);
          set("offline_cache", JSON.stringify(Object.fromEntries(entries)));
        } catch {
          /* A full device must not prevent online booking. */
        }
      }
      return data;
    }
    function logout() {
      const token = get("token"),
        refresh = get("refresh");
      clear();
      revoke(token, refresh);
    }
    return { api, get, set, save, clear, logout };
  };
})();
