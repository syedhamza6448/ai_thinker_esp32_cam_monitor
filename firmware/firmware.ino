/*
  ESP32-CAM (AI-Thinker) + DHT11 -> Cloud Relay Backend
  ------------------------------------------------------
  What this does:
  - Connects to your WiFi
  - Opens an OUTBOUND WebSocket connection to your backend server
    (this is the trick that avoids port-forwarding / DDNS / CGNAT problems:
     the ESP32 calls OUT to your server, the server never has to call in)
  - Streams low-res JPEG frames continuously for the "live view"
  - Reads DHT11 temperature/humidity every 2s and sends it as JSON
  - When the server sends the text command "capture", takes ONE high-res
    photo and sends it tagged so the backend saves it permanently

  Libraries needed (install via Arduino Library Manager):
  - "WebSockets" by Markus Sattler (links2004/arduinoWebSockets)
  - "DHT sensor library" by Adafruit  (+ its dependency "Adafruit Unified Sensor")

  Board: AI Thinker ESP32-CAM
  Wiring for DHT11 (camera uses almost every other pin, so we're limited):
    DHT11 VCC  -> 3.3V
    DHT11 GND  -> GND
    DHT11 DATA -> GPIO 13   (add a 10K resistor between DATA and VCC if your
                              DHT11 module doesn't already have one on board)
  Do NOT use GPIO 0, 4, 12, 14, 15, 16 for anything else — they're used by
  the camera / flash LED / boot strapping.
*/

#include "esp_camera.h"
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <DHT.h>

// ------------- EDIT THESE -------------
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

const char* WS_HOST = "your-backend-domain.example.com";  // no https://, just the host
const int   WS_PORT = 443;          // 443 if backend uses TLS (recommended), 80 if plain http for local testing
const char* WS_PATH = "/device";
const bool  WS_USE_TLS = true;      // set false only for local testing over plain ws://

// This must match DEVICE_SECRET in the backend's .env file.
// It's how the server knows this is really your camera and not a random connection.
const char* DEVICE_SECRET = "change-this-to-a-long-random-string";
// ---------------------------------------

#define DHTPIN 13
#define DHTTYPE DHT11
DHT dht(DHTPIN, DHTTYPE);

WebSocketsClient webSocket;

// AI-Thinker ESP32-CAM pin map
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

bool wsConnected = false;
bool captureRequested = false;
unsigned long lastFrameSent = 0;
unsigned long lastDhtRead = 0;
const unsigned long FRAME_INTERVAL_MS = 150; // ~6-7 fps live view, gentle on ESP32 + bandwidth
const unsigned long DHT_INTERVAL_MS = 2000;  // DHT11 can't be read faster than ~1-2s

// Frame type markers we prefix onto binary websocket messages so the
// backend knows whether this is a "live view" frame or a "saved capture".
const uint8_t FRAME_TYPE_LIVE    = 0x01;
const uint8_t FRAME_TYPE_CAPTURE = 0x02;

void initCamera(framesize_t size, int quality) {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = size;
  config.jpeg_quality = quality;
  config.fb_count = psramFound() ? 2 : 1;
  config.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x\n", err);
    delay(2000);
    ESP.restart();
  }
}

void sendSensorReading() {
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (isnan(h) || isnan(t)) return; // skip a bad read, try again next cycle

  String json = "{\"type\":\"sensor\",\"tempC\":" + String(t, 1) +
                ",\"humidity\":" + String(h, 1) + "}";
  webSocket.sendTXT(json);
}

void sendFrame(uint8_t frameType, framesize_t size, int quality) {
  // Swap resolution for a one-off high quality capture, then swap back.
  sensor_t *s = esp_camera_sensor_get();
  s->set_framesize(s, size);
  s->set_quality(s, quality);

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Camera capture failed");
    return;
  }

  // Prefix a single type byte so the backend can tell live frames from
  // an on-demand capture without parsing JSON for every binary message.
  uint8_t *out = (uint8_t *)malloc(fb->len + 1);
  out[0] = frameType;
  memcpy(out + 1, fb->buf, fb->len);
  webSocket.sendBIN(out, fb->len + 1);
  free(out);
  esp_camera_fb_return(fb);
}

void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED: {
      wsConnected = true;
      Serial.println("WebSocket connected, authenticating...");
      String auth = "{\"type\":\"auth\",\"secret\":\"" + String(DEVICE_SECRET) + "\"}";
      webSocket.sendTXT(auth);
      break;
    }
    case WStype_DISCONNECTED:
      wsConnected = false;
      Serial.println("WebSocket disconnected");
      break;
    case WStype_TEXT: {
      String msg = String((char *)payload).substring(0, length);
      if (msg == "capture") {
        captureRequested = true;
      }
      break;
    }
    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);
  dht.begin();

  // Live view runs small/fast; we bump resolution only for a real capture.
  initCamera(FRAMESIZE_QVGA, 12);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("Connected, IP: ");
  Serial.println(WiFi.localIP());

  if (WS_USE_TLS) {
    webSocket.beginSSL(WS_HOST, WS_PORT, WS_PATH);
  } else {
    webSocket.begin(WS_HOST, WS_PORT, WS_PATH);
  }
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(3000);
}

void loop() {
  webSocket.loop();
  if (!wsConnected) return;

  unsigned long now = millis();

  if (captureRequested) {
    captureRequested = false;
    Serial.println("Taking high-res capture...");
    sendFrame(FRAME_TYPE_CAPTURE, FRAMESIZE_UXGA, 10);
    // Camera sensor stays in whatever mode we last set; next live frame
    // call below will reset it back to QVGA for streaming.
  }

  if (now - lastFrameSent > FRAME_INTERVAL_MS) {
    lastFrameSent = now;
    sendFrame(FRAME_TYPE_LIVE, FRAMESIZE_QVGA, 12);
  }

  if (now - lastDhtRead > DHT_INTERVAL_MS) {
    lastDhtRead = now;
    sendSensorReading();
  }
}
