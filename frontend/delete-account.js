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

  // Phone-only accounts: sign in with a code, then confirm deletion with a second code.
  const phoneSession = NexoraSession("nexora_privacy_phone"),
    confirmForm = document.getElementById("phone-delete-confirm"),
    phoneStatus = document.getElementById("phone-delete-status"),
    call = (path, body) =>
      phoneSession.api(path, body === undefined ? {} : { method: "POST", body });
  fetch("/api/v1/config")
    .then((res) => res.json())
    .then((config) => {
      if (!config.phone_sign_in || !window.NexoraPhoneAuth) return;
      document.getElementById("phone-delete").hidden = false;
      NexoraPhoneAuth.mount(document.getElementById("phone-auth"), {
        request: call,
        role: "existing",
        country: config.country || "PK",
        title: "Delete with your phone",
        noAccountMessage: "No account uses this number.",
        async onSignedIn(data) {
          if (!["customer", "driver"].includes(data.user.role)) {
            phoneSession.save(data);
            phoneSession.logout();
            throw new Error("Workspace accounts must be removed by the business owner. Contact support.");
          }
          phoneSession.save(data);
          await call("/account/phone/code", { purpose: "delete_account" });
          document.getElementById("phone-auth").hidden = true;
          confirmForm.hidden = false;
          confirmForm.elements.code.focus();
        },
      });
    })
    .catch(() => {});
  confirmForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = confirmForm.querySelector("button");
    button.disabled = true;
    phoneStatus.textContent = "Deleting your account…";
    try {
      const result = await call("/account/delete", {
        phone_code: confirmForm.elements.code.value.trim(),
        confirm: "DELETE",
      });
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith("nexora_")) sessionStorage.removeItem(key);
      window.NexoraNetwork?.clear();
      confirmForm.reset();
      phoneStatus.textContent = result.message;
      button.textContent = "Account deleted";
      phoneSession.logout();
    } catch (error) {
      phoneStatus.textContent = error.message;
      button.disabled = false;
    }
  });
})();
