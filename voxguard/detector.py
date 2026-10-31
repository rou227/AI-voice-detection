"""
VoxGuard detector: lightweight, explainable real-vs-AI voice scorer (numpy only).

Looks at 2 s of audio and measures three things synthetic voices tend to get
"too perfect" compared with a live human throat:
  pitch_var    - median frame-to-frame pitch change (cents)   low  => AI-like
  periodicity  - how clean/regular the voice waveform is      high => AI-like
  shimmer      - median frame-to-frame loudness change (dB)   low  => AI-like

NOTE: thresholds in RAMPS are hand-picked and UNTUNED on real data. For real
accuracy, replace score() with a trained model (AASIST / RawNet2 / wav2vec2).
Everything else (streaming, smoothing, dashboard) stays the same.
"""
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

SR = 16000
WINDOW_S, HOP_S = 2.0, 0.5
# feature -> (value that looks fully AI, value that looks fully human)
RAMPS = {"pitch_var": (8.0, 30.0), "periodicity": (0.92, 0.65), "shimmer": (0.8, 2.5)}
AI_ABOVE, HUMAN_BELOW = 60, 40  # smoothed score thresholds


_w = np.hanning(512)
_WIN_AC = np.fft.irfft(np.abs(np.fft.rfft(_w, 1024)) ** 2)[:512]
_WIN_AC = np.maximum(_WIN_AC / _WIN_AC[0], 0.3)


def to16k(x, sr):
    """Band-limited resample to 16 kHz (FFT truncation)."""
    if sr == SR:
        return x
    n = int(len(x) * SR / sr)
    return np.fft.irfft(np.fft.rfft(x)[: n // 2 + 1], n) * (n / len(x))


def features(x):
    """Return feature dict, or None if the window is silence / not voiced speech."""
    N, H = 512, 256
    if len(x) < N * 8:
        return None
    F = sliding_window_view(x, N)[::H] * np.hanning(N)
    rms = np.sqrt((F ** 2).mean(1))
    loud = rms > max(0.004, 0.25 * np.percentile(rms, 95))
    ac = np.fft.irfft(np.abs(np.fft.rfft(F, 2 * N)) ** 2)[:, :N]
    ac /= ac[:, :1] + 1e-12
    ac /= _WIN_AC                                               # undo Hann-window taper bias
    lo, hi = SR // 400, SR // 70                       # 70-400 Hz pitch range
    lag = ac[:, lo:hi].argmax(1) + lo
    i = np.arange(len(ac))
    a0, a1, a2 = ac[i, lag - 1], ac[i, lag], ac[i, lag + 1]
    lag = lag + 0.5 * (a0 - a2) / (a0 - 2 * a1 + a2 - 1e-12)   # sub-sample accuracy
    ok = loud & (a1 > 0.4)                                      # voiced frames
    pair = ok[1:] & ok[:-1]                                     # consecutive voiced
    if ok.sum() < 8 or pair.sum() < 6:
        return None
    cents = 1200 * np.log2(SR / lag)
    db = 20 * np.log10(rms + 1e-9)
    return {
        "pitch_var": float(np.median(np.abs(np.diff(cents))[pair])),
        "periodicity": float(a1[ok].mean()),
        "shimmer": float(np.median(np.abs(np.diff(db))[pair])),
    }


def score(x16):
    """0-100 'AI likelihood' for a 16 kHz window (None if no speech)."""
    f = features(x16)
    if f is None:
        return None, {}
    parts = [np.clip((f[k] - h) / (a - h), 0, 1) for k, (a, h) in RAMPS.items()]
    return 100 * float(np.mean(parts)), f


def bands(chunk, sr, n=24):
    """n log-spaced spectrum bands (0-1) for the dashboard visualiser + level in dB."""
    spec = np.abs(np.fft.rfft(chunk * np.hanning(len(chunk)))) / (len(chunk) / 4)
    freqs = np.fft.rfftfreq(len(chunk), 1 / sr)
    edges = np.geomspace(60, min(8000, sr / 2 - 1), n + 1)
    mag = np.array([spec[(freqs >= a) & (freqs < b)].max(initial=0) for a, b in zip(edges, edges[1:])])
    level = 20 * np.log10(np.sqrt(np.mean(chunk ** 2)) + 1e-9)
    return np.clip((20 * np.log10(mag + 1e-9) + 90) / 55, 0, 1).round(3).tolist(), round(float(level), 1)


class Detector:
    """One per connected phone. push() raw float32 chunks, get a verdict every 0.5 s."""

    def __init__(self, sr):
        self.sr, self.buf, self.new, self.ema, self.quiet = sr, np.zeros(0, np.float32), 0, None, 0

    def push(self, chunk):
        self.buf = np.concatenate([self.buf, chunk])[-int(WINDOW_S * self.sr):]
        self.new += len(chunk)
        if self.new < HOP_S * self.sr or len(self.buf) < self.sr:
            return None
        self.new = 0
        s, f = score(to16k(self.buf, self.sr))
        if s is None:                       # silence / no voice
            self.quiet += 1
            if self.quiet > 6:              # ~3 s of silence = new speaker
                self.ema = None
            return {"label": "Listening", "confidence": 0, "ai_score": 0, "features": {}}
        self.quiet = 0
        self.ema = s if self.ema is None else 0.6 * self.ema + 0.4 * s
        e = self.ema
        label = "AI-Cloned" if e >= AI_ABOVE else "Human" if e <= HUMAN_BELOW else "Uncertain"
        conf = e if label == "AI-Cloned" else 100 - e if label == "Human" else max(e, 100 - e)
        return {"label": label, "confidence": round(conf, 1), "ai_score": round(e, 1),
                "features": {k: round(v, 2) for k, v in f.items()}}


if __name__ == "__main__":      # python detector.py sample.wav  -> print features (use to tune RAMPS)
    import sys
    import wave
    with wave.open(sys.argv[1]) as w:
        raw = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
        raw = raw.reshape(-1, w.getnchannels()).mean(1)
        d = Detector(w.getframerate())
    for i in range(0, len(raw) - 4096, 4096):
        r = d.push(raw[i:i + 4096])
        if r:
            print(r["label"], r["ai_score"], r["features"])
