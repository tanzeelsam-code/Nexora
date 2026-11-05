(() => {
  "use strict";
  const W = NexoraWorkspace,
    { $, esc, api } = W;
  if (!W.get("token")) {
    location.replace("/admin.html");
    return;
  }
  W.shell("business");
  let areas = [],
    deliveries = [],
    page = 1,
    walletPage = 1,
    wallets = { drivers: [], pending: [], can_adjust: false },
    canEdit = false,
    sequence = 0;
  for (const name of ["nexora:signed-out", "nexora:session-expired"])
    window.addEventListener(name, () => {
      sequence++;
      document.querySelector(".workspace").hidden = true;
      document.querySelector("#workspace-dialog")?.close();
      location.replace("/admin.html");
    });
  const time = (n) =>
    String(Math.floor(n / 60)).padStart(2, "0") +
    ":" +
    String(n % 60).padStart(2, "0");
  async function refresh() {
    const current = ++sequence;
    $("business-refresh").disabled = true;
    $("business-error").textContent = "";
    try {
      const [coverage, cod, walletData] = await Promise.all([
        api("/admin/areas"),
        api("/admin/cod?page=" + page),
        api("/admin/driver-wallets?page=" + walletPage),
      ]);
      if (current !== sequence) return;
      wallets = walletData;
      renderWallets();
      areas = coverage.areas;
      deliveries = cod.deliveries;
      canEdit = coverage.can_edit;
      $("add-area").hidden = !canEdit;
      $("area-timezone").textContent =
        "Service hours use " +
        coverage.timezone +
        ". Only administrators can change coverage.";
      $("workspace-areas").innerHTML =
        areas
          .map(
            (a) =>
              `<article class="order-card"><div class="order-heading"><h3>${esc(a.name)}</h3><span class="status-pill">${esc(a.status)}</span></div><p>${esc(a.services.join(" & "))} · ${esc(a.radius_km)} km radius · ${time(a.opens_minute)}–${time(a.closes_minute)}</p><p class="help-copy">Centre: ${esc(a.center_lat)}, ${esc(a.center_lng)} · Current: ${esc(a.availability.replaceAll("_", " "))}</p>${canEdit ? `<button class="secondary" data-area="${esc(a.id)}">Edit area</button>` : ""}</article>`,
          )
          .join("") ||
        "<p>No areas configured. Customers can register interest while the operator prepares coverage.</p>";
      $("area-demand").innerHTML =
        coverage.demand
          .map(
            (d) =>
              `<p>${esc(d.locality)} · ${esc(d.service)} · ${d.requests} interested</p>`,
          )
          .join("") || "<p>No interest registered yet.</p>";
      $("workspace-cod").innerHTML =
        deliveries
          .map(
            (d) =>
              `<article class="card order-card"><div class="order-heading"><h3>${esc(d.business_name || d.email)} · ${esc(d.merchant_order_ref || d.delivery_number)}</h3><span class="status-pill">${d.cod_received_at ? "Ready to settle" : "With driver"}</span></div><p>${esc(d.delivery_number)} · Driver: ${esc(d.driver_name || "—")}</p><dl class="order-meta"><div><dt>Goods cash</dt><dd>${esc(W.money(d.cod_amount, d.currency))}</dd></div><div><dt>Delivery fee (separate)</dt><dd>${esc(W.money(d.total_fare, d.currency))}</dd></div></dl><button data-cod="${esc(d.id)}">${d.cod_received_at ? "Record merchant payment" : "Record cash received"}</button></article>`,
          )
          .join("") ||
        '<div class="card"><p>No collected COD awaiting reconciliation.</p></div>';
      $("cod-prev").disabled = page === 1;
      $("cod-next").disabled = !cod.has_more;
      $("cod-page").textContent = "Page " + page;
    } catch (e) {
      if (current === sequence) {
        $("business-error").textContent = e.message;
        $("workspace-cod").replaceChildren();
        $("cod-prev").disabled = true;
        $("cod-next").disabled = true;
      }
    } finally {
      $("business-refresh").disabled = false;
    }
  }
  const METHOD_NAMES = {
    easypaisa: "Easypaisa",
    jazzcash: "JazzCash",
    bank_transfer: "Bank transfer",
    cash_office: "Cash at office",
  };
  const driverName = (d) =>
    `${d.first_name || ""} ${d.last_name || ""}`.trim() || d.driver_number;
  function renderWallets() {
    const c = wallets.currency;
    $("wallet-limit-note").textContent =
      wallets.limit === null
        ? "No balance limit is set (DRIVER_CASH_LIMIT). Drivers can keep working whatever they owe."
        : `Drivers who owe more than ${W.money(wallets.limit, c)} cannot go online or receive new jobs.`;
    $("wallet-pending").innerHTML =
      wallets.pending
        .map(
          (r) =>
            `<article class="card order-card"><div class="order-heading"><h3>${esc(driverName(r))} · ${esc(W.money(r.amount, r.currency))}</h3><span class="status-pill">${esc(METHOD_NAMES[r.method])}</span></div><p>Transaction ID <strong>${esc(r.reference)}</strong> · submitted ${esc(new Date(r.created_at).toLocaleString())}</p><button data-claim="${esc(r.id)}" data-action="confirm">Confirm payment</button> <button class="secondary" data-claim="${esc(r.id)}" data-action="reject">Reject</button></article>`,
        )
        .join("") || '<div class="card"><p>No payments waiting.</p></div>';
    $("wallet-drivers").innerHTML =
      wallets.drivers
        .map(
          (d) =>
            `<article class="card order-card"><div class="order-heading"><h3>${esc(driverName(d))}</h3><span class="status-pill">${Number(d.balance) > 0 ? "Owes " + esc(W.money(d.balance, c)) : "Credit " + esc(W.money(-Number(d.balance), c))}</span></div><p>${esc(d.driver_number || "")} · ${esc(d.phone || "")}${d.pending_count ? ` · ${d.pending_count} payment(s) waiting` : ""}</p><button data-driver="${esc(d.id)}" data-action="record">Record payment</button>${wallets.can_adjust ? ` <button class="secondary" data-driver="${esc(d.id)}" data-action="adjust">Adjust</button>` : ""}</article>`,
        )
        .join("") ||
      '<div class="card"><p>No driver owes commission.</p></div>';
    $("wallet-prev").disabled = walletPage === 1;
    $("wallet-next").disabled = !wallets.has_more;
    $("wallet-page").textContent = "Page " + walletPage;
  }
  function walletDialog(title, html, submit) {
    const dialog = W.dialog(title, html);
    const form = dialog.querySelector("form");
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = form.querySelector("button");
      button.disabled = true;
      try {
        await submit(form);
        dialog.close();
        await refresh();
      } catch (e) {
        form.querySelector(".error").textContent = e.message;
      } finally {
        button.disabled = false;
      }
    };
  }
  $("wallet-pending").onclick = (e) => {
    const button = e.target.closest("[data-claim]");
    if (!button) return;
    const r = wallets.pending.find((x) => x.id === button.dataset.claim);
    if (!r) return;
    const amount = esc(W.money(r.amount, r.currency));
    if (button.dataset.action === "confirm")
      walletDialog(
        "Confirm driver payment",
        `<p>${esc(driverName(r))} · ${esc(METHOD_NAMES[r.method])} · TID <strong>${esc(r.reference)}</strong></p><form><label class="check-label"><input name="confirm" type="checkbox" required><span>I found this payment of ${amount} in our ${esc(METHOD_NAMES[r.method])} statement.</span></label><p class="help-copy">Confirming reduces the driver's balance. It is a permanent record and moves no money.</p><button class="primary">Confirm ${amount}</button><p class="error" role="alert"></p></form>`,
        (form) =>
          api(`/admin/driver-wallets/remittances/${r.id}/confirm`, {
            amount: Number(r.amount),
            confirm: form.elements.confirm.checked,
          }),
      );
    else
      walletDialog(
        "Reject driver payment",
        `<p>${esc(driverName(r))} · ${amount} · TID ${esc(r.reference)}</p><form><label>Reason the driver will see<input name="note" minlength="3" maxlength="300" required placeholder="No matching payment in our statement"></label><button class="primary">Reject payment</button><p class="error" role="alert"></p></form>`,
        (form) =>
          api(`/admin/driver-wallets/remittances/${r.id}/reject`, {
            note: form.elements.note.value,
          }),
      );
  };
  $("wallet-drivers").onclick = (e) => {
    const button = e.target.closest("[data-driver]");
    if (!button) return;
    const d = wallets.drivers.find((x) => x.id === button.dataset.driver);
    if (!d) return;
    if (button.dataset.action === "record")
      walletDialog(
        "Record payment from " + driverName(d),
        `<form class="business-form"><label>Paid with<select name="method"><option value="cash_office">Cash at office</option><option value="easypaisa">Easypaisa</option><option value="jazzcash">JazzCash</option><option value="bank_transfer">Bank transfer</option></select></label><label>Receipt or transaction ID<input name="reference" minlength="4" maxlength="60" required></label><label>Amount (${esc(wallets.currency)})<input name="amount" type="number" min="0.01" step="0.01" required></label><label class="check-label full"><input name="confirm" type="checkbox" required><span>I have received this payment.</span></label><button class="primary full">Record payment</button><p class="error full" role="alert"></p></form>`,
        (form) =>
          api(`/admin/driver-wallets/${d.id}/remittances`, {
            method: form.elements.method.value,
            reference: form.elements.reference.value,
            amount: Number(form.elements.amount.value),
            confirm: form.elements.confirm.checked,
          }),
      );
    else if (wallets.can_adjust)
      walletDialog(
        "Adjust balance for " + driverName(d),
        `<form class="business-form"><label>Amount (${esc(wallets.currency)}; negative reduces what they owe)<input name="amount" type="number" step="0.01" required></label><label class="full">Reason (kept in the audit trail)<input name="note" minlength="5" maxlength="300" required></label><label class="check-label full"><input name="confirm" type="checkbox" required><span>Record this adjustment.</span></label><button class="primary full">Save adjustment</button><p class="error full" role="alert"></p></form>`,
        (form) =>
          api(`/admin/driver-wallets/${d.id}/adjustments`, {
            amount: Number(form.elements.amount.value),
            note: form.elements.note.value,
            confirm: form.elements.confirm.checked,
          }),
      );
  };
  $("wallet-prev").onclick = () => {
    if (walletPage > 1) {
      walletPage--;
      refresh();
    }
  };
  $("wallet-next").onclick = () => {
    walletPage++;
    refresh();
  };
  function editArea(area) {
    const a = area || {
      name: "",
      center_lat: "",
      center_lng: "",
      radius_km: 10,
      status: "planned",
      services: ["ride", "delivery"],
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      opens_minute: 0,
      closes_minute: 1440,
    };
    const dialog = W.dialog(
      area ? "Edit service area" : "Add service area",
      `<form id="area-editor" class="business-form"><label class="full">Locality name<input name="name" value="${esc(a.name)}" minlength="2" maxlength="100" required></label><label>Centre latitude<input name="center_lat" type="number" min="-90" max="90" step="any" value="${esc(a.center_lat)}" required></label><label>Centre longitude<input name="center_lng" type="number" min="-180" max="180" step="any" value="${esc(a.center_lng)}" required></label><label>Radius (km)<input name="radius_km" type="number" min="0.01" max="250" step="0.01" value="${esc(a.radius_km)}" required></label><label>Status<select name="status"><option value="planned">Not launched</option><option value="active">Active</option><option value="paused">Paused</option></select></label><fieldset class="full"><legend>Services</legend>${["ride", "delivery"].map((s) => `<label><input name="services" type="checkbox" value="${s}" ${a.services.includes(s) ? "checked" : ""}>${s}</label>`).join("")}</fieldset><fieldset class="full"><legend>Operating days</legend>${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => `<label><input name="weekdays" type="checkbox" value="${i}" ${a.weekdays.includes(i) ? "checked" : ""}>${d}</label>`).join("")}</fieldset><label>Opening time<input name="opens" type="time" value="${time(a.opens_minute)}" required></label><label>Closing time (24:00 = midnight)<input name="closes" pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00" value="${time(a.closes_minute)}" required></label><p class="help-copy full">Choose a boundary your reviewed drivers can serve. An active area does not bypass maps, fares, or driver requirements.</p><button class="primary full">Save area</button><p class="error full" id="area-edit-error" role="alert"></p></form>`,
    );
    const form = dialog.querySelector("form");
    form.elements.status.value = a.status;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const button = form.querySelector("button");
      button.disabled = true;
      try {
        const data = new FormData(form),
          minutes = (s) =>
            s.split(":").reduce((h, m) => Number(h) * 60 + Number(m));
        await api("/admin/areas" + (area ? "/" + area.id : ""), {
          name: data.get("name"),
          center_lat: Number(data.get("center_lat")),
          center_lng: Number(data.get("center_lng")),
          radius_km: Number(data.get("radius_km")),
          status: data.get("status"),
          services: data.getAll("services"),
          weekdays: data.getAll("weekdays").map(Number),
          opens_minute: minutes(data.get("opens")),
          closes_minute: minutes(data.get("closes")),
        });
        dialog.close();
        await refresh();
      } catch (e) {
        dialog.querySelector("#area-edit-error").textContent = e.message;
      } finally {
        button.disabled = false;
      }
    };
  }
  $("add-area").onclick = () => editArea();
  $("workspace-areas").onclick = (e) => {
    const b = e.target.closest("[data-area]");
    if (b && canEdit) editArea(areas.find((a) => a.id === b.dataset.area));
  };
  $("workspace-cod").onclick = (e) => {
    const button = e.target.closest("[data-cod]");
    if (!button) return;
    const d = deliveries.find((d) => d.id === button.dataset.cod);
    if (!d) return;
    const action = d.cod_received_at ? "settled" : "received";
    const label =
      action === "settled"
        ? "I have paid the merchant the full goods amount"
        : "I have received the full goods amount from the driver";
    const dialog = W.dialog(
      action === "settled"
        ? "Record completed merchant payment"
        : "Record cash received",
      `<p>${esc(d.merchant_order_ref || d.delivery_number)} · <strong>${esc(W.money(d.cod_amount, d.currency))}</strong> in goods payments.</p><form><label>Receipt or transfer reference<input name="reference" minlength="3" maxlength="150" required></label><label class="check-label"><input name="confirm" type="checkbox" required><span>${label}: ${esc(W.money(d.cod_amount, d.currency))}.</span></label><p class="help-copy">This is a permanent payment record. No funds will be transferred by Nexora. Delivery fees are excluded.</p><button class="primary">Record payment</button><p class="error" id="cod-action-error" role="alert"></p></form>`,
    );
    const form = dialog.querySelector("form");
    form.onsubmit = async (event) => {
      event.preventDefault();
      const submit = form.querySelector("button");
      submit.disabled = true;
      try {
        await api(`/admin/cod/${d.id}/${action}`, {
          reference: form.elements.reference.value,
          amount: Number(d.cod_amount),
          confirm: form.elements.confirm.checked,
        });
        dialog.close();
        await refresh();
      } catch (e) {
        dialog.querySelector("#cod-action-error").textContent = e.message;
      } finally {
        submit.disabled = false;
      }
    };
  };
  $("business-refresh").onclick = refresh;
  $("cod-prev").onclick = () => {
    if (page > 1) {
      page--;
      refresh();
    }
  };
  $("cod-next").onclick = () => {
    page++;
    refresh();
  };
  window.addEventListener("nexora:reconnected", refresh);
  refresh();
})();
