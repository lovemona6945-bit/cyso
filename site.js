"use strict";

(() => {
  const $ = (selector) => document.querySelector(selector);
  let toastTimer;

  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: "same-origin", ...options });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    return result;
  }

  function showToast(message) {
    const toast = $("#toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
  }

  function formatDate(date) {
    if (!date) return "Date to be announced";
    const parsed = new Date(`${date}T12:00:00`);
    return Number.isNaN(parsed.getTime()) ? "Date to be announced" : parsed.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric"
    });
  }

  function makeEventCard(event) {
    const card = document.createElement("article");
    card.className = "event-card";
    const media = document.createElement("div");
    media.className = "event-media";
    if (event.mediaUrl) {
      const isVideo = /\.(mp4|webm|mov|m4v)$/i.test(event.mediaUrl);
      const element = document.createElement(isVideo ? "video" : "img");
      element.src = event.mediaUrl;
      if (isVideo) {
        element.controls = true;
        element.preload = "metadata";
      } else {
        element.alt = `Media for ${event.title}`;
      }
      media.append(element);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "event-placeholder";
      placeholder.textContent = event.location;
      media.append(placeholder);
    }

    const status = event.status === "current" ? "Happening now" : event.status === "past" ? "Past gathering" : "Upcoming";
    const body = document.createElement("div");
    body.className = "event-body";
    body.innerHTML = `<div class="event-meta"><span>${escapeHtml(formatDate(event.date))}</span><span class="event-status ${event.status === "current" ? "current" : ""}">${status}</span></div><h3>${escapeHtml(event.title)}</h3><p>${escapeHtml(event.description || event.location)}</p>`;
    card.append(media, body);
    return card;
  }

  async function loadEvents() {
    const events = await api("/api/events");
    const groupSelectors = {
      upcoming: "#upcomingEvents",
      current: "#currentEvents",
      past: "#pastEvents"
    };

    for (const [status, selector] of Object.entries(groupSelectors)) {
      const container = $(selector);
      if (!container) continue;
      container.replaceChildren();
      const matched = events.filter((event) => event.status === status);
      if (!matched.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = status === "current"
          ? "No outing is happening right now. Check back for the next gathering."
          : status === "past"
            ? "Our story is just beginning. Past gatherings will appear here."
            : "No upcoming outings have been added yet.";
        container.append(empty);
      } else {
        matched.forEach((event) => container.append(makeEventCard(event)));
      }
    }

    const select = $("#regEvent");
    if (select) {
      select.replaceChildren(new Option("I’m interested in any outing", ""));
      events.filter((event) => event.status !== "past").forEach((event) => {
        select.add(new Option(`${event.title} — ${event.location}`, event.id));
      });
    }

    const institutions = $("#institutionList");
    if (institutions) {
      const names = [...new Set(events
        .filter((event) => event.status !== "past")
        .flatMap((event) => event.institutions || [])
        .map((name) => name.trim())
        .filter(Boolean))];
      institutions.replaceChildren();
      if (!names.length) names.push("Zimbabwean student fellowships — welcome");
      names.forEach((name) => {
        const chip = document.createElement("span");
        chip.className = "institution-chip";
        chip.textContent = name;
        institutions.append(chip);
      });
    }

    return events;
  }

  const menuToggle = $("#menuToggle");
  menuToggle?.addEventListener("click", () => {
    const menu = $("#navLinks");
    const open = menu.classList.toggle("open");
    menuToggle.setAttribute("aria-expanded", String(open));
    menuToggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  });

  $("#navLinks")?.addEventListener("click", (event) => {
    if (event.target.closest("a")) {
      $("#navLinks").classList.remove("open");
      menuToggle?.setAttribute("aria-expanded", "false");
    }
  });

  $("#year").textContent = new Date().getFullYear();

  if ($("#upcomingEvents") || $("#currentEvents") || $("#pastEvents") || $("#regEvent")) {
    loadEvents().catch((error) => {
      console.error("Could not load CYSo events:", error);
      showToast(`Could not connect to the CYSo server: ${error.message}`);
    });
  }

  $("#registrationForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const message = $("#registrationMessage");
    message.textContent = "Sending your registration…";
    try {
      await api("/api/registrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form).entries()))
      });
      message.textContent = "Thank you! Your registration has been sent to the CYSo organizers.";
      form.reset();
    } catch (error) {
      message.textContent = error.message;
    }
  });

  window.CYSo = { api, loadEvents, makeEventCard, showToast };
})();
