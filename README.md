# Dynatune

Dynamisches Stimmgerät als PWA für Smartphones: erkennt den gespielten oder gesungenen Ton und **spielt ihn in exakter Stimmung zurück**, damit man nach Gehör korrigieren kann. Dazu kommt eine farbige, geglättete Anzeige (Violett – Blau – **Grün bis ±2 ct, weicher Übergang bis ±4 ct** – Gelb – Orange).

Konzept und Messwerte: [docs/KONZEPT.md](docs/KONZEPT.md)

## Funktionen (Prototyp)

- Tonerkennung (McLeod Pitch Method) im AudioWorklet, Ergebnis alle ≈ 5 ms, Genauigkeit unter 0,2 Cent
- Referenzton in exakter Stimmung: Violine, Querflöte, Klarinette, Oboe, Cello, Orgel, Sinus (Synthese)
- Erkennungsbreite ±20 Cent; im Graubereich spielt die Referenz weiter
- Halten nach Spielende, bis Stoppsignal, Antippen oder automatische Abschaltung (5–60 s)
- Stoppsignal (z. B. Zungenschnalzen) einlernen, direkt vom Hauptbildschirm
- Rückkopplungsschutz per NLMS-Echounterdrückung mit Kalibrierung
- Kammerton 415–446 Hz, Oktave tiefer, deutsche oder internationale Notennamen, Transposition (B, A, F, Es)
- Offline-fähig und installierbar (Service Worker, Manifest)

## Starten

Statische Dateien, kein Build-Schritt. Lokal:

```sh
python3 -m http.server 8000
# http://localhost:8000 öffnen
```

Auf dem Smartphone ist **HTTPS nötig**, weil der Mikrofonzugriff sonst blockiert wird, z. B. über GitHub Pages (Settings → Pages → Branch `main`, Ordner `/`).

Tipps:
- Am besten Kabelkopfhörer verwenden, einseitig getragen.
- Ohne Kopfhörer einmal „Echo kalibrieren“ ausführen.
- Bluetooth-Kopfhörer sind wegen ihrer Verzögerung ungeeignet.

## Tests

```sh
node test/pitch.test.mjs        # Genauigkeit, Reaktionszeit, NLMS, Doppelsprechen
node test/stopsignal.test.mjs   # Trennschärfe Stoppsignal
node test/e2e.mjs               # Browser-Test mit simuliertem Mikrofon (Playwright + Chromium)
```
