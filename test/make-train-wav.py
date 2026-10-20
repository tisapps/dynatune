# Test-WAV für den Einlern-Dialog: 5 Schnalzer zum Einlernen, dann 2 Schnalzer + 1 Klatschen zum Testen
import math, random, struct, sys, wave
fs = 48000
random.seed(5)
out = [0.0] * int(9 * fs)
def click(at, amp):
    f1, f2, d = 1400 * random.uniform(0.9, 1.1), 2600 * random.uniform(0.9, 1.1), 0.0025 * random.uniform(0.7, 1.3)
    for i in range(int(0.04 * fs)):
        t = i / fs
        out[int(at * fs) + i] += amp * math.exp(-t / d) * (0.6 * math.sin(2 * math.pi * f1 * t) + 0.4 * math.sin(2 * math.pi * f2 * t) + 0.2 * random.uniform(-1, 1)) / 0.6
def clap(at, amp):
    for i in range(int(0.06 * fs)):
        t = i / fs
        out[int(at * fs) + i] += amp * math.exp(-t / 0.012) * (random.uniform(-0.5, 0.5) + 0.5 * math.sin(2 * math.pi * 900 * t))
for k in range(5): click(1.0 + k, 0.25 * random.uniform(0.6, 1.4))
click(6.5, 0.2); clap(7.3, 0.3); click(8.1, 0.15)
for i in range(len(out)): out[i] += random.uniform(-0.002, 0.002)
w = wave.open(sys.argv[1], 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(fs)
w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, v)) * 32767)) for v in out)); w.close()
