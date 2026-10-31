# VoxGuard: live AI-voice detection

Phone mic -> backend -> live dashboard. Several phones can connect at once; the dashboard shows how many and a verdict for each.

## Run (VS Code terminal)
```
python -m venv .venv
.venv\Scripts\activate        # Mac/Linux: source .venv/bin/activate
pip install -r requirements.txt
python main.py
```
1. Open **https://localhost:8000** on the laptop (accept the self-signed certificate warning once).
2. Click **Pair Phone** and scan the QR with the phone (same Wi-Fi). Accept the certificate warning on the phone
   (Android: Advanced -> Proceed; iPhone: Show Details -> visit this website).
3. Tap **Start protection** and allow the microphone.
4. Put the incoming call on **speaker** next to the phone (or play a cloned voice from another device).
   A verdict appears about 2 s after someone starts talking. More phones = repeat steps 2-3; click a phone card to pin it.

HTTPS is required because phone browsers block microphone access on plain http pages.

## Files
| file | job |
|---|---|
| `main.py` | FastAPI server: QR, phone audio socket, dashboard socket, device list |
| `detector.py` | voice scorer (swap `score()` for a trained model) |
| `tls.py` | makes the self-signed certificate |
| `static/index.html`, `static/app.js` | your Stitch dashboard, wired to live data |
| `static/mobile.html` | page the phone opens |

## Troubleshooting
- QR opens nothing / phone can't connect: allow Python through the Windows firewall (private network, port 8000).
  College/guest Wi-Fi often blocks device-to-device traffic; use your phone's hotspot for the laptop instead.
  Wrong IP in QR: `set HOST_IP=192.168.x.x` before `python main.py`.
- Different port: `set PORT=9000`. Using a tunnel (ngrok etc.): `set PUBLIC_URL=https://your-tunnel-url`.

## Tuning the detector
The scoring thresholds (`RAMPS` in `detector.py`) are hand-picked, not trained. Test with real samples and adjust:
`python detector.py human_sample.wav` and `python detector.py cloned_sample.wav` (16-bit WAV) print the three
measurements per half-second; move the RAMPS values so the two sets land on opposite sides.
