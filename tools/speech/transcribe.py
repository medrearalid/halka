import sys, wave, numpy as np
from faster_whisper import WhisperModel
def load(f):
    w = wave.open(f); assert w.getframerate() == 48000 and w.getnchannels() == 1
    x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    x = x[: len(x) // 3 * 3].reshape(-1, 3).mean(axis=1)  # 48k -> 16k with a box low-pass
    return x
m = WhisperModel("base.en", device="cpu", compute_type="int8")
for f in sys.argv[1:]:
    segs, _ = m.transcribe(load(f), beam_size=5)
    print(f, "=>", " ".join(s.text.strip() for s in segs))
