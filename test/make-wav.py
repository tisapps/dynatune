# Erzeugt eine Test-WAV-Datei für den Browser-Test (simuliertes Mikrofon)
import math, random, struct, sys, wave
fs = 48000
out = []
def silence(sec): out.extend([0.0] * int(sec * fs))
def tone(f, sec, amp=0.3):
    h = [1, 0.62, 0.52, 0.42, 0.33, 0.28]
    n = int(sec * fs)
    for i in range(n):
        env = min(1, i / 480, (n - i) / 480)
        v = sum(a * math.sin(2 * math.pi * f * (k + 1) * i / fs + k) for k, a in enumerate(h))
        out.append(amp * env * v / len(h))
def click(amp=0.6):
    random.seed(7)
    n = int(0.03 * fs)
    for i in range(n):
        out.append(amp * math.exp(-i / (0.002 * fs)) * (random.random() * 2 - 1))
c = lambda f, ct: f * 2 ** (ct / 1200)
silence(4.5)                  # Zeit für das Einmessen beim Start
tone(c(440, 5), 1.0)          # A4 +5 ct
tone(c(493.88, -12), 0.5)     # H4 -12 ct (Tonwechsel)
tone(c(493.88, 28), 0.4)      # H4 +28 ct → Graubereich
silence(1.0)                  # → Halten
click()                       # Stoppsignal
silence(2.5)
w = wave.open(sys.argv[1], 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(fs)
w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, v)) * 32767)) for v in out)); w.close()
