/* Phone sign-in: mobile number → 6-digit text message code → (new customers only) name.
   Stays hidden unless the server reports phone_sign_in. Codes are never stored in the browser. */
(() => {
  "use strict";
  const html = (strings, ...values) =>
    strings.reduce((out, part, i) => out + part + (i < values.length ? values[i] : ""), "");

  function countdown(button, seconds, label) {
    let left = Math.max(0, Math.ceil(seconds));
    clearInterval(button._timer);
    const tick = () => {
      button.disabled = left > 0;
      button.textContent = left > 0 ? `${label} (${left}s)` : label;
      if (left-- <= 0) clearInterval(button._timer);
    };
    tick();
    button._timer = setInterval(tick, 1000);
  }

  function mount(container, { request, role = "customer", onSignedIn, country = "PK", title = "Continue with your phone", noAccountMessage }) {
    if (!container) return;
    const example = country === "PK" ? "0300 1234567" : "+44 7700 900123";
    container.innerHTML = html`
      <form class="card phone-auth" data-step="number" novalidate>
        <h2 data-title></h2>
        <p data-intro>We'll text you a 6-digit code. No password needed.</p>
        <div data-part="number">
          <label>Mobile number<input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="30" placeholder="${example}" required /></label>
          <button type="submit">Text me a code</button>
        </div>
        <div data-part="code" hidden>
          <label>6-digit code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" /></label>
          <button type="submit">Continue</button>
          <div class="phone-auth-actions">
            <button type="button" class="secondary" data-action="resend">Resend code</button>
            <button type="button" class="secondary" data-action="change">Use a different number</button>
          </div>
        </div>
        <div data-part="profile" hidden>
          <div class="grid">
            <label>First name<input name="first_name" autocomplete="given-name" maxlength="100" /></label>
            <label>Last name (optional)<input name="last_name" autocomplete="family-name" maxlength="100" /></label>
          </div>
          <label class="checkbox-label"><input name="accept_terms" type="checkbox" /><span>I have read the <a href="/privacy.html">privacy information</a> and <a href="/terms.html">service terms</a>.</span></label>
          <button type="submit">Create my account</button>
        </div>
        <p class="error" role="alert" data-error></p>
        <p class="form-hint" role="status" data-status></p>
      </form>`;
    const form = container.querySelector("form"),
      part = (name) => form.querySelector(`[data-part="${name}"]`),
      errorBox = form.querySelector("[data-error]"),
      status = form.querySelector("[data-status]"),
      intro = form.querySelector("[data-intro]"),
      resend = form.querySelector('[data-action="resend"]');
    form.querySelector("[data-title]").textContent = title;
    let step = "number",
      phone = "",
      signupToken = null;
    const say = (message) => (errorBox.textContent = message || "");
    function show(next) {
      step = next;
      form.dataset.step = next;
      for (const name of ["number", "code", "profile"]) part(name).hidden = name !== next;
      const focus = { number: "phone", code: "code", profile: "first_name" }[next];
      form.elements[focus]?.focus();
    }
    async function sendCode() {
      const data = await request("/auth/phone/start", { phone });
      status.textContent = `We sent a code to ${data.phone}. It expires in 5 minutes.`;
      countdown(resend, data.resend_after_sec || 60, "Resend code");
    }
    async function finish(data) {
      await onSignedIn(data);
      form.reset();
      signupToken = null;
      status.textContent = "";
      show("number");
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = part(step).querySelector('button[type="submit"]');
      button.disabled = true;
      say("");
      try {
        if (step === "number") {
          phone = form.elements.phone.value.trim();
          if (!phone) throw new Error(`Enter your mobile number, for example ${example}.`);
          await sendCode();
          show("code");
        } else if (step === "code") {
          const code = form.elements.code.value.trim();
          if (!/^\d{6}$/.test(code)) throw new Error("Enter the 6-digit code from the text message.");
          const data = await request("/auth/phone/verify", { phone, code });
          form.elements.code.value = "";
          if (data.needs_profile) {
            if (role !== "customer") {
              show("number");
              throw new Error(noAccountMessage || "No driver account uses this number. Register as a driver, or sign in with your email.");
            }
            signupToken = data.signup_token;
            intro.textContent = "Welcome to Nexora! Tell us your name to finish.";
            status.textContent = "";
            show("profile");
          } else {
            await finish(data);
          }
        } else {
          const firstName = form.elements.first_name.value.trim();
          if (!firstName) throw new Error("Enter your first name.");
          if (!form.elements.accept_terms.checked) throw new Error("Please confirm you have read the privacy information and service terms.");
          await finish(
            await request("/auth/phone/complete", {
              signup_token: signupToken,
              first_name: firstName,
              last_name: form.elements.last_name.value.trim(),
              accept_terms: true,
            }),
          );
        }
      } catch (err) {
        say(err.message);
        if (/verification expired|already used/i.test(err.message)) show("number");
      } finally {
        button.disabled = false;
      }
    });
    form.elements.accept_terms.addEventListener("change", () => say(""));
    resend.addEventListener("click", async () => {
      say("");
      resend.disabled = true;
      try {
        await sendCode();
      } catch (err) {
        say(err.message);
        resend.disabled = false;
      }
    });
    form.querySelector('[data-action="change"]').addEventListener("click", () => {
      say("");
      status.textContent = "";
      clearInterval(resend._timer);
      show("number");
    });
  }

  // Signed-in prompt for email accounts: verify the number on file to enable phone sign-in.
  async function mountVerify(container, { request }) {
    if (!container) return;
    container.hidden = true;
    let info;
    try {
      info = await request("/account/phone");
    } catch {
      return;
    }
    if (!info.phone_sign_in || info.verified || !info.can_verify) return;
    container.innerHTML = html`
      <form class="phone-verify">
        <p>Verify ${info.phone} to sign in with a text message code next time.</p>
        <div class="phone-auth-actions">
          <button type="button" class="secondary" data-action="send">Send code</button>
          <label hidden>6-digit code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" /></label>
          <button type="submit" hidden>Verify</button>
        </div>
        <p class="error" role="alert"></p>
      </form>`;
    container.hidden = false;
    const form = container.querySelector("form"),
      send = form.querySelector('[data-action="send"]'),
      label = form.querySelector("label"),
      submit = form.querySelector('button[type="submit"]'),
      message = form.querySelector(".error");
    send.addEventListener("click", async () => {
      message.textContent = "";
      send.disabled = true;
      try {
        const data = await request("/account/phone/code", { purpose: "verify_phone" });
        label.hidden = submit.hidden = false;
        form.elements.code.focus();
        countdown(send, data.resend_after_sec || 60, "Resend code");
      } catch (err) {
        message.textContent = err.message;
        send.disabled = false;
      }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      message.textContent = "";
      submit.disabled = true;
      try {
        const data = await request("/account/phone/verify", { code: form.elements.code.value.trim() });
        clearInterval(send._timer);
        form.replaceChildren(Object.assign(document.createElement("p"), { textContent: data.message }));
      } catch (err) {
        message.textContent = err.message;
      } finally {
        submit.disabled = false;
      }
    });
  }

  window.NexoraPhoneAuth = { mount, mountVerify };
})();
