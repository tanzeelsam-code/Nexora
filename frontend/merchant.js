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
    sequence = 0;
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
            return `<article class="card order-card"><div class="order-heading"><div><h3>${esc(d.merchant_order_ref || d.delivery_number)}</h3><small>${esc(d.delivery_number)} · ${esc(new Date(d.requested_at).toLocaleDateString())}</small></div><span class="status-pill">${esc(d.status.replaceAll("_", " "))}</span></div><p>${esc(d.pickup_address)} → ${esc(d.dropoff_address)}</p><dl class="order-meta"><div><dt>Goods payment</dt><dd>${esc(money(cod, d.currency))}</dd></div><div><dt>Delivery fee</dt><dd>${esc(money(d.total_fare, d.currency))}</dd></div><div><dt>Recipient pays</dt><dd>${esc(money(cod + Number(d.total_fare), d.currency))}</dd></div><div><dt>COD status</dt><dd>${status}</dd></div></dl><div class="desk-actions"><a class="button secondary" href="/freight.html?repeat=${encodeURIComponent(d.id)}">Repeat delivery</a><a href="/freight.html">Handoff PINs & tracking</a>${cod ? `<button class="secondary" data-events="${esc(d.id)}">Payment history</button>` : ""}</div><div id="events-${esc(d.id)}" role="status"></div></article>`;
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
  }
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
    if (session.get("token")) refresh();
  });
  if (session.get("token")) start();
  else signedOut();
})();
