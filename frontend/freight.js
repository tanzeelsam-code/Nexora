(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const money = (value, currency = "USD") =>
    new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
      Number(value),
    );
  let quote,
    draft,
    timer,
    available = false,
    busy = false,
    version = 0,
    quoteVersion = 0,
    step = 1,
    bookingComplete = false,
    afterSignIn;
  let merchantProfile = null;
  let repeatLoaded = false,
    prefillLoaded = false,
    returnOf = null;
  const points = { pickup: null, dropoff: null },
    searchVersion = { pickup: 0, dropoff: 0 };
  const session = NexoraSession("nexora_customer", signedOut);
  const request = (path, body, headers) =>
    session.api(path, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body }),
      headers,
    });
  function showSignIn(action) {
    afterSignIn = typeof action === "function" ? action : null;
    if (!$("auth").open) $("auth").showModal();
  }
  function needsSignIn(action) {
    if (session.get("token")) return false;
    showSignIn(action);
    return true;
  }
  $("open-signin").onclick = () => showSignIn();
  $("close-signin").onclick = () => $("auth").close();
  $("create-account").onclick = () =>
    NexoraUI.drafts.save({
      service: "delivery",
      pickup: $("pickup-address").value,
      dropoff: $("dropoff-address").value,
    });
  function signedOut() {
    merchantProfile = null;
    $("use-merchant-pickup").hidden = true;
    $("save-merchant-pickup").hidden = true;
    $("merchant-pickup-status").textContent = "";
    clearInterval(timer);
    bookingComplete = false;
    document.querySelector(".freight-layout").hidden = false;
    $("delivery-steps").hidden = false;
    $("new-delivery").hidden = true;
    version++;
    invalidate();
    $("account-bar").hidden = true;
    $("history-section").hidden = true;
    $("open-signin").hidden = false;
    $("history").replaceChildren();
    setReturnMode(null);
    $("delivery").reset();
    for (const id of [
      "booking-message",
      "delivery-error",
      "history-error",
      "review-details",
    ])
      $(id).replaceChildren();
    for (const kind of ["pickup", "dropoff"]) {
      points[kind] = null;
      searchVersion[kind]++;
      $(kind + "-results").replaceChildren();
    }
    go(1, false);
    summary();
  }
  function dock() {
    const source =
      step === 1 ? $("to-details") : step === 2 ? $("estimate") : $("confirm");
    $("delivery-dock").hidden = $("auth").open || bookingComplete;
    $("dock-action").disabled = source.disabled;
    $("dock-action").textContent =
      step === 1
        ? "Continue →"
        : step === 2
          ? "Check fare →"
          : "Confirm delivery";
    $("dock-value").textContent =
      step === 3 && quote
        ? money(quote.price_estimate.total_fare, quote.price_estimate.currency)
        : step === 1
          ? "Choose your stops"
          : "Package & contacts";
    $("dock-label").textContent =
      step === 3 ? "Delivery fare" : "Your delivery";
  }
  function go(next, focus = true) {
    step = next;
    document
      .querySelectorAll("[data-panel]")
      .forEach((el) => (el.hidden = Number(el.dataset.panel) !== step));
    NexoraUI.stepper($("delivery-steps"), step);
    dock();
    if (focus)
      document
        .querySelector(`[data-panel="${step}"] h2`)
        .focus({ preventScroll: false });
  }
  function summary() {
    for (const kind of ["pickup", "dropoff"])
      $("summary-" + kind).textContent =
        $(kind + "-address").value ||
        (kind === "pickup" ? "Choose pickup" : "Choose destination");
  }
  function invalidate() {
    quoteVersion++;
    quote = null;
    draft = null;
    $("quote").hidden = true;
    dock();
  }
  async function task(button, status, fn) {
    button.disabled = true;
    dock();
    $(status).textContent = "";
    try {
      await fn();
    } catch (error) {
      $(status).textContent = error.message;
    } finally {
      button.disabled = false;
      dock();
    }
  }
  for (const kind of ["pickup", "dropoff"]) {
    $(kind + "-address").addEventListener("input", () => {
      points[kind] = null;
      searchVersion[kind]++;
      $(kind + "-results").replaceChildren();
      invalidate();
      summary();
    });
    $(kind + "-address").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        $("search-" + kind).click();
      }
    });
    $("search-" + kind).onclick = () =>
      task($("search-" + kind), "delivery-error", async () => {
        if (needsSignIn(() => $("search-" + kind).click())) return;
        const query = $(kind + "-address").value.trim();
        if (query.length < 3)
          throw new Error(
            "Enter at least 3 characters to search for an address.",
          );
        const sequence = ++searchVersion[kind];
        const { places } = await request(
          "/places/search?q=" + encodeURIComponent(query),
        );
        if (sequence !== searchVersion[kind]) return;
        $(kind + "-results").replaceChildren();
        for (const place of places) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "secondary";
          button.textContent = place.address;
          button.onclick = () => {
            points[kind] = place;
            $(kind + "-address").value = place.address;
            $(kind + "-results").replaceChildren();
            invalidate();
            summary();
          };
          $(kind + "-results").append(button);
        }
        if (!places.length)
          $(kind + "-results").textContent =
            "No addresses found. Try a nearby street or landmark.";
      });
  }
  $("delivery").addEventListener("input", invalidate);
  $("to-details").onclick = () =>
    task($("to-details"), "delivery-error", async () => {
      if (needsSignIn(() => $("to-details").click())) return;
      if (!points.pickup || !points.dropoff)
        throw new Error("Search and select both addresses first.");
      go(2);
    });
  document.querySelectorAll("[data-back]").forEach(
    (button) =>
      (button.onclick = () => {
        invalidate();
        $("delivery-error").textContent = "";
        go(Number(button.dataset.back));
      }),
  );
  $("delivery").addEventListener("submit", (event) => {
    event.preventDefault();
    if (step === 1) {
      $("to-details").click();
      return;
    }
    if (step !== 2) return;
    task($("estimate"), "delivery-error", async () => {
      if (!available)
        throw new Error(
          "New bookings are not available yet. You can still follow existing deliveries.",
        );
      const invalid = Array.from(
        document.querySelectorAll('[data-panel="2"] input'),
      ).find((input) => !input.checkValidity());
      if (invalid) {
        invalid.reportValidity();
        return;
      }
      if (!points.pickup || !points.dropoff) {
        go(1);
        throw new Error("Search and select both addresses first.");
      }
      const body = Object.fromEntries(new FormData($("delivery")));
      body.cod_amount = Number(body.cod_amount || 0);
      if (!body.merchant_order_ref?.trim()) delete body.merchant_order_ref;
      if (body.cod_amount > 0 && !body.merchant_order_ref)
        throw new Error("Enter an order reference for goods cash collection.");
      body.cargo_weight_kg = Number(body.cargo_weight_kg);
      body.is_fragile = $("delivery").elements.is_fragile.checked;
      if (returnOf) {
        body.return_of_delivery_id = returnOf;
        body.cod_amount = 0;
      }
      for (const kind of ["pickup", "dropoff"]) {
        body[kind + "_lat"] = points[kind].lat;
        body[kind + "_lng"] = points[kind].lng;
        body[kind + "_address"] = points[kind].address;
      }
      const sequence = ++quoteVersion;
      const result = await request("/deliveries/estimate", body);
      if (sequence !== quoteVersion) return;
      quote = result;
      draft = body;
      const price = quote.price_estimate;
      $("fare").textContent = money(price.total_fare, price.currency);
      $("quote-detail").textContent =
        `Quote valid until ${new Date(quote.expires_at).toLocaleTimeString()}. Recipient pays ${money(Number(price.total_fare) + body.cod_amount, price.currency)} in cash: delivery fee plus goods payment.`;
      const fields = [
        [
          "Order reference",
          body.merchant_order_ref ||
            (returnOf ? "Return pickup" : "Personal delivery"),
        ],
        ["Goods cash to collect", money(body.cod_amount, price.currency)],
        ["Delivery fee", money(price.total_fare, price.currency)],
        [
          "Total cash from recipient",
          money(Number(price.total_fare) + body.cod_amount, price.currency),
        ],
        ["Pickup", body.pickup_address],
        ["Destination", body.dropoff_address],
        [
          "Sender",
          body.pickup_contact_name + " · " + body.pickup_contact_phone,
        ],
        [
          "Recipient",
          body.dropoff_contact_name + " · " + body.dropoff_contact_phone,
        ],
        ["Package", body.cargo_description],
        [
          "Weight & handling",
          body.cargo_weight_kg +
            " kg" +
            (body.is_fragile ? " · Handle with care" : ""),
        ],
      ];
      $("review-details").innerHTML = fields
        .map(
          ([label, value]) =>
            `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`,
        )
        .join("");
      $("quote").hidden = false;
      go(3);
    });
  });
  $("confirm").onclick = () =>
    task($("confirm"), "delivery-error", async () => {
      if (!quote || Date.now() >= new Date(quote.expires_at).getTime()) {
        invalidate();
        go(2);
        throw new Error("Your quote expired. Please check the fare again.");
      }
      const body = { ...draft, quote_token: quote.quote_token };
      const serialized = JSON.stringify(body);
      let pending;
      try {
        pending = JSON.parse(session.get("pending_delivery"));
      } catch {}
      if (pending?.body !== serialized) {
        pending = { body: serialized, key: crypto.randomUUID() };
        session.set("pending_delivery", JSON.stringify(pending));
      }
      const { delivery } = await request("/deliveries", body, {
        "Idempotency-Key": pending.key,
      });
      session.set("pending_delivery", null);
      window.NexoraNetwork?.clearDrafts();
      invalidate();
      go(1, false);
      $("booking-message").textContent =
        `Delivery ${delivery.delivery_number} requested. Follow its progress and find your handoff PINs below.`;
      bookingComplete = true;
      document.querySelector(".freight-layout").hidden = true;
      $("delivery-steps").hidden = true;
      $("new-delivery").hidden = false;
      await history();
      $("history-section").scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  const labels = {
    pending: "Finding your driver",
    pickup_scheduled: "Pickup arranged",
    in_transit: "On the way",
    out_for_delivery: "Arriving soon",
    delivered: "Delivered",
    cancelled: "Cancelled",
    failed: "Delivery unsuccessful",
    returned: "Returned",
  };
  async function history() {
    if (busy) return;
    busy = true;
    const current = version;
    try {
      const { deliveries, offline } = await request("/deliveries");
      if (current !== version) return;
      $("history-error").textContent = "";
      $("history").innerHTML = deliveries.length
        ? deliveries
            .map((d) => {
              const active = ![
                "delivered",
                "cancelled",
                "failed",
                "returned",
              ].includes(d.status);
              const slug = String(d.tracking_url || "")
                .split("/")
                .pop();
              const track = /^[a-f0-9]{24}$/.test(slug)
                ? `<a class="button secondary" href="/track/${slug}">Track delivery →</a>`
                : "";
              return `<article class="history-card"><span class="trip-status">${esc(labels[d.status] || d.status.replace(/_/g, " "))}</span><div class="section-heading"><h3>${esc(d.delivery_number)}</h3><strong>${money(d.total_fare, d.currency)}</strong></div><div class="history-route"><div><small>FROM</small>${esc(d.pickup_address)}</div><div><small>TO</small>${esc(d.dropoff_address)}</div></div><p>${d.payment_status === "captured" ? "Paid in cash · Receipt " + esc("PAY-" + d.delivery_number) : active ? "Cash due from recipient on delivery" : "Payment status: " + esc(d.payment_status)}</p>${Number(d.cod_amount) > 0 ? `<p>Goods payment: ${esc(money(d.cod_amount, d.currency))} · ${d.cod_settled_at ? "Settled to merchant" : d.cod_received_at ? "Awaiting merchant settlement" : d.cod_collected_at ? "Collected by driver" : "Not collected"}. <a href="/merchant.html">Merchant desk</a></p>` : ""}${active ? `<dl class="ride-details"><div><dt>Pickup PIN</dt><dd>${esc(d.pickup_otp)}</dd></div><div><dt>Delivery PIN</dt><dd>${esc(d.dropoff_otp)}</dd></div></dl><p>Share each PIN only at its handoff.</p>` : ""}${d.dropoff_recipient_name ? `<p>Received by ${esc(d.dropoff_recipient_name)} on ${esc(new Date(d.delivered_at).toLocaleString())}</p>` : ""}${track}${["pending", "pickup_scheduled"].includes(d.status) ? ` <button type="button" class="text-button" data-cancel="${esc(d.id)}">Cancel delivery</button>` : ""}</article>`;
            })
            .join("")
        : '<div class="empty-history"><h3>Your first delivery starts here.</h3><p>Once you book, tracking updates and receipts will appear in this space.</p></div>';
      if (offline)
        $("history")
          .querySelectorAll("[data-cancel]")
          .forEach((button) => (button.disabled = true));
    } catch (error) {
      if (current === version) $("history-error").textContent = error.message;
    } finally {
      busy = false;
    }
  }
  $("history").onclick = async (event) => {
    const button = event.target.closest("[data-cancel]");
    if (!button) return;
    if (
      !(await NexoraUI.ask({
        title: "Cancel this delivery?",
        message:
          "This stops the pickup request. You can create a new delivery when you’re ready.",
        confirm: "Cancel delivery",
      }))
    )
      return;
    task(button, "history-error", async () => {
      await request("/deliveries/" + button.dataset.cancel + "/cancel", {});
      await history();
    });
  };
  $("new-delivery").onclick = () => {
    bookingComplete = false;
    setReturnMode(null);
    $("delivery").reset();
    invalidate();
    for (const kind of ["pickup", "dropoff"]) {
      points[kind] = null;
      $(kind + "-results").replaceChildren();
    }
    $("booking-message").textContent = "";
    document.querySelector(".freight-layout").hidden = false;
    $("delivery-steps").hidden = false;
    $("new-delivery").hidden = true;
    summary();
    go(1);
  };
  $("refresh").onclick = history;
  async function loadConfig() {
    try {
      const config = await request("/config");
      available = !!config.booking_available;
      setupPhoneSignIn(config);
      $("cod-currency").textContent =
        `Goods amount in ${config.currency || "PKR"}. Enter 0 if already paid. Delivery fees are separate.`;
    } catch {
      available = false;
    }
    dock();
  }
  async function start() {
    if ($("auth").open) $("auth").close();
    $("account-bar").hidden = false;
    $("history-section").hidden = false;
    $("open-signin").hidden = true;
    $("name").textContent = session.get("name") || "there";
    await loadConfig();
    await loadMerchant();
    await history();
    clearInterval(timer);
    timer = setInterval(() => {
      if (!document.hidden) history();
    }, 10000);
  }
  async function signedIn(data) {
    session.save(data);
    if (data.user.role !== "customer") {
      session.logout();
      throw new Error("Use your customer account to book a delivery.");
    }
    await start();
    const action = afterSignIn;
    afterSignIn = null;
    if (action) action();
  }
  function setupPhoneSignIn(config) {
    const box = $("phone-auth");
    if (!config?.phone_sign_in || !window.NexoraPhoneAuth || box.dataset.ready)
      return;
    box.dataset.ready = "true";
    NexoraPhoneAuth.mount(box, {
      request,
      role: "customer",
      country: config.country || "PK",
      onSignedIn: signedIn,
    });
    box.hidden = false;
    $("phone-divider").hidden = false;
  }
  $("login").onsubmit = (event) => {
    event.preventDefault();
    task($("login").querySelector("button"), "login-error", async () => {
      const data = await request(
        "/auth/login",
        Object.fromEntries(new FormData($("login"))),
      );
      if (data.user.role === "customer") $("login").reset();
      await signedIn(data);
    });
  };
  $("logout").onclick = () => {
    session.logout();
    signedOut();
  };
  $("dock-action").onclick = () => {
    if (step === 1) $("to-details").click();
    else if (step === 2) $("delivery").requestSubmit();
    else $("confirm").click();
  };
  new MutationObserver(dock).observe($("auth"), {
    attributes: true,
    attributeFilter: ["open"],
  });
  window.addEventListener("nexora:reconnected", () => {
    if (session.get("token")) start();
    else loadConfig();
  });
  async function loadMerchant() {
    const current = version;
    try {
      const { profile } = await request("/merchant/profile");
      if (current !== version) return;
      merchantProfile = profile;
      $("use-merchant-pickup").hidden = !profile?.pickup_address;
      $("save-merchant-pickup").hidden = !profile;
      const repeat = new URLSearchParams(location.search).get("repeat");
      if (repeat && !repeatLoaded && /^[a-f0-9-]{36}$/i.test(repeat)) {
        const result = await request("/deliveries/" + repeat);
        if (current !== version) return;
        const d = result.delivery;
        if (!d) return;
        repeatLoaded = true;
        for (const kind of ["pickup", "dropoff"]) {
          points[kind] = {
            address: d[kind + "_address"],
            lat: Number(d[kind + "_lat"]),
            lng: Number(d[kind + "_lng"]),
          };
          $(kind + "-address").value = points[kind].address;
          for (const field of ["contact_name", "contact_phone"])
            $("delivery").elements[kind + "_" + field].value =
              d[kind + "_" + field] || "";
        }
        for (const field of [
          "cargo_description",
          "cargo_weight_kg",
          "cod_amount",
        ])
          $("delivery").elements[field].value =
            d[field] || (field === "cod_amount" ? 0 : "");
        $("delivery").elements.is_fragile.checked = !!d.is_fragile;
        $("delivery").elements.merchant_order_ref.value = "";
        $("business-delivery-fields").open = true;
        invalidate();
        summary();
        $("delivery-error").textContent =
          "Previous details loaded. Check the contacts and goods amount, and enter a new order reference.";
      }
      await loadPrefill(current);
    } catch (error) {
      const params = new URLSearchParams(location.search);
      if (
        current === version &&
        ["repeat", "draft", "return"].some((key) => params.has(key))
      )
        $("delivery-error").textContent = error.message;
    }
  }
  function setReturnMode(id) {
    returnOf = id;
    const cod = $("delivery").elements.cod_amount;
    cod.disabled = !!id;
    if (id) cod.value = 0;
  }
  function fillContacts(kind, name, phone) {
    $("delivery").elements[kind + "_contact_name"].value = name || "";
    $("delivery").elements[kind + "_contact_phone"].value = phone || "";
  }
  function useMerchantPickup() {
    if (!merchantProfile?.pickup_address) return false;
    points.pickup = {
      address: merchantProfile.pickup_address,
      lat: Number(merchantProfile.pickup_lat),
      lng: Number(merchantProfile.pickup_lng),
    };
    $("pickup-address").value = points.pickup.address;
    fillContacts(
      "pickup",
      merchantProfile.pickup_contact_name,
      merchantProfile.pickup_contact_phone,
    );
    return true;
  }
  // Imported orders (?draft=) and return pickups (?return=) open the normal booking steps prefilled.
  async function loadPrefill(current) {
    const params = new URLSearchParams(location.search);
    const draftId = params.get("draft"),
      returnId = params.get("return");
    if (prefillLoaded) return;
    if (draftId && /^[a-f0-9-]{36}$/i.test(draftId)) {
      prefillLoaded = true;
      const { draft: order } = await request("/merchant/drafts/" + draftId);
      if (current !== version) return;
      if (order.delivery_id) {
        $("delivery-error").textContent =
          `Order ${order.order_ref} is already booked as ${order.delivery_number}.`;
        return;
      }
      const hasPickup = useMerchantPickup();
      fillContacts("dropoff", order.recipient_name, order.recipient_phone);
      const form = $("delivery").elements;
      form.cargo_description.value = order.cargo_description;
      form.cargo_weight_kg.value = Number(order.cargo_weight_kg);
      form.cod_amount.value = Number(order.cod_amount);
      form.merchant_order_ref.value = order.order_ref;
      form.is_fragile.checked = !!order.is_fragile;
      $("business-delivery-fields").open = true;
      $("dropoff-address").value = order.address;
      if (order.lat !== null && order.lng !== null)
        points.dropoff = {
          address: order.address,
          lat: Number(order.lat),
          lng: Number(order.lng),
        };
      invalidate();
      summary();
      $("delivery-error").textContent =
        `Imported order ${order.order_ref} loaded. ` +
        (points.dropoff
          ? "Check the location, then continue."
          : "Choose the recipient's address from the search results, then continue.") +
        (hasPickup ? "" : " Choose your pickup address too.");
      if (!points.dropoff) $("search-dropoff").click();
    } else if (returnId && /^[a-f0-9-]{36}$/i.test(returnId)) {
      prefillLoaded = true;
      const { delivery: d } = await request("/deliveries/" + returnId);
      if (current !== version) return;
      if (d.status !== "delivered") {
        $("delivery-error").textContent =
          "Returns can be booked only for delivered parcels.";
        return;
      }
      // The parcel travels back: the original destination becomes the pickup.
      const swap = { pickup: "dropoff", dropoff: "pickup" };
      for (const kind of ["pickup", "dropoff"]) {
        const from = swap[kind];
        points[kind] = {
          address: d[from + "_address"],
          lat: Number(d[from + "_lat"]),
          lng: Number(d[from + "_lng"]),
        };
        $(kind + "-address").value = points[kind].address;
        fillContacts(kind, d[from + "_contact_name"], d[from + "_contact_phone"]);
      }
      const form = $("delivery").elements;
      form.cargo_description.value = ("Return: " + d.cargo_description).slice(0, 500);
      form.cargo_weight_kg.value = Number(d.cargo_weight_kg);
      form.is_fragile.checked = !!d.is_fragile;
      form.merchant_order_ref.value = "";
      setReturnMode(returnId);
      $("business-delivery-fields").open = true;
      invalidate();
      summary();
      $("delivery-error").textContent =
        `Return pickup for ${d.merchant_order_ref || d.delivery_number}: from the recipient back to you. No goods payment is collected; the return fee is paid in cash when the parcel reaches you.`;
    }
  }
  $("use-merchant-pickup").onclick = () => {
    if (!merchantProfile?.pickup_address) return;
    points.pickup = {
      address: merchantProfile.pickup_address,
      lat: Number(merchantProfile.pickup_lat),
      lng: Number(merchantProfile.pickup_lng),
    };
    $("pickup-address").value = points.pickup.address;
    for (const field of ["pickup_contact_name", "pickup_contact_phone"])
      $("delivery").elements[field].value = merchantProfile[field];
    searchVersion.pickup++;
    $("pickup-results").replaceChildren();
    invalidate();
    summary();
  };
  $("save-merchant-pickup").onclick = () =>
    task($("save-merchant-pickup"), "merchant-pickup-status", async () => {
      if (!points.pickup || !merchantProfile)
        throw new Error(
          "Select a pickup address and create a business profile first.",
        );
      const pickup = {
        pickup_address: points.pickup.address,
        pickup_lat: points.pickup.lat,
        pickup_lng: points.pickup.lng,
        pickup_contact_name: $("delivery").elements.pickup_contact_name.value,
        pickup_contact_phone: $("delivery").elements.pickup_contact_phone.value,
      };
      const result = await request("/merchant/profile", {
        business_name: merchantProfile.business_name,
        pickup,
      });
      merchantProfile = result.profile;
      $("use-merchant-pickup").hidden = false;
      $("merchant-pickup-status").textContent = "Business pickup saved.";
    });
  if (new URLSearchParams(location.search).has("business"))
    $("business-delivery-fields").open = true;
  const saved = NexoraUI.drafts.take("delivery");
  if (saved) {
    $("pickup-address").value = saved.pickup;
    $("dropoff-address").value = saved.dropoff;
  }
  summary();
  dock();
  if (session.get("token")) start();
  else loadConfig();
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && !session.get("token")) signedOut();
  });
})();
