(() => {
  "use strict";
  const $ = (id) => document.getElementById(id),
    esc = (value) =>
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
  const money = (n, c) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: c }).format(
      Number(n || 0),
    );
  let page = 1,
    sequence = 0,
    statement = null;
  const csvCell = (value) => {
    let text = String(value ?? "");
    // Stop spreadsheet apps from treating a value as a formula.
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  function downloadCsv(name, rows) {
    const blob = new Blob(
      ["\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n")],
      { type: "text/csv;charset=utf-8" },
    );
    const link = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob),
      download: name,
    });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  function signedOut() {
    sequence++;
    $("merchant-auth").hidden = false;
    $("phone-auth").hidden = !$("phone-auth").dataset.ready;
    $("merchant-desk").hidden = true;
    $("merchant-logout").hidden = true;
    $("merchant-orders").replaceChildren();
    $("merchant-balances").replaceChildren();
    $("merchant-profile").reset();
    $("saved-pickup").textContent = "";
    $("profile-status").textContent = "";
    $("new-order").hidden = true;
    $("merchant-drafts").replaceChildren();
    $("import-results").replaceChildren();
    $("import-status").textContent = "";
    $("statement-totals").replaceChildren();
    $("statement-status").textContent = "";
    $("statement-download").disabled = true;
    statement = null;
  }
  const session = NexoraSession("nexora_customer", signedOut),
    api = (path, body) =>
      session.api(path, { ...(body ? { method: "POST", body } : {}) });
  function showProfile(profile) {
    $("business-title").textContent =
      profile?.business_name || "Set up your business";
    $("merchant-profile").elements.business_name.value =
      profile?.business_name || "";
    $("saved-pickup").textContent = profile?.pickup_address
      ? "Saved pickup: " + profile.pickup_address
      : "Save a pickup from your next delivery to reuse it here.";
    $("new-order").hidden = !profile;
  }
  async function refresh() {
    const current = ++sequence;
    $("desk-error").textContent = "";
    $("merchant-orders").textContent = "Loading deliveries…";
    $("previous-page").disabled = true;
    $("next-page").disabled = true;
    try {
      const filters = new URLSearchParams(new FormData($("merchant-filter")));
      filters.set("page", page);
      const data = await api("/merchant/desk?" + filters);
      if (current !== sequence) return;
      showProfile(data.profile);
      const balances = data.balances.length
        ? data.balances
        : [{ currency: data.currency }];
      $("merchant-balances").innerHTML = balances
        .map((b) =>
          [
            ["expected", "Expected from active orders"],
            ["with_drivers", "With drivers"],
            ["awaiting_settlement", "Awaiting settlement"],
            ["settled", "Settled to you"],
          ]
            .map(
              ([key, label]) =>
                `<div class="card"><span>${label}</span><strong>${esc(money(b[key], b.currency))}</strong></div>`,
            )
            .join(""),
        )
        .join("");
      $("merchant-orders").innerHTML =
        data.deliveries
          .map((d) => {
            const cod = Number(d.cod_amount),
              status = !cod
                ? "No goods payment"
                : d.cod_settled_at
                  ? "Settled"
                  : d.cod_received_at
                    ? "Awaiting settlement"
                    : d.cod_collected_at
                      ? "With driver"
                      : ["cancelled", "returned", "failed_delivery"].includes(
                            d.status,
                          )
                        ? "Not collected"
                        : "Collection pending";
            const returnAction =
              d.status === "delivered" && !d.return_of_delivery_id
                ? d.return_booked
                  ? "<span>Return booked</span>"
                  : `<a class="button secondary" href="/freight.html?business=1&return=${encodeURIComponent(d.id)}">Book return pickup</a>`
                : "";
            return `<article class="card order-card"><div class="order-heading"><div><h3>${esc(d.merchant_order_ref || (d.return_of_delivery_id ? "Return pickup" : d.delivery_number))}</h3><small>${esc(d.delivery_number)} · ${esc(new Date(d.requested_at).toLocaleDateString())}${d.return_of_delivery_id ? " · Return pickup" : ""}</small></div><span class="status-pill">${esc(d.status.replaceAll("_", " "))}</span></div><p>${esc(d.pickup_address)} → ${esc(d.dropoff_address)}</p><dl class="order-meta"><div><dt>Goods payment</dt><dd>${esc(money(cod, d.currency))}</dd></div><div><dt>Delivery fee</dt><dd>${esc(money(d.total_fare, d.currency))}</dd></div><div><dt>Recipient pays</dt><dd>${esc(money(cod + Number(d.total_fare), d.currency))}</dd></div><div><dt>COD status</dt><dd>${status}</dd></div></dl><div class="desk-actions"><a class="button secondary" href="/freight.html?repeat=${encodeURIComponent(d.id)}">Repeat delivery</a>${returnAction}<a href="/freight.html">Handoff PINs & tracking</a>${cod ? `<button class="secondary" data-events="${esc(d.id)}">Payment history</button>` : ""}</div><div id="events-${esc(d.id)}" role="status"></div></article>`;
          })
          .join("") ||
        '<div class="card"><h3>No orders to show.</h3><p>Create your business profile, then add an order reference when booking a delivery.</p></div>';
      $("page-number").textContent = "Page " + page;
      $("previous-page").disabled = page === 1;
      $("next-page").disabled = !data.has_more;
    } catch (e) {
      if (current === sequence) {
        $("desk-error").textContent = e.message;
        $("merchant-orders").replaceChildren();
        $("merchant-balances").replaceChildren();
      }
    }
  }
  async function start() {
    $("merchant-auth").hidden = true;
    $("phone-auth").hidden = true;
    $("merchant-desk").hidden = false;
    $("merchant-logout").hidden = false;
    await refresh();
    await loadDrafts();
  }
  async function loadDrafts() {
    const current = sequence;
    try {
      const { drafts, currency } = await api("/merchant/drafts");
      if (current !== sequence) return;
      $("drafts-title").textContent = drafts.length
        ? `Orders to book (${drafts.length})`
        : "Orders to book";
      $("merchant-drafts").innerHTML =
        drafts
          .map(
            (d) =>
              `<article class="order-card draft-card"><div class="order-heading"><h3>${esc(d.order_ref)}</h3><span class="status-pill">${d.lat !== null ? "Location included" : "Choose on map"}</span></div><p>${esc(d.recipient_name)} · ${esc(d.recipient_phone)}</p><p>${esc(d.address)}</p><p class="help-copy">Goods payment ${esc(money(d.cod_amount, currency))} · ${esc(d.cargo_description)} · ${esc(Number(d.cargo_weight_kg))} kg${d.is_fragile ? " · Fragile" : ""}</p><div class="desk-actions"><a class="button" href="/freight.html?business=1&draft=${encodeURIComponent(d.id)}">Book delivery</a><button class="secondary" data-discard="${esc(d.id)}">Discard</button></div></article>`,
          )
          .join("") || '<p class="help-copy">No imported orders are waiting.</p>';
    } catch (e) {
      if (current === sequence) $("merchant-drafts").textContent = e.message;
    }
  }
  $("merchant-drafts").onclick = async (e) => {
    const button = e.target.closest("[data-discard]");
    if (!button) return;
    button.disabled = true;
    try {
      await api(`/merchant/drafts/${button.dataset.discard}/discard`, {});
      await loadDrafts();
    } catch (err) {
      $("desk-error").textContent = err.message;
      button.disabled = false;
    }
  };
  $("import-template").onclick = () =>
    downloadCsv("nexora-orders-template.csv", [
      ["order_ref", "recipient_name", "recipient_phone", "address", "cod_amount", "description", "weight_kg", "latitude", "longitude", "fragile"],
      ["ORDER-1001", "Ayesha Khan", "0300 1234567", "House 4, Street 9, near the main bazaar", "2500", "Shirt", "0.5", "", "", "no"],
    ]);
  $("import-form").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget,
      button = form.querySelector("button"),
      file = form.elements.file.files[0];
    $("import-results").replaceChildren();
    if (!file) return;
    if (file.size > 200 * 1024) {
      $("import-status").textContent =
        "The file is larger than 200 KB. Split it into smaller files.";
      return;
    }
    button.disabled = true;
    $("import-status").textContent = "Importing…";
    try {
      const data = await api("/merchant/imports", { csv: await file.text() });
      $("import-status").textContent =
        `${data.imported} imported · ${data.duplicates} already added · ${data.errors} with problems. ${data.message}`;
      const problems = data.rows.filter((r) => r.status !== "imported");
      $("import-results").innerHTML = problems.length
        ? `<ul class="import-problems">${problems.map((r) => `<li><strong>Line ${esc(r.line)}${r.order_ref ? " · " + esc(r.order_ref) : ""}</strong> ${esc(r.errors.join(" "))}</li>`).join("")}</ul><p class="help-copy">Fix these rows in your sheet and import the file again. Orders already imported are skipped.</p>`
        : "";
      form.reset();
      await loadDrafts();
    } catch (err) {
      $("import-status").textContent = err.message;
    } finally {
      button.disabled = false;
    }
  };
  {
    const now = new Date();
    $("statement-form").elements.month.value =
      now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
  }
  $("statement-form").onsubmit = async (e) => {
    e.preventDefault();
    const button = e.currentTarget.querySelector("button"),
      month = e.currentTarget.elements.month.value;
    button.disabled = true;
    $("statement-status").textContent = "Loading…";
    try {
      const data = await api("/merchant/statement?month=" + encodeURIComponent(month));
      statement = data;
      $("statement-totals").innerHTML = data.totals
        .map((t) =>
          [
            ["Deliveries", `${t.deliveries} · ${t.delivered} delivered · ${t.cancelled} cancelled`],
            ["Delivery fees (delivered)", money(t.delivery_fees, t.currency)],
            ["Goods cash collected", money(t.cod_collected, t.currency)],
            ["Settled to you", money(t.cod_settled, t.currency)],
            ["Collected, not yet settled", money(t.cod_outstanding, t.currency)],
            ["Return pickups", String(t.returns)],
          ]
            .map(
              ([label, value]) =>
                `<div class="card"><span>${label}</span><strong>${esc(value)}</strong></div>`,
            )
            .join(""),
        )
        .join("");
      $("statement-status").textContent = data.deliveries.length
        ? `${data.deliveries.length} deliveries requested in ${month} (${data.timezone} time).${data.truncated ? " Showing the first 5,000." : ""}`
        : `No deliveries were requested in ${month}.`;
      $("statement-download").disabled = !data.deliveries.length;
    } catch (err) {
      $("statement-status").textContent = err.message;
    } finally {
      button.disabled = false;
    }
  };
  $("statement-download").onclick = () => {
    if (!statement) return;
    downloadCsv(`nexora-statement-${statement.month}.csv`, [
      ["Requested", "Delivery", "Order reference", "Status", "Recipient", "Destination", "Delivery fee", "Currency", "Goods payment", "Collected", "Received by operations", "Settled to you", "Settlement reference", "Return pickup"],
      ...statement.deliveries.map((d) => [
        d.requested_at,
        d.delivery_number,
        d.merchant_order_ref || "",
        d.status,
        d.dropoff_contact_name || "",
        d.dropoff_address,
        d.total_fare,
        d.currency,
        d.cod_amount,
        d.cod_collected_at || "",
        d.cod_received_at || "",
        d.cod_settled_at || "",
        d.settlement_reference || "",
        d.return_of_delivery_id ? "Yes" : "",
      ]),
    ]);
  };
  $("merchant-login").onsubmit = async (e) => {
    e.preventDefault();
    const button = e.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      const data = await api(
        "/auth/login",
        Object.fromEntries(new FormData(e.currentTarget)),
      );
      await signedIn(data);
      $("merchant-login").reset();
    } catch (e) {
      $("login-error").textContent = e.message;
    } finally {
      button.disabled = false;
    }
  };
  async function signedIn(data) {
    session.save(data);
    if (data.user.role !== "customer") {
      session.logout();
      signedOut();
      throw new Error("Use a customer account for the merchant desk.");
    }
    await start();
  }
  // Phone sign-in appears only when the server has an SMS provider configured.
  fetch("/api/v1/config")
    .then((res) => res.json())
    .then((config) => {
      if (!config.phone_sign_in || !window.NexoraPhoneAuth) return;
      const box = $("phone-auth");
      box.dataset.ready = "true";
      NexoraPhoneAuth.mount(box, {
        request: api,
        role: "customer",
        country: config.country || "PK",
        onSignedIn: signedIn,
      });
      box.hidden = !$("merchant-desk").hidden;
    })
    .catch(() => {});
  $("merchant-logout").onclick = () => {
    session.logout();
    signedOut();
  };
  $("merchant-profile").onsubmit = async (e) => {
    e.preventDefault();
    const button = e.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      const data = await api(
        "/merchant/profile",
        Object.fromEntries(new FormData(e.currentTarget)),
      );
      showProfile(data.profile);
      $("profile-status").textContent = "Business profile saved.";
    } catch (e) {
      $("profile-status").textContent = e.message;
    } finally {
      button.disabled = false;
    }
  };
  $("merchant-filter").onsubmit = (e) => {
    e.preventDefault();
    page = 1;
    refresh();
  };
  $("previous-page").onclick = () => {
    if (page > 1) {
      page--;
      refresh();
    }
  };
  $("next-page").onclick = () => {
    page++;
    refresh();
  };
  $("merchant-orders").onclick = async (e) => {
    const button = e.target.closest("[data-events]");
    if (!button) return;
    button.disabled = true;
    const current = sequence;
    try {
      const data = await api(
        "/merchant/deliveries/" + button.dataset.events + "/events",
      );
      if (current !== sequence) return;
      $("events-" + button.dataset.events).innerHTML =
        data.events
          .map(
            (x) =>
              `<p>${esc(x.kind)} · ${esc(money(x.amount, x.currency))} · ${esc(new Date(x.created_at).toLocaleString())}${x.reference ? " · " + esc(x.reference) : ""}</p>`,
          )
          .join("") || "No goods payment has been collected yet.";
    } catch (e) {
      if (current === sequence) $("desk-error").textContent = e.message;
    } finally {
      button.disabled = false;
    }
  };
  window.addEventListener("nexora:reconnected", () => {
    if (session.get("token")) refresh().then(loadDrafts);
  });
  if (session.get("token")) start();
  else signedOut();
})();
