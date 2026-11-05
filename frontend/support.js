(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const prefix = sessionStorage.getItem("nexora_customer_token")
    ? "nexora_customer"
    : "nexora_driver";
  const session = NexoraSession(prefix, () => {
    $("support-account").hidden = true;
    $("support-signin").hidden = false;
    $("support-history").replaceChildren();
  });
  if (!session.get("token")) {
    $("support-signin").hidden = false;
    return;
  }
  $("support-account").hidden = false;
  let submission;
  async function refresh() {
    try {
      const { tickets } = await session.api("/support/tickets");
      $("support-error").textContent = "";
      $("support-history").replaceChildren();
      for (const t of tickets) {
        const card = document.createElement("article");
        card.className = "card";
        const title = document.createElement("h3");
        title.textContent = t.incident_ref + " · " + t.status;
        const message = document.createElement("p");
        message.textContent = t.description;
        const reply = document.createElement("p");
        reply.textContent = t.resolution_note
          ? "Support: " + t.resolution_note
          : "Waiting for a response.";
        card.append(title, message, reply);
        $("support-history").append(card);
      }
      if (!tickets.length)
        $("support-history").textContent =
          "Your support requests will appear here.";
    } catch (e) {
      $("support-error").textContent = e.message;
    }
  }
  $("support-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      button = form.querySelector("button");
    button.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form)),
        serialized = JSON.stringify(body);
      if (submission?.serialized !== serialized)
        submission = { serialized, request_id: crypto.randomUUID() };
      const data = await session.api("/support/tickets", {
        method: "POST",
        body: { ...body, request_id: submission.request_id },
      });
      submission = null;
      form.reset();
      $("support-status").textContent =
        data.ticket.incident_ref + " · " + data.message;
      await refresh();
    } catch (e) {
      $("support-status").textContent = e.message;
    } finally {
      button.disabled = false;
    }
  };
  $("support-refresh").onclick = refresh;
  window.addEventListener("nexora:reconnected", refresh);
  refresh();
})();
