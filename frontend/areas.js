(() => {
  "use strict";
  const root = document.querySelector("[data-area-checker]");
  if (!root) return;
  root.innerHTML = `<h3>Check your area before signing in</h3><p>Choose a locality and service. Both stops must be within the service area.</p>
    <form id="area-check"><div class="business-form"><label>Service area<select id="area-choice" required><option value="">Loading areas…</option></select></label><label>Service<select id="area-service"><option value="ride">Ride</option><option value="delivery">Delivery</option></select></label></div><button style="margin-top:16px" id="area-submit">Check availability</button></form>
    <div class="area-result" id="area-result" role="status">Checking service areas…</div><a id="area-book" class="button" hidden>Continue to booking →</a>
    <details id="area-interest"><summary>Not available near you? Register your interest</summary><form id="area-waitlist"><label>Your town or locality<input name="locality" minlength="2" maxlength="100" required autocomplete="address-level2"></label><label>Email<input name="email" type="email" maxlength="255" required autocomplete="email"></label><label>Interested in<select name="service"><option value="ride">Rides</option><option value="delivery">Deliveries</option></select></label><label class="check-label"><input name="consent" type="checkbox" required><span>I agree to receive availability emails for this area. I can request removal through support.</span></label><p class="help-copy">This records interest, not a reservation. Read our <a href="/privacy.html">privacy information</a>.</p><button>Register interest</button><p id="waitlist-result" role="status"></p></form></details>`;
  const $ = (id) => document.getElementById(id);
  let areas = [],
    sequence = 0;
  async function request(path, body) {
    const r = await (window.NexoraNetwork?.request || fetch)("/api/v1" + path, {
      method: body ? "POST" : "GET",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Could not check availability.");
    return data;
  }
  function reset() {
    sequence++;
    $("area-book").hidden = true;
    $("area-result").textContent = "Check again for current availability.";
  }
  async function load() {
    reset();
    $("area-submit").disabled = true;
    try {
      const data = await request("/areas");
      areas = data.areas;
      $("area-choice").replaceChildren(new Option("Choose your area", ""));
      for (const area of areas)
        $("area-choice").add(new Option(area.name, area.id));
      $("area-result").textContent = areas.length
        ? "Select an area to see its hours and current availability."
        : "No service areas have been announced yet. Register your locality below.";
      $("area-submit").disabled = !areas.length;
      $("area-choice").disabled = !areas.length;
    } catch (e) {
      $("area-result").textContent =
        e.message + " Please reconnect and refresh.";
      $("area-choice").replaceChildren(new Option("Areas unavailable", ""));
    }
  }
  $("area-choice").onchange = () => {
    reset();
    const a = areas.find((a) => a.id === $("area-choice").value);
    if (a) $("area-waitlist").elements.locality.value = a.name;
  };
  $("area-service").onchange = reset;
  $("area-check").onsubmit = async (event) => {
    event.preventDefault();
    reset();
    const current = sequence;
    $("area-submit").disabled = true;
    $("area-result").textContent = "Checking nearby availability…";
    try {
      const data = await request(
        "/availability?area_id=" +
          encodeURIComponent($("area-choice").value) +
          "&service=" +
          $("area-service").value,
      );
      if (current !== sequence) return;
      const labels = {
        available: "Drivers nearby · bookings open",
        no_drivers: "Open, but no drivers are available nearby",
        closed: "Outside service hours",
        paused: "Service temporarily paused",
        not_launched: "This service has not launched here",
        setup_pending: "Bookings have not opened yet",
      };
      const time = (n) =>
        String(Math.floor(n / 60)).padStart(2, "0") +
        ":" +
        String(n % 60).padStart(2, "0");
      const days = data.area.weekdays
        .map((n) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][n])
        .join(", ");
      $("area-result").replaceChildren();
      const title = document.createElement("strong");
      title.textContent = labels[data.status] || "Availability unknown";
      const detail = document.createElement("p");
      detail.textContent = `${data.area.name} · within ${data.area.radius_km} km of its centre. ${days}, ${time(data.area.opens_minute)}–${time(data.area.closes_minute)} (${data.timezone}).`;
      const note = document.createElement("small");
      note.textContent = `Checked ${new Date(data.checked_at).toLocaleTimeString()}. ${data.message}`;
      $("area-result").append(title, detail, note);
      if (data.status === "available") {
        $("area-book").href =
          data.service === "ride" ? "/customer.html" : "/freight.html";
        $("area-book").hidden = false;
      }
    } catch (e) {
      if (current === sequence) $("area-result").textContent = e.message;
    } finally {
      $("area-submit").disabled = !areas.length;
    }
  };
  $("area-waitlist").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      button = form.querySelector("button");
    button.disabled = true;
    $("waitlist-result").textContent = "";
    try {
      const data = await request("/area-waitlist", {
        ...Object.fromEntries(new FormData(form)),
        consent: form.elements.consent.checked,
      });
      $("waitlist-result").textContent = data.message;
      form.elements.email.value = "";
      form.elements.consent.checked = false;
    } catch (e) {
      $("waitlist-result").textContent = e.message;
    } finally {
      button.disabled = false;
    }
  };
  window.addEventListener("offline", () => {
    reset();
    $("area-result").textContent =
      "You are offline. Reconnect to check current availability.";
  });
  window.addEventListener("nexora:reconnected", load);
  load();
})();
