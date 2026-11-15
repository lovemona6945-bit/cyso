"use strict";

(() => {
  const $ = (selector) => document.querySelector(selector);
  let events = [];

  function formatDateTime(value) {
    if (!value) return "Unknown";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? String(value)
      : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function registrationDetail(label, value) {
    const item = document.createElement("div");
    item.className = "registration-detail";
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value || "Not provided";
    item.append(term, description);
    return item;
  }

  function setAuthenticated(authenticated, passwordManaged = false) {
    $("#adminLogin").hidden = authenticated;
    $("#adminTools").hidden = !authenticated;
    $("#passwordForm").hidden = passwordManaged;
    $("#passwordManagedNotice").hidden = !passwordManaged;
    if (!authenticated) $("#adminPass").value = "";
  }

  async function renderAdmin() {
    const [currentEvents, registrations] = await Promise.all([
      CYSo.api("/api/events"),
      CYSo.api("/api/admin/registrations")
    ]);
    events = currentEvents;

    const eventList = $("#adminEventList");
    eventList.replaceChildren();
    if (!events.length) {
      eventList.innerHTML = '<div class="empty-state">No events saved.</div>';
    }
    events.forEach((event) => {
      const row = document.createElement("div");
      row.className = "admin-row";
      const label = document.createElement("span");
      label.textContent = `${event.title} · ${event.status}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${event.title}`);
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Remove "${event.title}"?`)) return;
        try {
          await CYSo.api(`/api/admin/events/${encodeURIComponent(event.id)}`, { method: "DELETE" });
          await renderAdmin();
          CYSo.showToast("Event removed.");
        } catch (error) {
          CYSo.showToast(error.message);
        }
      });
      row.append(label, remove);
      eventList.append(row);
    });

    const registrationList = $("#adminRegistrationList");
    registrationList.replaceChildren();
    if (!registrations.length) {
      registrationList.innerHTML = '<div class="empty-state">No registrations received yet.</div>';
    }
    registrations.forEach((registration) => {
      const row = document.createElement("article");
      row.className = "admin-row registration-row";
      const outing = events.find((item) => item.id === registration.eventId);
      const content = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = registration.name || "Unnamed registrant";
      const details = document.createElement("dl");
      details.className = "registration-details";
      [
        ["Email", registration.email],
        ["Phone", registration.phone],
        ["Institution / church", registration.institution],
        ["T-shirt size", registration.shirtSize],
        ["T-shirt colour", registration.shirtColor],
        ["Outing", outing ? `${outing.title} — ${outing.location}` : "Any outing"],
        ["Submitted", formatDateTime(registration.createdAt)]
      ].forEach(([label, value]) => details.append(registrationDetail(label, value)));
      content.append(name, details);
      row.append(content);
      registrationList.append(row);
    });
  }

  $("#adminLogin").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const session = await CYSo.api("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: $("#adminPass").value })
      });
      setAuthenticated(true, session.passwordManaged);
      $("#adminMessage").textContent = "Signed in.";
      await renderAdmin();
    } catch (error) {
      $("#adminMessage").textContent = error.message;
    }
  });

  $("#adminLogout").addEventListener("click", async () => {
    try {
      await CYSo.api("/api/admin/logout", { method: "POST" });
      setAuthenticated(false);
      $("#adminMessage").textContent = "You have signed out.";
    } catch (error) {
      CYSo.showToast(error.message);
    }
  });

  $("#passwordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    try {
      await CYSo.api("/api/admin/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form).entries()))
      });
      form.reset();
      setAuthenticated(false);
      $("#passwordMessage").textContent = "Password changed. Sign in with your new password.";
    } catch (error) {
      $("#passwordMessage").textContent = error.message;
    }
  });

  $("#eventForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    try {
      await CYSo.api("/api/admin/events", { method: "POST", body: new FormData(form) });
      form.reset();
      await renderAdmin();
      CYSo.showToast("Event added.");
    } catch (error) {
      CYSo.showToast(error.message);
    }
  });

  CYSo.api("/api/admin/session").then(async (session) => {
    setAuthenticated(session.authenticated, session.passwordManaged);
    if (session.authenticated) await renderAdmin();
  }).catch((error) => {
    $("#adminMessage").textContent = error.message;
  });
})();
