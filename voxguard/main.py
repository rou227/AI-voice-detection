"""
VoxGuard backend.   Run:  python main.py      then open https://localhost:8000

  GET /              dashboard (laptop)
  GET /mobile        page the phone opens after scanning the QR
  GET /qr            QR code PNG -> /mobile
  GET /api/info      {url, ip}  (pairing URL shown in the dashboard)
  WS  /ws/audio      phone  -> raw 16-bit PCM        (?sr=48000&name=Pixel)
  WS  /ws/dashboard  laptop <- live devices / spectrum / verdicts
"""
import io
import os
import socket
import time
import uuid
from pathlib import Path

import numpy as np
import qrcode
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from detector import Detector, bands
from tls import ensure_cert

BASE, PORT = Path(__file__).parent / "static", int(os.getenv("PORT", 8000))
app = FastAPI(title="VoxGuard")
app.mount("/static", StaticFiles(directory=BASE), name="static")

dashboards: set[WebSocket] = set()
devices: dict[str, dict] = {}                       # id -> live info for each connected phone
stats = {"total": 0, "ai": 0, "human": 0, "uncertain": 0}


def local_ip() -> str:
    if os.getenv("HOST_IP"):
        return os.environ["HOST_IP"]
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))                  # no packet sent; just picks the LAN interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def base_url() -> str:                              # set PUBLIC_URL to use an ngrok/cloudflared tunnel
    return os.getenv("PUBLIC_URL", f"https://{local_ip()}:{PORT}").rstrip("/")


async def broadcast(msg: dict):
    for ws in list(dashboards):
        try:
            await ws.send_json(msg)
        except Exception:
            dashboards.discard(ws)


def device_list():
    now = time.time()
    return [{**{k: d[k] for k in ("id", "name", "sr", "label", "confidence", "ai_score")},
             "up": int(now - d["since"])} for d in devices.values()]


async def push_devices():
    await broadcast({"type": "devices", "devices": device_list(), "stats": stats})


@app.get("/")
def dashboard_page():
    return FileResponse(BASE / "index.html")


@app.get("/mobile")
def mobile_page():
    return FileResponse(BASE / "mobile.html")


@app.get("/api/info")
def info():
    return {"url": f"{base_url()}/mobile", "ip": local_ip()}


@app.get("/qr")
def qr_code():
    buf = io.BytesIO()
    qrcode.make(f"{base_url()}/mobile", box_size=8, border=2).save(buf, format="PNG")
    buf.seek(0)
    return StreamingResponse(buf, media_type="image/png")


@app.websocket("/ws/dashboard")
async def ws_dashboard(ws: WebSocket):
    await ws.accept()
    dashboards.add(ws)
    await ws.send_json({"type": "devices", "devices": device_list(), "stats": stats})
    try:
        while True:
            await ws.send_json({"type": "pong", "t": await ws.receive_text()})   # latency probe
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        dashboards.discard(ws)


@app.websocket("/ws/audio")
async def ws_audio(ws: WebSocket):
    await ws.accept()
    q = ws.query_params
    dev = {"id": uuid.uuid4().hex[:6], "name": (q.get("name") or "Phone")[:32], "sr": int(q.get("sr", 16000)),
           "since": time.time(), "label": "Listening", "confidence": 0, "ai_score": 0}
    det = Detector(dev["sr"])
    devices[dev["id"]] = dev
    await push_devices()
    try:
        while True:
            raw = await ws.receive_bytes()
            if len(raw) < 512:                      # ignore empty / tiny frames
                continue
            pcm = np.frombuffer(raw[: len(raw) // 2 * 2], np.int16).astype(np.float32) / 32768.0
            b, level = bands(pcm, dev["sr"])
            await broadcast({"type": "spectrum", "device": dev["id"], "bands": b, "level_db": level})
            t0 = time.perf_counter()
            r = det.push(pcm)
            if r is None:
                continue
            dev.update(label=r["label"], confidence=r["confidence"], ai_score=r["ai_score"])
            if r["label"] != "Listening":
                stats["total"] += 1
                stats[{"AI-Cloned": "ai", "Human": "human", "Uncertain": "uncertain"}[r["label"]]] += 1
            msg = {"type": "result", "device": dev["id"], "name": dev["name"], "sr": dev["sr"], "ts": time.time(),
                   "up": int(time.time() - dev["since"]), "ms": round((time.perf_counter() - t0) * 1000, 1),
                   "stats": stats, **r}
            await ws.send_json(msg)                 # phone shows its own verdict too
            await broadcast(msg)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        devices.pop(dev["id"], None)
        await push_devices()


if __name__ == "__main__":
    ip = local_ip()
    cert, key = ensure_cert(ip)
    print(f"\n  Dashboard (laptop): https://localhost:{PORT}\n  Phone pairing URL : {base_url()}/mobile\n")
    uvicorn.run(app, host="0.0.0.0", port=PORT, ssl_certfile=cert, ssl_keyfile=key, log_level="warning")
