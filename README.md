# Room Camera: ESP32-CAM + DHT11 + Cloud Relay

## How it works
Your ESP32-CAM doesn't need to be reachable from the internet at all — it just
opens an outbound WebSocket connection to a small backend server you deploy
(the same way a phone app talks to a server). That backend:
- relays the live video to your browser, but only after you log in
- keeps the latest temperature/humidity reading
- saves any photo you capture to Cloudinary (real cloud storage)

This sidesteps port-forwarding, DDNS, and the fact that most home ISPs
(including many in Pakistan) put you behind CGNAT, which makes direct
port-forwarding to your ESP32 unreliable or impossible anyway.

```
ESP32-CAM  --(outbound WebSocket)-->  Backend server  <--(WebSocket + login)--  Your browser, anywhere
   + DHT11         (always on,             (Deno Deploy, free)
                     no card needed)
```

There are two backend folders — use one, not both:
- **`backend-deno/`** — deploy to Deno Deploy. Free, no credit card, always-on. Use this one.
- **`backend/`** — the plain Node/Express version, for if you ever move to a paid VPS or Render/Railway instead. Not used in the steps below.

## 1. Wire the DHT11
- VCC -> 3.3V
- GND -> GND
- DATA -> GPIO 13 (add a 10K resistor DATA-to-VCC if your DHT11 board is bare, most small 3-pin modules already have it built in)

Don't touch GPIO 0, 4, 12, 14, 15, 16 — the camera and flash LED use them.

## 2. Deploy the backend (Deno Deploy, free, no credit card)
1. Sign up at dash.deno.com (GitHub login, no card).
2. Push this whole project to a GitHub repo (or just the `backend-deno/`
   folder — either works), then in the Deno Deploy dashboard: **New
   Project -> Import from GitHub**, pick the repo, and set the entry point
   to `backend-deno/server.ts`.
3. Sign up free at cloudinary.com and grab your `Cloud name`, `API Key`,
   and `API Secret` from the dashboard — this is required here (Deno
   Deploy has no writable disk, so photos must go to real cloud storage,
   unlike the Node version which could fall back to local disk).
4. In your Deno Deploy project settings, add these environment variables:
   - `DEVICE_SECRET` — any long random string, must match `firmware.ino`
   - `AUTH_USERNAME` / `AUTH_PASSWORD` — your login
   - `JWT_SECRET` — another long random string
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
5. Deploy. Your live URL appears in the dashboard, e.g.
   `your-project.deno.dev` — that's the `WS_HOST` value for the firmware
   (no `https://` prefix, just the domain).

## 3. Flash the ESP32-CAM
1. Open `firmware/firmware.ino` in Arduino IDE (install the ESP32 board
   package and the "WebSockets" + "DHT sensor library" libraries first).
2. Set `WIFI_SSID`, `WIFI_PASSWORD`.
3. Set `WS_HOST` to your Deno Deploy domain (from step 2.5), `WS_PORT = 443`,
   `WS_USE_TLS = true`.
4. Set `DEVICE_SECRET` to match your `.env`.
5. Select board "AI Thinker ESP32-CAM", connect via a USB-to-serial adapter
   (GPIO 0 to GND while resetting to enter flash mode, standard for this board), upload.

## 4. Use it
Open `https://your-project.deno.dev` from any phone or laptop, log in,
and you'll see the live feed, temperature/humidity, and a Capture button.
Captured photos land in the gallery and in your Cloudinary account.

## Notes
- Live view runs at ~6-7fps at 320x240 to stay light on the ESP32's single
  core and your free-tier bandwidth — plenty for a room monitor, not meant
  to be broadcast-quality.
- All auth is a single hardcoded user (you). If you ever want more than one
  person to log in, the JWT/login structure is already there to extend.
- If the ESP32 loses WiFi, it auto-reconnects the WebSocket every 3s.
