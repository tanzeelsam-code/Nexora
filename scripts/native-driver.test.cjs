"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const source = fs.readFileSync("frontend/native-driver.js", "utf8");
function fixture(t, native = true) {
  const dom = new JSDOM("", { runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const w = dom.window, sent = [];
  if (native) w.NexoraNative = { postMessage: raw => sent.push(JSON.parse(raw)) };
  w.eval(source);
  return { w, sent };
}
test("browser never exposes a native shift controller or starts tracking", t => {
  const { w } = fixture(t, false);
  assert.equal(w.NexoraDriverNative, undefined);
});
test("native commands are explicit, replies are correlated, and status never transmits credentials", async t => {
  const { w, sent } = fixture(t);
  assert.equal(sent.length, 0);
  const start = w.NexoraDriverNative.start("fixture-only-token");
  const status = w.NexoraDriverNative.status();
  assert.deepEqual(sent, [{ id: 1, command: "start", token: "fixture-only-token" }, { id: 2, command: "status" }]);
  w.NexoraNative.onmessage({ data: "malformed" });
  w.NexoraNative.onmessage({ data: JSON.stringify({ id: 999, running: true }) });
  w.NexoraNative.onmessage({ data: JSON.stringify({ id: 2, running: false }) });
  w.NexoraNative.onmessage({ data: JSON.stringify({ id: 1, starting: true }) });
  assert.equal((await start).starting, true);
  assert.equal((await status).running, false);
  const stop = w.NexoraDriverNative.stop();
  w.NexoraNative.onmessage({ data: JSON.stringify({ id: 3, error: "permission denied" }) });
  await assert.rejects(stop, /permission denied/);
  assert.equal(sent.length, 3);
});
test("an unconfirmed start times out without replaying the token", async t => {
  const { w, sent } = fixture(t);
  w.setTimeout = fn => setTimeout(fn, 1);
  await assert.rejects(w.NexoraDriverNative.start("fixture-only-token"), /did not confirm/);
  assert.equal(sent.length, 1);
  w.NexoraNative.onmessage({ data: JSON.stringify({ id: 1, running: true }) });
  assert.equal(sent.length, 1);
});

test("going offline during an outage stops local tracking and never restarts it on visibility change", async t => {
  const dom = new JSDOM(fs.readFileSync("frontend/driver.html", "utf8"), { url: "https://nexora.test/driver.html", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, calls = [], timers = new Map();
  let timerId = 0, stops = 0;
  w.HTMLCanvasElement.prototype.getContext = () => ({});
  w.fetch = async () => ({ json: async () => ({ checks: { database: "up" } }) });
  w.setInterval = (fn, interval) => { const id = ++timerId; timers.set(id, { fn, interval }); return id; };
  w.clearInterval = id => timers.delete(id);
  w.NexoraNotifications = { disable: async () => {} };
  w.NexoraDriverNative = { stop: async () => { stops++; }, status: async () => ({ running: false }) };
  w.NexoraSession = () => ({ api: async path => {
    calls.push(path);
    if (path === "/driver/status") throw new Error("connection lost");
    if (path === "/driver/jobs/current") return { trips: [], deliveries: [], driver: { is_online: true, onboarding_completed: true } };
    throw new Error("Unexpected request " + path);
  } });
  w.eval(fs.readFileSync("frontend/driver.js", "utf8"));
  await new Promise(resolve => setImmediate(resolve));
  w.sessionStorage.setItem("nexora_driver_token", "fixture-token");
  await w.loadJobs();
  assert.equal([...timers.values()].filter(x => x.interval === 15000).length, 1);
  await w.toggleOnline();
  assert.equal(stops, 1);
  assert.equal(w.sessionStorage.getItem("nexora_driver_tracking_paused"), "1");
  assert.equal([...timers.values()].filter(x => x.interval === 15000).length, 0);
  assert.match(w.document.getElementById("status-error").textContent, /Offline status was not confirmed/);
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.includes("/driver/location"), false);
  assert.equal([...timers.values()].filter(x => x.interval === 15000).length, 0);
});
