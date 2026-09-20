// ESP32-CAM relay backend — Deno Deploy edition
// -------------------------------------------------------------
// Deploy this file directly on Deno Deploy (deno.com/deploy), free, no card.
//
// Two roles:
//   admin  - you. username+password login, 7-day session, full control.
//   viewer - "close ones". Enter a name + the shared VIEWER_PASSWORD.
//            First time, they sit in "pending" until you approve them by
//            name from the Watchers panel. Once approved, that name can
//            log back in anytime (5-minute sessions) until you revoke it.
//            Viewers can only watch — capture/flash/delete/viewer
//            management are admin-only.
//
// Why this looks different from a normal Node/Express server:
// Deno Deploy runs your code in multiple regions at once, so a plain
// in-memory relay would only work if your camera and your browser
// happened to connect to the same region. BroadcastChannel fixes that:
// it fans a message out to every region your code is currently running
// in, so live frames and sensor readings reach every connected browser
// no matter which region they landed on.
//
// Required env vars (set these in the Deno Deploy dashboard, no .env file):
//   DEVICE_SECRET, AUTH_USERNAME, AUTH_PASSWORD, VIEWER_PASSWORD,
//   JWT_SECRET, CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET

import bcrypt from "npm:bcryptjs@2.4.3";
const { compare, hash } = bcrypt;
import { SignJWT, jwtVerify } from "npm:jose@5.9.6";

const DEVICE_SECRET = Deno.env.get("DEVICE_SECRET")!;
const AUTH_USERNAME = Deno.env.get("AUTH_USERNAME")!;
const AUTH_PASSWORD_HASH = await hash(Deno.env.get("AUTH_PASSWORD")!, 10);
const VIEWER_PASSWORD = Deno.env.get("VIEWER_PASSWORD")!;
const JWT_SECRET = new TextEncoder().encode(Deno.env.get("JWT_SECRET")!);
const CLOUDINARY_CLOUD_NAME = Deno.env.get("CLOUDINARY_CLOUD_NAME")!;
const CLOUDINARY_UPLOAD_PRESET = Deno.env.get("CLOUDINARY_UPLOAD_PRESET")!;

const kv = await Deno.openKv();
const bc = new BroadcastChannel("camera-relay");

const localClientSockets = new Set<WebSocket>();
let localDeviceSocket: WebSocket | null = null;

const FRAME_TYPE_LIVE = 1;
const FRAME_TYPE_CAPTURE = 2;

// ---------------- Auth ----------------
interface TokenPayload {
  role: string; // "admin" | "viewer"
  name?: string;
}

async function issueAdminToken() {
  return await new SignJWT({ role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .sign(JWT_SECRET);
}

async function issueViewerToken(name: string) {
  return await new SignJWT({ role: "viewer", name })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("5m")
    .sign(JWT_SECRET);
}

async function decodeToken(token: string): Promise<TokenPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as unknown as TokenPayload;
  } catch {
    return null;
  }
}

function getToken(req: Request, url: URL) {
  const header = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
  return header || url.searchParams.get("token") || "";
}

async function requireAdmin(req: Request, url: URL): Promise<Response | null> {
  const payload = await decodeToken(getToken(req, url));
  if (!payload || payload.role !== "admin") {
    return Response.json({ error: "Admin only" }, { status: 403 });
  }
  return null; // null means "ok, proceed"
}

// ---------------- Viewer records ----------------
type ViewerStatus = "pending" | "approved" | "revoked";
interface ViewerRecord {
  name: string; // display name, as typed
  key: string; // lowercase lookup key
  status: ViewerStatus;
  requestedAt: number;
  approvedAt?: number;
}

async function getViewer(key: string): Promise<ViewerRecord | null> {
  const res = await kv.get<ViewerRecord>(["viewers", key]);
  return res.value ?? null;
}

async function listViewers(): Promise<ViewerRecord[]> {
  const out: ViewerRecord[] = [];
  for await (const entry of kv.list<ViewerRecord>({ prefix: ["viewers"] })) {
    out.push(entry.value);
  }
  return out.sort((a, b) => b.requestedAt - a.requestedAt);
}

// ---------------- Relay (device <-> browsers) ----------------
bc.onmessage = (event) => {
  const msg = event.data;
  if (msg.kind === "frame") {
    const bytes = new Uint8Array(msg.bytes);
    for (const ws of localClientSockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
    }
  } else if (msg.kind === "sensor" || msg.kind === "photo-saved") {
    const json = JSON.stringify({ type: msg.kind, ...msg.payload });
    for (const ws of localClientSockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  } else if (msg.kind === "capture-command") {
    if (localDeviceSocket && localDeviceSocket.readyState === WebSocket.OPEN) {
      localDeviceSocket.send("capture");
    }
  } else if (msg.kind === "flash-command") {
    if (localDeviceSocket && localDeviceSocket.readyState === WebSocket.OPEN) {
      localDeviceSocket.send(msg.command);
    }
  }
};

function relayFrame(bytes: Uint8Array) {
  for (const ws of localClientSockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
  }
  bc.postMessage({ kind: "frame", bytes: bytes.buffer });
}

function relayJson(kind: "sensor" | "photo-saved", payload: object) {
  const json = JSON.stringify({ type: kind, ...payload });
  for (const ws of localClientSockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  }
  bc.postMessage({ kind, payload });
}

// ---------------- Cloudinary ----------------
async function uploadToCloudinary(bytes: Uint8Array, timestamp: number) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), `capture-${timestamp}.jpg`);
  form.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
    { method: "POST", body: form }
  );
  const json = await res.json();
  if (!json.secure_url) throw new Error("Cloudinary upload failed: " + JSON.stringify(json));
  return json.secure_url as string;
}

async function savePhoto(bytes: Uint8Array) {
  const timestamp = Date.now();
  const url = await uploadToCloudinary(bytes, timestamp);

  const entry = { url, takenAt: timestamp };
  const list = (await kv.get<any[]>(["photos"])).value ?? [];
  list.push(entry);
  await kv.set(["photos"], list);

  relayJson("photo-saved", entry);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // ---------- Admin login ----------
  if (url.pathname === "/api/login" && req.method === "POST") {
    const { username, password } = await req.json();
    if (username !== AUTH_USERNAME || !(await compare(password ?? "", AUTH_PASSWORD_HASH))) {
      return Response.json({ error: "Wrong username or password" }, { status: 401 });
    }
    return Response.json({ ok: true, role: "admin", token: await issueAdminToken() });
  }

  // ---------- Viewer login / request access ----------
  if (url.pathname === "/api/viewer-login" && req.method === "POST") {
    const { name, password } = await req.json();
    const cleanName = (name ?? "").trim();
    if (!cleanName) return Response.json({ error: "Enter your name" }, { status: 400 });
    if (password !== VIEWER_PASSWORD) {
      return Response.json({ error: "Wrong password" }, { status: 401 });
    }

    const key = cleanName.toLowerCase();
    let viewer = await getViewer(key);
    if (!viewer) {
      viewer = { name: cleanName, key, status: "pending", requestedAt: Date.now() };
      await kv.set(["viewers", key], viewer);
    }

    if (viewer.status === "approved") {
      return Response.json({ ok: true, role: "viewer", name: viewer.name, token: await issueViewerToken(viewer.name) });
    }
    return Response.json({ ok: false, status: viewer.status }); // "pending" or "revoked"
  }

  // ---------- Admin: manage viewers ----------
  if (url.pathname === "/api/viewers" && req.method === "GET") {
    const denied = await requireAdmin(req, url);
    if (denied) return denied;
    return Response.json(await listViewers());
  }

  if (url.pathname === "/api/viewers/approve" && req.method === "POST") {
    const denied = await requireAdmin(req, url);
    if (denied) return denied;
    const { key } = await req.json();
    const viewer = await getViewer(key);
    if (!viewer) return Response.json({ error: "Not found" }, { status: 404 });
    viewer.status = "approved";
    viewer.approvedAt = Date.now();
    await kv.set(["viewers", key], viewer);
    return Response.json({ ok: true });
  }

  if (url.pathname === "/api/viewers/revoke" && req.method === "POST") {
    const denied = await requireAdmin(req, url);
    if (denied) return denied;
    const { key } = await req.json();
    const viewer = await getViewer(key);
    if (!viewer) return Response.json({ error: "Not found" }, { status: 404 });
    viewer.status = "revoked";
    await kv.set(["viewers", key], viewer);
    return Response.json({ ok: true });
  }

  if (url.pathname === "/api/viewers/delete" && req.method === "POST") {
    const denied = await requireAdmin(req, url);
    if (denied) return denied;
    const { key } = await req.json();
    await kv.delete(["viewers", key]);
    return Response.json({ ok: true });
  }

  if (url.pathname === "/api/viewers/add" && req.method === "POST") {
    const denied = await requireAdmin(req, url);
    if (denied) return denied;
    const { name } = await req.json();
    const cleanName = (name ?? "").trim();
    if (!cleanName) return Response.json({ error: "Name required" }, { status: 400 });
    const key = cleanName.toLowerCase();
    const viewer: ViewerRecord = {
      name: cleanName,
      key,
      status: "approved",
      requestedAt: Date.now(),
      approvedAt: Date.now(),
    };
    await kv.set(["viewers", key], viewer);
    return Response.json({ ok: true });
  }

  // ---------- Photos ----------
  if (url.pathname === "/api/photos" && req.method === "GET") {
    const payload = await decodeToken(getToken(req, url));
    if (!payload) return Response.json({ error: "Not logged in" }, { status: 401 });
    const list = (await kv.get<any[]>(["photos"])).value ?? [];
    return Response.json([...list].reverse());
  }

  if (url.pathname === "/api/photos/delete" && req.method === "POST") {
    const denied = await requireAdmin(req, url);
    if (denied) return denied;
    const { url: photoUrl } = await req.json();
    const list = (await kv.get<any[]>(["photos"])).value ?? [];
    const filtered = list.filter((p: any) => p.url !== photoUrl);
    await kv.set(["photos"], filtered);
    return Response.json({ ok: true });
  }

  // ---------- Capture / Flash (admin only) ----------
  if (url.pathname === "/api/capture" && req.method === "POST") {
    const denied = await requireAdmin(req, url);
    if (denied) return denied;
    console.log("Capture requested. Device on this isolate?", !!localDeviceSocket);
    if (localDeviceSocket && localDeviceSocket.readyState === WebSocket.OPEN) {
      localDeviceSocket.send("capture");
    }
    bc.postMessage({ kind: "capture-command" });
    return Response.json({ ok: true });
  }

  if (url.pathname === "/api/flash" && req.method === "POST") {
    const denied = await requireAdmin(req, url);
    if (denied) return denied;
    let on = false;
    try {
      const body = await req.json();
      on = !!body.on;
    } catch (e) {
      console.error("Flash request: failed to parse body", e);
      return Response.json({ error: "Bad request body" }, { status: 400 });
    }
    const command = on ? "flash_on" : "flash_off";
    console.log("Flash requested:", command, "- Device on this isolate?", !!localDeviceSocket);
    if (localDeviceSocket && localDeviceSocket.readyState === WebSocket.OPEN) {
      localDeviceSocket.send(command);
    }
    bc.postMessage({ kind: "flash-command", command });
    return Response.json({ ok: true });
  }

  // ---------- Device WebSocket ----------
  if (url.pathname === "/device") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    let authed = false;
    console.log("Device: WebSocket opened, waiting for auth...");
    socket.onmessage = async (event) => {
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data);
        if (msg.type === "auth" && msg.secret === DEVICE_SECRET) {
          authed = true;
          localDeviceSocket = socket;
          console.log("Device: authenticated OK");
        } else if (msg.type === "auth") {
          console.log("Device: auth FAILED, secret mismatch");
        } else if (msg.type === "sensor" && authed) {
          const reading = { tempC: msg.tempC, humidity: msg.humidity, updatedAt: Date.now() };
          await kv.set(["latest-reading"], reading);
          relayJson("sensor", reading);
        }
        return;
      }
      if (!authed) return;
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      const frameType = bytes[0];
      const jpeg = bytes.slice(1);
      if (frameType === FRAME_TYPE_LIVE) {
        relayFrame(jpeg);
      } else if (frameType === FRAME_TYPE_CAPTURE) {
        savePhoto(jpeg).catch((e) => console.error("Save photo failed:", e));
      }
    };
    socket.onclose = () => {
      console.log("Device: WebSocket closed");
      if (localDeviceSocket === socket) localDeviceSocket = null;
    };
    return response;
  }

  // ---------- Client WebSocket (admin or approved viewer) ----------
  if (url.pathname === "/client") {
    const payload = await decodeToken(url.searchParams.get("token") ?? "");
    if (!payload) return new Response("Unauthorized", { status: 401 });
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => localClientSockets.add(socket);
    socket.onclose = () => localClientSockets.delete(socket);
    return response;
  }

  // ---------- Static frontend ----------
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const html = await Deno.readTextFile(new URL("./public/index.html", import.meta.url));
    return new Response(html, { headers: { "content-type": "text/html" } });
  }

  return new Response("Not found", { status: 404 });
});