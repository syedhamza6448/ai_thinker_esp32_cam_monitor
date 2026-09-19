// ESP32-CAM relay backend — Deno Deploy edition
// -------------------------------------------------------------
// Deploy this file directly on Deno Deploy (deno.com/deploy), free, no card.
//
// Why this looks different from a normal Node/Express server:
// Deno Deploy runs your code in multiple regions at once, so a plain
// in-memory relay would only work if your camera and your browser
// happened to connect to the same region. BroadcastChannel fixes that:
// it's a Deno Deploy primitive that fans a message out to every region
// your code is currently running in, so live frames and sensor readings
// reach every connected browser no matter which region they landed on.
//
// Required env vars (set these in the Deno Deploy dashboard, no .env file):
//   DEVICE_SECRET, AUTH_USERNAME, AUTH_PASSWORD, JWT_SECRET,
//   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
// Cloudinary is required here (not optional like the Node version) because
// Deno Deploy has no writable disk to fall back to — everything is
// stateless except KV and BroadcastChannel.

import bcrypt from "npm:bcryptjs@2.4.3";
const { compare, hash } = bcrypt;
import { SignJWT, jwtVerify } from "npm:jose@5.9.6";

const DEVICE_SECRET = Deno.env.get("DEVICE_SECRET")!;
const AUTH_USERNAME = Deno.env.get("AUTH_USERNAME")!;
const AUTH_PASSWORD_HASH = await hash(Deno.env.get("AUTH_PASSWORD")!, 10);
const JWT_SECRET = new TextEncoder().encode(Deno.env.get("JWT_SECRET")!);
const CLOUDINARY_CLOUD_NAME = Deno.env.get("CLOUDINARY_CLOUD_NAME")!;
const CLOUDINARY_API_KEY = Deno.env.get("CLOUDINARY_API_KEY")!;
const CLOUDINARY_API_SECRET = Deno.env.get("CLOUDINARY_API_SECRET")!;

const kv = await Deno.openKv();
const bc = new BroadcastChannel("camera-relay");

// These two only hold sockets connected to THIS region/isolate.
// BroadcastChannel is what makes that fine.
const localClientSockets = new Set<WebSocket>();
let localDeviceSocket: WebSocket | null = null;

const FRAME_TYPE_LIVE = 1;
const FRAME_TYPE_CAPTURE = 2;

async function issueToken(username: string) {
  return await new SignJWT({ username })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .sign(JWT_SECRET);
}

async function verifyToken(token: string) {
  try {
    await jwtVerify(token, JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

bc.onmessage = (event) => {
  const msg = event.data;
  if (msg.kind === "frame") {
    const bytes = new Uint8Array(msg.bytes);
    for (const ws of localClientSockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
    }
  } else if (msg.kind === "sensor" || msg.kind === "photo-saved") {
    const json = JSON.stringify(msg.payload);
    for (const ws of localClientSockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  } else if (msg.kind === "capture-command") {
    if (localDeviceSocket && localDeviceSocket.readyState === WebSocket.OPEN) {
      localDeviceSocket.send("capture");
    }
  }
};

async function uploadToCloudinary(bytes: Uint8Array, timestamp: number) {
  const paramsToSign = `timestamp=${timestamp}`;
  const sigBuf = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(paramsToSign + CLOUDINARY_API_SECRET)
  );
  const signature = [...new Uint8Array(sigBuf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const form = new FormData();
  form.append("file", new Blob([bytes]), `capture-${timestamp}.jpg`);
  form.append("api_key", CLOUDINARY_API_KEY);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);

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

  bc.postMessage({ kind: "photo-saved", payload: entry });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/api/login" && req.method === "POST") {
    const { username, password } = await req.json();
    if (username !== AUTH_USERNAME || !(await compare(password ?? "", AUTH_PASSWORD_HASH))) {
      return Response.json({ error: "Wrong username or password" }, { status: 401 });
    }
    return Response.json({ ok: true, token: await issueToken(username) });
  }

  if (url.pathname === "/api/photos" && req.method === "GET") {
    const token = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
    if (!(await verifyToken(token))) return Response.json({ error: "Not logged in" }, { status: 401 });
    const list = (await kv.get<any[]>(["photos"])).value ?? [];
    return Response.json([...list].reverse());
  }

  if (url.pathname === "/api/capture" && req.method === "POST") {
    const token = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
    if (!(await verifyToken(token))) return Response.json({ error: "Not logged in" }, { status: 401 });
    bc.postMessage({ kind: "capture-command" });
    return Response.json({ ok: true });
  }

  if (url.pathname === "/device") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    let authed = false;
    socket.onmessage = async (event) => {
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data);
        if (msg.type === "auth" && msg.secret === DEVICE_SECRET) {
          authed = true;
          localDeviceSocket = socket;
        } else if (msg.type === "sensor" && authed) {
          const reading = { tempC: msg.tempC, humidity: msg.humidity, updatedAt: Date.now() };
          await kv.set(["latest-reading"], reading);
          bc.postMessage({ kind: "sensor", payload: reading });
        }
        return;
      }
      if (!authed) return;
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      const frameType = bytes[0];
      const jpeg = bytes.slice(1); // copy, so BroadcastChannel doesn't clone extra bytes
      if (frameType === FRAME_TYPE_LIVE) {
        bc.postMessage({ kind: "frame", bytes: jpeg.buffer });
      } else if (frameType === FRAME_TYPE_CAPTURE) {
        savePhoto(jpeg).catch((e) => console.error("Save photo failed:", e));
      }
    };
    socket.onclose = () => {
      if (localDeviceSocket === socket) localDeviceSocket = null;
    };
    return response;
  }

  if (url.pathname === "/client") {
    const token = url.searchParams.get("token") ?? "";
    if (!(await verifyToken(token))) return new Response("Unauthorized", { status: 401 });
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => localClientSockets.add(socket);
    socket.onclose = () => localClientSockets.delete(socket);
    return response;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    const html = await Deno.readTextFile(new URL("./public/index.html", import.meta.url));
    return new Response(html, { headers: { "content-type": "text/html" } });
  }

  return new Response("Not found", { status: 404 });
});