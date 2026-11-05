(() => {
  "use strict";
  const W = NexoraWorkspace,
    { $, esc, api } = W;
  if (!W.get("token")) {
    location.replace("/admin.html");
    return;
  }
  W.shell("support");
  for (const name of ["nexora:signed-out", "nexora:session-expired"])
    window.addEventListener(name, () => {
      document.querySelector(".workspace").hidden = true;
      location.replace("/admin.html");
    });
  let tickets = [];
  async function refresh() {
    $("refresh").disabled = true;
    try {
      tickets = (await api("/admin/support")).tickets;
      $("support-error").textContent = "";
      $("support-list").innerHTML =
        tickets
          .map(
            (t) =>
              `<article class="card" style="padding:20px;margin:16px 0"><h2>${esc(t.incident_ref)} · ${esc(t.status)}</h2><p>${esc(t.email)} · ${esc(t.type.replace("support_", ""))} · ${esc(new Date(t.created_at).toLocaleString())}</p><p style="white-space:pre-wrap">${esc(t.description)}</p>${t.resolution_note ? `<p>Last reply: ${esc(t.resolution_note)}</p>` : ""}<button data-reply="${esc(t.id)}">Reply / update status</button></article>`,
          )
          .join("") || "<p>No support requests yet.</p>";
    } catch (e) {
      $("support-error").textContent = e.message;
    } finally {
      $("refresh").disabled = false;
    }
  }
  $("support-list").onclick = (event) => {
    const button = event.target.closest("[data-reply]");
    if (!button) return;
    const t = tickets.find((t) => t.id === button.dataset.reply);
    if (!t) return;
    const dialog = W.dialog(
      "Reply to " + t.incident_ref,
      `<form id="support-reply"><label>Status<select name="status"><option value="open">Open</option><option value="investigating">Investigating</option><option value="resolved">Resolved</option></select></label><label>Reply visible to the user<textarea name="reply" rows="5" minlength="5" maxlength="2000" required></textarea></label><button class="primary" type="submit">Save reply</button><p id="reply-error" role="alert"></p></form>`,
    );
    const form = dialog.querySelector("form");
    form.elements.status.value = t.status;
    form.elements.reply.value = t.resolution_note || "";
    form.onsubmit = async (event) => {
      event.preventDefault();
      form.querySelector("button").disabled = true;
      try {
        await api(
          "/admin/support/" + t.id,
          Object.fromEntries(new FormData(form)),
        );
        dialog.close();
        await refresh();
      } catch (e) {
        dialog.querySelector("#reply-error").textContent = e.message;
        form.querySelector("button").disabled = false;
      }
    };
  };
  $("refresh").onclick = refresh;
  window.addEventListener("nexora:reconnected", refresh);
  refresh();
})();
