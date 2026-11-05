"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const code = (name) => fs.readFileSync("frontend/" + name + ".js", "utf8");
const response = (status, data) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => data,
});
function browser(t, fetch, html = "") {
  const dom = new JSDOM(html, {
    url: "https://nexora.test/customer",
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.fetch = fetch;
  w.AbortSignal = AbortSignal;
  w.setTimeout = (fn) => setTimeout(fn, 0);
  w.eval(code("network"));
  w.eval(code("session"));
  return w;
}
test("reads retry once; mutations and aborts are never automatically replayed", async (t) => {
  let calls = 0;
  const w = browser(t, async () => {
    calls++;
    throw new TypeError("lost");
  });
  await assert.rejects(w.NexoraNetwork.request("/api/v1/config"), {
    code: "network_unavailable",
  });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    w.NexoraNetwork.request("/api/v1/trips", { method: "POST" }),
    /may have reached/,
  );
  assert.equal(calls, 1);
  calls = 0;
  const signal = AbortSignal.abort(new Error("cancelled"));
  await assert.rejects(w.NexoraNetwork.request("/api/v1/config", { signal }));
  assert.equal(calls, 1);
});
test("offline writes are blocked and a returning network never replays a booking", async (t) => {
  const calls = [];
  const w = browser(t, async (url, opts) => {
    calls.push([url, opts.method]);
    return response(200, {});
  });
  Object.defineProperty(w.navigator, "onLine", {
    value: false,
    configurable: true,
  });
  await assert.rejects(
    w.NexoraNetwork.request("/api/v1/trips", { method: "POST" }),
    /offline/,
  );
  assert.equal(calls.length, 0);
  Object.defineProperty(w.navigator, "onLine", { value: true });
  w.dispatchEvent(new w.Event("online"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [["/api/v1/config", undefined]]);
});
test("service outages retry reads only and use no more than two attempts", async (t) => {
  let calls = 0;
  const w = browser(t, async () => {
    calls++;
    return response(503, {});
  });
  assert.equal((await w.NexoraNetwork.request("/api/v1/trips")).status, 503);
  assert.equal(calls, 2);
  calls = 0;
  await w.NexoraNetwork.request("/api/v1/trips", { method: "POST" });
  assert.equal(calls, 1);
});
test("recent account snapshots are labeled stale, expire, and are purged on account change", async (t) => {
  let offline = false;
  const w = browser(t, async () => {
    if (offline) throw new TypeError("offline");
    return response(200, { trips: [{ id: "private" }] });
  });
  const s = w.NexoraSession("test");
  s.save({
    token: "token",
    refresh_token: "refresh",
    user: { id: "a", first_name: "A" },
  });
  await s.api("/trips");
  offline = true;
  const saved = await s.api("/trips");
  assert.equal(saved.offline, true);
  assert.equal(saved.trips[0].id, "private");
  assert.match(
    w.document.querySelector(".connection-notice").textContent,
    /Connection interrupted|saved details/,
  );
  const cache = JSON.parse(s.get("offline_cache"));
  cache["/trips"].expires = Date.now() - 1;
  s.set("offline_cache", JSON.stringify(cache));
  await assert.rejects(s.api("/trips"));
  s.save({ token: "b", user: { id: "b" } });
  assert.equal(s.get("offline_cache"), null);
  await assert.rejects(s.api("/trips"));
  s.clear();
  assert.equal(s.get("token"), null);
  assert.equal(s.get("offline_cache"), null);
});
test("a failed mutation cannot consume a cached GET or store its response", async (t) => {
  let fail = false;
  const w = browser(t, async () => {
    if (fail) throw new TypeError("lost");
    return response(200, { trips: [] });
  });
  const s = w.NexoraSession("test");
  s.save({ token: "a", user: { id: "a" } });
  await s.api("/trips");
  fail = true;
  await assert.rejects(
    s.api("/trips", { method: "POST", body: {} }),
    /may have reached/,
  );
  assert.deepEqual(Object.keys(JSON.parse(s.get("offline_cache"))), ["/trips"]);
});
test("planning drafts survive reload, exclude credentials and are cleared on sign out", async (t) => {
  const w = browser(
    t,
    async () => response(200, {}),
    '<form id="ride"><input id="pickup"><input id="secret" type="password"><input id="pin" type="hidden"></form><form id="login"><input id="email"></form>',
  );
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  w.document.getElementById("pickup").value = "Saved address";
  w.document.getElementById("secret").value = "never-save";
  w.document
    .getElementById("ride")
    .dispatchEvent(new w.Event("input", { bubbles: true }));
  const draft = JSON.parse(w.sessionStorage.getItem("nexora_form_ride"));
  assert.equal(draft.values.pickup, "Saved address");
  assert.equal(draft.values.secret, undefined);
  assert.equal(draft.values.pin, undefined);
  assert.equal(w.sessionStorage.getItem("nexora_form_login"), null);
  w.document.getElementById("pickup").value = "";
  w.eval(code("network"));
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  assert.equal(w.document.getElementById("pickup").value, "Saved address");
  w.NexoraSession("test").clear();
  assert.equal(w.sessionStorage.getItem("nexora_form_ride"), null);
});
test("service worker never intercepts API data, maps, cross-origin resources or mutations", async () => {
  const handlers = {};
  const context = {
    self: {
      location: { origin: "https://nexora.test" },
      addEventListener: (name, fn) => (handlers[name] = fn),
    },
    URL,
    Response,
  };
  vm.runInNewContext(code("sw"), context);
  for (const [url, method] of [
    ["https://nexora.test/api/v1/trips", "GET"],
    ["https://maps.test/tiles/1", "GET"],
    ["https://nexora.test/customer", "POST"],
    ["https://foreign.test/customer", "GET"],
    ["https://nexora.test/delete-account", "GET"],
  ]) {
    let intercepted = false;
    handlers.fetch({
      request: { url, method },
      respondWith() {
        intercepted = true;
      },
    });
    assert.equal(intercepted, false, url);
  }
});
test("service worker returns a cached public shell when the connection fails", async () => {
  const handlers = {};
  const cached = new Response("saved shell");
  const context = {
    self: {
      location: { origin: "https://nexora.test" },
      addEventListener: (name, fn) => (handlers[name] = fn),
    },
    URL,
    Response,
    fetch: async () => {
      throw new TypeError("offline");
    },
    caches: {
      open: async () => ({
        match: async (path) => (path === "/driver.html" ? cached : undefined),
      }),
    },
  };
  vm.runInNewContext(code("sw"), context);
  let result;
  handlers.fetch({
    request: {
      url: "https://nexora.test/driver",
      method: "GET",
      mode: "navigate",
    },
    respondWith(p) {
      result = p;
    },
  });
  assert.equal(await (await result).text(), "saved shell");
});
