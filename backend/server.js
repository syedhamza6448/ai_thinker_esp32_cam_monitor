// ESP32-CAM relay backend
// -------------------------------------------------------------
// Two kinds of WebSocket clients connect here:
//   /device -> your ESP32-CAM (proves itself with DEVICE_SECRET)
//   /client -> your browser (proves itself with a login JWT)
// The server relays live frames from the device to every logged-in
// browser, and on a "capture" request saves one photo to the cloud.

require("dotenv").config();
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { WebSocketServer } = require("ws");

const {
  DEVICE_SECRET,
  AUTH_USERNAME,
  AUTH_PASSWORD,
  JWT_SECRET,
  PORT = 3000,
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
} = process.env;

if (!DEVICE_SECRET || !AUTH_USERNAME || !AUTH_PASSWORD || !JWT_SECRET) {
  console.error("Missing required env vars. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

// Password is hashed once at boot so the plaintext only ever lives in .env
const AUTH_PASSWORD_HASH = bcrypt.hashSync(AUTH_PASSWORD, 10);
const USE_CLOUDINARY = CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET;

const PHOTOS_DIR = path.join(__dirname, "photos");
const PHOTOS_META_FILE = path.join(PHOTOS_DIR, "photos.json");
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
if (!fs.existsSync(PHOTOS_META_FILE)) fs.writeFileSync(PHOTOS_META_FILE, "[]");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));
app.use("/photos", express.static(PHOTOS_DIR)); // only used in local-disk fallback mode

// ---------- Auth helpers ----------
function requireAuth(req, res, next) {
  const token = req.cookies.token || (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not logged in" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session" });
  }
}

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username !== AUTH_USERNAME || !bcrypt.compareSync(password || "", AUTH_PASSWORD_HASH)) {
    return res.status(401).json({ error: "Wrong username or password" });
  }
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
  res.cookie("token", token, { httpOnly: true, sameSite: "lax", secure: true, maxAge: 7 * 24 * 3600 * 1000 });
  res.json({ ok: true, token }); // token also returned for the WS query-string handshake
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

app.get("/api/photos", requireAuth, (req, res) => {
  const list = JSON.parse(fs.readFileSync(PHOTOS_META_FILE, "utf8"));
  res.json(list.reverse());
});

app.post("/api/capture", requireAuth, (req, res) => {
  if (!deviceSocket) return res.status(503).json({ error: "Camera is not connected right now" });
  deviceSocket.send("capture");
  res.json({ ok: true });
});

app.get("/api/latest-reading", requireAuth, (req, res) => {
  res.json(latestReading);
});

const server = http.createServer(app);

// ---------- WebSocket relay ----------
const wssDevice = new WebSocketServer({ noServer: true });
const wssClient = new WebSocketServer({ noServer: true });

let deviceSocket = null;
let deviceAuthed = false;
const clientSockets = new Set();
let latestReading = { tempC: null, humidity: null, updatedAt: null };

const FRAME_TYPE_LIVE = 0x01;
const FRAME_TYPE_CAPTURE = 0x02;

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/device") {
    wssDevice.handleUpgrade(req, socket, head, (ws) => wssDevice.emit("connection", ws, req));
  } else if (url.pathname === "/client") {
    const token = url.searchParams.get("token");
    try {
      jwt.verify(token, JWT_SECRET);
    } catch {
      socket.destroy();
      return;
    }
    wssClient.handleUpgrade(req, socket, head, (ws) => wssClient.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wssDevice.on("connection", (ws) => {
  console.log("Device connecting...");
  deviceAuthed = false;

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "auth") {
        if (msg.secret === DEVICE_SECRET) {
          deviceAuthed = true;
          deviceSocket = ws;
          console.log("Device authenticated.");
        } else {
          console.log("Device sent wrong secret, dropping connection.");
          ws.close();
        }
      } else if (msg.type === "sensor" && deviceAuthed) {
        latestReading = { tempC: msg.tempC, humidity: msg.humidity, updatedAt: Date.now() };
        broadcastToClients(JSON.stringify({ type: "sensor", ...latestReading }));
      }
      return;
    }

    if (!deviceAuthed) return; // ignore binary frames until authed
    const frameType = data[0];
    const jpeg = data.subarray(1);

    if (frameType === FRAME_TYPE_LIVE) {
      broadcastToClients(jpeg, true);
    } else if (frameType === FRAME_TYPE_CAPTURE) {
      savePhoto(jpeg).catch((err) => console.error("Save photo failed:", err));
    }
  });

  ws.on("close", () => {
    if (ws === deviceSocket) {
      deviceSocket = null;
      deviceAuthed = false;
      console.log("Device disconnected.");
    }
  });
});

wssClient.on("connection", (ws) => {
  clientSockets.add(ws);
  ws.send(JSON.stringify({ type: "sensor", ...latestReading }));
  ws.on("close", () => clientSockets.delete(ws));
});

function broadcastToClients(payload, isBinary = false) {
  for (const ws of clientSockets) {
    if (ws.readyState === ws.OPEN) ws.send(payload, { binary: isBinary });
  }
}

// ---------- Saving a capture ----------
async function savePhoto(jpegBuffer) {
  const timestamp = Date.now();
  let url;

  if (USE_CLOUDINARY) {
    url = await uploadToCloudinary(jpegBuffer, timestamp);
  } else {
    const filename = `capture-${timestamp}.jpg`;
    fs.writeFileSync(path.join(PHOTOS_DIR, filename), jpegBuffer);
    url = `/photos/${filename}`; // served locally - see README about persistence
  }

  const list = JSON.parse(fs.readFileSync(PHOTOS_META_FILE, "utf8"));
  list.push({ url, takenAt: timestamp });
  fs.writeFileSync(PHOTOS_META_FILE, JSON.stringify(list, null, 2));

  broadcastToClients(JSON.stringify({ type: "photo-saved", url, takenAt: timestamp }));
  console.log("Saved capture:", url);
}

async function uploadToCloudinary(buffer, timestamp) {
  const paramsToSign = `timestamp=${timestamp}`;
  const signature = crypto
    .createHash("sha1")
    .update(paramsToSign + CLOUDINARY_API_SECRET)
    .digest("hex");

  const form = new FormData();
  form.append("file", new Blob([buffer]), `capture-${timestamp}.jpg`);
  form.append("api_key", CLOUDINARY_API_KEY);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
    method: "POST",
    body: form,
  });
  const json = await res.json();
  if (!json.secure_url) throw new Error("Cloudinary upload failed: " + JSON.stringify(json));
  return json.secure_url;
}

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
