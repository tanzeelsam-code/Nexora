(() => {
  "use strict";
  const form = document.getElementById("delete-account"),
    status = document.getElementById("delete-status");
  const session = NexoraSession("nexora_privacy");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    status.textContent = "Confirming your identity…";
    try {
      const credentials = {
        email: form.elements.email.value.trim(),
        password: form.elements.password.value,
      };
      const auth = await session.api("/auth/login", {
        method: "POST",
        body: credentials,
      });
      session.save(auth);
      const result = await session.api("/account/delete", {
        method: "POST",
        body: { password: credentials.password, confirm: "DELETE" },
      });
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith("nexora_")) sessionStorage.removeItem(key);
      window.NexoraNetwork?.clear();
      form.reset();
      status.textContent = result.message;
      button.textContent = "Account deleted";
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    } finally {
      session.logout();
      form.elements.password.value = "";
    }
  });
})();
