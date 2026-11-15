"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const multer = require("multer");

const scrypt = promisify(crypto.scrypt);
const app = express();
const root = __dirname;
const dataDirectory = path.join(root, "data");
const uploadDirectory = path.join(root, "uploads");
const databaseFile = path.join(dataDirectory, "cyso.sqlite");
const eventsFile = path.join(dataDirectory, "events.json");
const registrationsFile = path.join(dataDirectory, "registrations.json");
const adminFile = path.join(dataDirectory, "admin.json");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || (process.env.NODE_ENV === "production" || process.env.PORT || process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const sessionLifetime = 12 * 60 * 60 * 1000;
const sessions = new Map();
const passwordOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

let database;

const seedEvents = [
  {
    id: "palawani-next",
    title: "CYSo Palawani Lakeworld Outing",
    location: "Palawani Lakeworld Resort, Zvishavane",
    date: "2026-11-28",
    status: "upcoming",
    description: "28-29 November 2026. Theme: Earnestly contending for the faith and Christian values (Jude 1:3). Join us for prayer, worship, fellowship, teaching, testimonies, games and outdoor activities.",
    institutions: [],
    media: "cyso-palawani-poster.png"
  },
  {
    id: "harare-gathering",
    title: "Harare Fellowship Gathering",
    location: "Harare, Zimbabwe",
    date: "",
    status: "past",
    description: "CYSo’s recent Harare gathering brought Christian students together for fellowship, prayer and worship.",
    institutions: [],
    media: null
  }
];

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`Could not read ${path.basename(file)}: ${error.message}`);
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, passwordOptions);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

async function verifyPassword(password, credential) {
  if (!credential) return false;
  const salt = Buffer.from(credential.salt, "hex");
  const expected = Buffer.from(credential.hash, "hex");
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = await scrypt(password, salt, expected.length, passwordOptions);
  return crypto.timingSafeEqual(actual, expected);
}

async function initialize() {
  await Promise.all([
    fs.mkdir(dataDirectory, { recursive: true }),
    fs.mkdir(uploadDirectory, { recursive: true })
  ]);
  const [legacyEvents, legacyRegistrations, legacyAdminCredential] = await Promise.all([
    readJson(eventsFile, seedEvents),
    readJson(registrationsFile, []),
    readJson(adminFile, null)
  ]);
  if (!Array.isArray(legacyEvents) || !Array.isArray(legacyRegistrations)) {
    throw new Error("The event or registration data file has an invalid format.");
  }
  database = new DatabaseSync(databaseFile);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      location TEXT NOT NULL,
      date TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('upcoming', 'current', 'past')),
      description TEXT NOT NULL DEFAULT '',
      institutions TEXT NOT NULL DEFAULT '[]',
      media TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_status_idx ON events(status);
    CREATE TABLE IF NOT EXISTS registrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      institution TEXT NOT NULL DEFAULT '',
      shirt_size TEXT NOT NULL DEFAULT '',
      shirt_color TEXT NOT NULL DEFAULT '',
      event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS registrations_created_at_idx ON registrations(created_at);
    CREATE TABLE IF NOT EXISTS admin_credentials (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      salt TEXT NOT NULL,
      hash TEXT NOT NULL
    );
  `);

  const registrationColumns = new Set(database.prepare("PRAGMA table_info(registrations)").all().map((column) => column.name));
  if (!registrationColumns.has("shirt_size")) {
    database.exec("ALTER TABLE registrations ADD COLUMN shirt_size TEXT NOT NULL DEFAULT ''");
  }
  if (!registrationColumns.has("shirt_color")) {
    database.exec("ALTER TABLE registrations ADD COLUMN shirt_color TEXT NOT NULL DEFAULT ''");
  }

  const migrate = database.prepare("SELECT value FROM app_meta WHERE key = 'legacy_json_migrated'");
  let firstPassword;
  if (!migrate.get()) {
    firstPassword = legacyAdminCredential ? null : crypto.randomBytes(24).toString("base64url");
    const adminCredential = legacyAdminCredential || await hashPassword(firstPassword);
    const insertEvent = database.prepare(`
      INSERT OR IGNORE INTO events (id, title, location, date, status, description, institutions, media, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRegistration = database.prepare(`
      INSERT OR IGNORE INTO registrations (id, name, email, phone, institution, shirt_size, shirt_color, event_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAdmin = database.prepare("INSERT OR IGNORE INTO admin_credentials (id, salt, hash) VALUES (1, ?, ?)");
    const insertMeta = database.prepare("INSERT INTO app_meta (key, value) VALUES ('legacy_json_migrated', ?)");
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const [index, event] of legacyEvents.entries()) {
        if (!event || !event.id || !event.title || !event.location || !["upcoming", "current", "past"].includes(event.status)) {
          throw new Error(`Legacy event ${index + 1} has invalid data; migration was not completed.`);
        }
        insertEvent.run(
          String(event.id),
          String(event.title),
          String(event.location),
          String(event.date || ""),
          event.status,
          String(event.description || ""),
          JSON.stringify(Array.isArray(event.institutions) ? event.institutions : []),
          event.media ? String(event.media) : null,
          String(event.createdAt || new Date().toISOString())
        );
      }
      for (const [index, registration] of legacyRegistrations.entries()) {
        if (!registration || !registration.id || !registration.name || !registration.email) {
          throw new Error(`Legacy registration ${index + 1} has invalid data; migration was not completed.`);
        }
        const eventId = registration.eventId && database.prepare("SELECT id FROM events WHERE id = ?").get(String(registration.eventId))
          ? String(registration.eventId)
          : null;
        insertRegistration.run(
          String(registration.id),
          String(registration.name),
          String(registration.email),
          String(registration.phone || ""),
          String(registration.institution || ""),
          String(registration.shirtSize || ""),
          String(registration.shirtColor || ""),
          eventId,
          String(registration.createdAt || new Date().toISOString())
        );
      }
      insertAdmin.run(adminCredential.salt, adminCredential.hash);
      insertMeta.run(new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    console.log("Imported existing CYSo JSON records into SQLite.");
  }

  const storedCredential = database.prepare("SELECT salt, hash FROM admin_credentials WHERE id = 1").get();
  if (!storedCredential) throw new Error("The SQLite database does not contain an admin credential.");
  if (firstPassword) {
    console.log("\nCYSo first-run admin password (shown only once):");
    console.log(`${firstPassword}\n`);
    console.log("Save this password, sign in at /admin, then change it in the admin panel.\n");
  }
}

function readEvents() {
  return database.prepare(`
    SELECT id, title, location, date, status, description, institutions, media, created_at
    FROM events ORDER BY rowid
  `).all().map((event) => ({
    id: event.id,
    title: event.title,
    location: event.location,
    date: event.date,
    status: event.status,
    description: event.description,
    institutions: JSON.parse(event.institutions),
    media: event.media,
    createdAt: event.created_at
  }));
}

function serializeEvent(event) {
  const { media, ...publicEvent } = event;
  return { ...publicEvent, mediaUrl: media ? `/uploads/${encodeURIComponent(media)}` : null };
}

function sessionToken(request) {
  const cookie = request.headers.cookie || "";
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("cyso_admin="));
  return match ? decodeURIComponent(match.slice("cyso_admin=".length)) : "";
}

function requireAdmin(request, response, next) {
  const token = sessionToken(request);
  const expiresAt = sessions.get(token);
  if (!token || !expiresAt || expiresAt <= Date.now()) {
    sessions.delete(token);
    return response.status(401).json({ error: "Please sign in as an administrator." });
  }
  sessions.set(token, Date.now() + sessionLifetime);
  next();
}

function issueSession(response) {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, Date.now() + sessionLifetime);
  response.cookie("cyso_admin", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: sessionLifetime,
    path: "/"
  });
}

function clearSession(response, token) {
  sessions.delete(token);
  response.clearCookie("cyso_admin", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/"
  });
}

function requireSameOrigin(request, response, next) {
  const origin = request.get("origin");
  if (!origin) return response.status(403).json({ error: "This request must come from the CYSo website." });
  try {
    if (new URL(origin).host !== request.get("host")) {
      return response.status(403).json({ error: "Cross-site requests are not allowed." });
    }
  } catch {
    return response.status(403).json({ error: "Invalid request origin." });
  }
  next();
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validDate(value) {
  return !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
}

const mimeExtensions = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/avif", ".avif"],
  ["video/mp4", ".mp4"],
  ["video/webm", ".webm"],
  ["video/quicktime", ".mov"]
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDirectory,
    filename: (request, file, callback) => {
      callback(null, `${crypto.randomUUID()}${mimeExtensions.get(file.mimetype) || ".bin"}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (request, file, callback) => {
    if (!mimeExtensions.has(file.mimetype)) {
      return callback(new Error("Upload a supported image (JPEG, PNG, GIF, WebP, AVIF) or video (MP4, WebM, MOV)."));
    }
    callback(null, true);
  }
});

app.disable("x-powered-by");
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https://images.unsplash.com"],
      mediaSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null
    }
  }
}));
app.use(express.json({ limit: "20kb" }));
app.use("/api", (request, response, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return requireSameOrigin(request, response, next);
  next();
});
app.use("/uploads", express.static(uploadDirectory, {
  fallthrough: false,
  index: false,
  dotfiles: "deny",
  maxAge: "1d"
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Please wait 15 minutes and try again." }
});
const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many registrations from this connection. Please try again later." }
});

app.get(["/", "/home"], (request, response) => response.sendFile(path.join(root, "index.html")));
app.get(["/about", "/about.html"], (request, response) => response.sendFile(path.join(root, "about.html")));
app.get(["/events", "/events.html"], (request, response) => response.sendFile(path.join(root, "events.html")));
app.get(["/register", "/register.html"], (request, response) => response.sendFile(path.join(root, "register.html")));
app.get(["/admin", "/admin.html"], (request, response) => response.sendFile(path.join(root, "admin.html")));
app.get("/index.html", (request, response) => response.redirect(301, "/"));
app.get("/site.css", (request, response) => response.sendFile(path.join(root, "site.css")));
app.get("/site.js", (request, response) => response.sendFile(path.join(root, "site.js")));
app.get("/admin.js", (request, response) => response.sendFile(path.join(root, "admin.js")));

app.get("/api/events", (request, response) => {
  response.json(readEvents().map(serializeEvent));
});

app.post("/api/registrations", registrationLimiter, async (request, response, next) => {
  const name = cleanText(request.body.name, 100);
  const email = cleanText(request.body.email, 254).toLowerCase();
  const phone = cleanText(request.body.phone, 40);
  const institution = cleanText(request.body.institution, 120);
  const shirtSize = cleanText(request.body.shirtSize, 30);
  const shirtColor = cleanText(request.body.shirtColor, 60);
  const eventId = cleanText(request.body.eventId, 80);
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return response.status(400).json({ error: "Enter your name and a valid email address." });
  }
  if (!shirtSize || !shirtColor) {
    return response.status(400).json({ error: "Choose a T-shirt size and colour preference." });
  }
  const selectedEvent = eventId ? database.prepare("SELECT status FROM events WHERE id = ?").get(eventId) : null;
  if (eventId && (!selectedEvent || selectedEvent.status === "past")) {
    return response.status(400).json({ error: "Please choose an available outing." });
  }
  try {
    database.prepare(`
      INSERT INTO registrations (id, name, email, phone, institution, shirt_size, shirt_color, event_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), name, email, phone, institution, shirtSize, shirtColor, eventId || null, new Date().toISOString());
    response.status(201).json({ message: "Registration received." });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/session", (request, response) => {
  const token = sessionToken(request);
  const expiresAt = sessions.get(token);
  const authenticated = Boolean(token && expiresAt && expiresAt > Date.now());
  if (!authenticated) sessions.delete(token);
  response.json({ authenticated });
});

app.post("/api/admin/login", loginLimiter, async (request, response, next) => {
  const password = request.body.password;
  if (typeof password !== "string" || password.length > 128) {
    return response.status(400).json({ error: "Enter your admin password." });
  }
  try {
    const credential = database.prepare("SELECT salt, hash FROM admin_credentials WHERE id = 1").get();
    if (!(await verifyPassword(password, credential))) {
      return response.status(401).json({ error: "That password was not correct." });
    }
    issueSession(response);
    response.json({ authenticated: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/logout", requireAdmin, (request, response) => {
  clearSession(response, sessionToken(request));
  response.json({ authenticated: false });
});

app.post("/api/admin/password", requireAdmin, async (request, response, next) => {
  const { currentPassword, newPassword } = request.body;
  if (typeof currentPassword !== "string" || typeof newPassword !== "string" || newPassword.length < 12 || newPassword.length > 128) {
    return response.status(400).json({ error: "Choose a new password between 12 and 128 characters." });
  }
  try {
    const currentCredential = database.prepare("SELECT salt, hash FROM admin_credentials WHERE id = 1").get();
    if (!(await verifyPassword(currentPassword, currentCredential))) {
      return response.status(401).json({ error: "Your current password was not correct." });
    }
    const nextCredential = await hashPassword(newPassword);
    database.prepare("UPDATE admin_credentials SET salt = ?, hash = ? WHERE id = 1").run(nextCredential.salt, nextCredential.hash);
    sessions.clear();
    response.clearCookie("cyso_admin", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/"
    });
    response.json({ message: "Password changed. Please sign in again." });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/registrations", requireAdmin, (request, response) => {
  const rows = database.prepare(`
    SELECT id, name, email, phone, institution, shirt_size, shirt_color, event_id, created_at
    FROM registrations ORDER BY created_at DESC, rowid DESC
  `).all();
  response.json(rows.map((registration) => ({
    id: registration.id,
    name: registration.name,
    email: registration.email,
    phone: registration.phone,
    institution: registration.institution,
    shirtSize: registration.shirt_size,
    shirtColor: registration.shirt_color,
    eventId: registration.event_id || "",
    createdAt: registration.created_at
  })));
});

app.post("/api/admin/events", requireAdmin, (request, response, next) => {
  upload.single("media")(request, response, async (uploadError) => {
    if (uploadError) return next(uploadError);
    const title = cleanText(request.body.title, 100);
    const location = cleanText(request.body.location, 100);
    const date = cleanText(request.body.date, 10);
    const status = cleanText(request.body.status, 20);
    const description = cleanText(request.body.description, 400);
    const institutions = [...new Set(cleanText(request.body.institutions, 1000).split(",").map((name) => name.trim()).filter(Boolean))].slice(0, 20);
    if (!title || !location || !["upcoming", "current", "past"].includes(status) || !validDate(date)) {
      if (request.file) await fs.rm(request.file.path, { force: true });
      return response.status(400).json({ error: "Enter an event name, location, valid date, and event status." });
    }
    const event = {
      id: crypto.randomUUID(),
      title,
      location,
      date,
      status,
      description,
      institutions,
      media: request.file ? request.file.filename : null
    };
    try {
      database.prepare(`
        INSERT INTO events (id, title, location, date, status, description, institutions, media, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.title,
        event.location,
        event.date,
        event.status,
        event.description,
        JSON.stringify(event.institutions),
        event.media,
        new Date().toISOString()
      );
      response.status(201).json(serializeEvent(event));
    } catch (error) {
      if (request.file) await fs.rm(request.file.path, { force: true }).catch(() => {});
      next(error);
    }
  });
});

app.delete("/api/admin/events/:id", requireAdmin, async (request, response, next) => {
  try {
    const removed = database.prepare("SELECT media FROM events WHERE id = ?").get(request.params.id);
    if (!removed) return response.status(404).json({ error: "That event no longer exists." });
    database.prepare("DELETE FROM events WHERE id = ?").run(request.params.id);
    if (removed.media) await fs.rm(path.join(uploadDirectory, removed.media), { force: true });
    response.json({ message: "Event removed." });
  } catch (error) {
    next(error);
  }
});

app.use((error, request, response, next) => {
  if (response.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE" ? "Media files must be 50 MB or smaller." : "The uploaded file could not be accepted.";
    return response.status(400).json({ error: message });
  }
  if (request.path.startsWith("/api/")) {
    console.error("API request failed:", error);
    return response.status(500).json({ error: "The server could not complete that request. Please try again." });
  }
  if (error.status === 404) return response.status(404).send("File not found.");
  console.error("Request failed:", error);
  response.status(500).send("The server could not complete that request.");
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(token);
  }
}, 60 * 60 * 1000);
cleanupTimer.unref();

initialize().then(() => {
  app.listen(port, host, () => {
    console.log(`CYSo website is running at http://${host}:${port}`);
    if (host === "127.0.0.1" || host === "localhost") {
      console.log("The website is available on this computer only. See README.md before deploying publicly.");
    }
  });
}).catch((error) => {
  console.error("Could not start CYSo:", error);
  process.exitCode = 1;
});
