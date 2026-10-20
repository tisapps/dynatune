# Dynatune – Konzept

**Dynamisches Stimmgerät als Progressive Web App (PWA) für Smartphones**

Stand: 20.10.2026 · Version 1.2 (nach erstem Praxistest) · Prototyp: Stufe 1 umgesetzt

---

## 1. Idee

Herkömmliche Stimmgeräte zeigen nur an, ob ein Ton zu hoch oder zu tief ist. Dynatune erkennt den Ton, den der Musiker spielt oder singt, und **spielt ihn sofort selbst in exakter Stimmung mit**. Der Musiker hört die Schwebung zwischen beiden Tönen und korrigiert nach Gehör. Das trainiert das Gehör statt den Blick auf eine Nadel. Eine farbige Grafik zeigt die Abweichung zusätzlich an.

**Zielgruppe:** Spieler von Melodieinstrumenten (Streicher, Holz- und Blechbläser) und Sänger, vom Unterricht bis zum Einspielen vor der Probe.

## 2. Festgelegte Entscheidungen

| Thema | Entscheidung |
|---|---|
| Zielgerät | Smartphone (Hochformat, Touch); Tablet und Desktop funktionieren nebenbei |
| Mehrstimmigkeit | keine; es wird immer genau ein Ton erkannt |
| Erkennungsbreite | ±20 Cent um einen Halbton |
| Grüner Bereich | voll grün bis ±2 Cent, **weicher Übergang** bis ±4 Cent (Mitte ±3, einstellbar) |
| Glättung der Anzeige | Median + zeitbasierte Glättung, Standard ≈ 180 ms (einstellbar 40–600 ms) |
| Graubereich (20–50 Cent neben einem Halbton) | Anzeige grau, **Referenz spielt weiter** |
| Rückkopplungsschutz | NLMS-Echounterdrückung (adaptives Filter), mit Kalibrierung |
| Ende des Haltens | eingelerntes Stoppsignal, Antippen der Anzeige oder **automatische Abschaltung nach einstellbarer Zeit (5–60 s, Standard 20 s)** |

## 3. Bedienablauf

1. **Start** antippen und den Mikrofonzugriff erlauben.
2. Einmalig in den Einstellungen Klang und Kammerton wählen. Ohne Kopfhörer zusätzlich **Echo kalibrieren**. Das **Stoppsignal** lässt sich direkt auf dem Hauptbildschirm einlernen (Schaltfläche neben Start); falls nötig, startet das Audio dabei automatisch.
3. Ton spielen. Nach rund 20–60 ms (je nach Tonhöhe, siehe Abschnitt 5) setzt die Referenz in sauberer Stimmung ein.
4. Beim Tonwechsel springt die Referenz mit 20 ms Überblendung mit.
5. Hört der Musiker auf, klingt die Referenz weiter („Halten“). Ein Balken zeigt die verbleibende Zeit bis zur automatischen Abschaltung.
6. Die Referenz endet durch Stoppsignal, Antippen oder Zeitablauf. Ein neu gespielter Ton übernimmt sofort.

## 4. Zustandsautomat

```
            Ton stabil (3 Messungen, ±20 ct)
   ┌────────┐ ─────────────────────────────▶ ┌───────────┐
   │ Bereit │                                │ Verfolgen │ ◀── neuer Ton: Referenz wechselt
   └────────┘ ◀──── Stoppsignal / Tippen ─── └───────────┘     Graubereich: Referenz bleibt
       ▲             / Zeitablauf                 │  ▲
       │                                  120 ms  │  │ Ton (auch im Graubereich)
       │                                  Stille  ▼  │
       │                                    ┌─────────┐
       └──── Stoppsignal / Tippen / ────────│ Halten  │  Referenz klingt weiter,
             Zeitablauf (5–60 s)            └─────────┘  NLMS lernt nach
```

| Zustand | Referenz | NLMS lernt | Stoppsignal aktiv |
|---|---|---|---|
| Bereit | aus | nein | nein |
| Verfolgen | an, folgt dem Ton | nein (der Musiker spielt) | nein |
| Halten | an, unverändert | ja | ja |

## 5. Tonerkennung

**Verfahren:** McLeod Pitch Method (MPM). Die normalisierte Quadratdifferenzfunktion wird per FFT-Autokorrelation berechnet. Sie läuft vollständig im **AudioWorklet**, also im Audio-Thread und unabhängig von der Oberfläche.

**Schnelle Reaktion:**
- Eine neue Messung entsteht alle 256 Samples (≈ 5 ms).
- Kurzes Fenster (1024 Samples ≈ 21 ms) für den Toneinsatz. Unter 130 Hz wird mit 2048 Samples nachgerechnet.
- Ein Ton gilt als erkannt, wenn er in **3 aufeinanderfolgenden Messungen** auf demselben Halbton liegt.

**Präzision bei gehaltenem Ton:**
- Ist der Ton ≈ 43 ms stabil, wechselt die Erkennung auf das lange Fenster (2048 Samples).
- Zusätzlich wird das Korrelationsmaximum bei einem Vielfachen der Periode gesucht. Das teilt den Interpolationsfehler durch dieses Vielfache.

**Gemessen im Prototyp** (synthetische Töne, `test/pitch.test.mjs`):

| Ton | erkannt nach | max. Fehler (gehalten) |
|---|---|---|
| E6 (1319 Hz) | 5 ms | 0,03 ct |
| A4 (440 Hz) | 11 ms | 0,03 ct |
| G3 (196 Hz, tiefste Geigensaite) | 16 ms | 0,05 ct |
| C3 (131 Hz) | 21–27 ms | 0,11 ct |
| E2 (82 Hz) | 37 ms | 0,17 ct |

Zur Gesamtreaktionszeit kommen hinzu: die Stabilitätsprüfung (≈ 10 ms), die Eingangslatenz (≈ 5–20 ms) und die Ausgabelatenz (iOS ≈ 5–15 ms, Android 10–40 ms je nach Gerät). **Realistisch: 40–80 ms.** Die App zeigt die gemessene Ausgabelatenz in den Einstellungen an.

**Gültigkeitsprüfung:**
- Mindestpegel (Regler „Empfindlichkeit“) und Klarheit ≥ 0,8.
- Frequenzbereich 60–2200 Hz.
- Liegt ein Ton weiter als 20 Cent neben dem nächsten Halbton, gilt er als Graubereich. Das wird erst nach 2 Messungen angezeigt, damit der Übergang beim Tonwechsel nicht kurz grau aufblitzt.

## 6. Referenzton

**Prototyp (Stufe 1):** additive Synthese (`PeriodicWave`) mit Teiltonspektren für Violine, Querflöte, Klarinette, Oboe, Cello, Orgel und Sinus.
- Exakt gestimmt (rechnerisch genaue Frequenz), beliebig lange haltbar, offline, lizenzfrei.
- Einschwingen 25 ms, Überblendung beim Tonwechsel 20 ms, Ausklingen 0,3 s (beim Stoppsignal 80 ms).
- Optionen: gleiche Oktave oder eine Oktave tiefer, Lautstärke, Kammerton 415–446 Hz.

**Stufe 2: Instrumentensamples (open source).**

| Quelle | Lizenz | Eignung |
|---|---|---|
| VSCO 2 Community Edition | CC0 | Violine, Bratsche, Cello, Kontrabass, Flöte, Klarinette, Oboe, Fagott, Horn, Trompete |
| University of Iowa Musical Instrument Samples | frei nutzbar | Einzeltöne ohne Vibrato, ideal als Basis |
| Sonatina Symphonic Orchestra | CC Sampling+ | Ergänzung |
| FluidR3 GM / MusyngKite | MIT bzw. CC BY-SA | kompakte Fallback-Soundfonts |

Aufbereitung (offline per Skript, nicht im Browser):
1. Ein Sample je kleiner Terz auswählen, Vibrato meiden.
2. **Jedes Sample auf 0,0 Cent vermessen** (mit derselben MPM-Analyse) und die Abweichung als Korrekturwert speichern. Echte Aufnahmen weichen oft 2–8 Cent ab.
3. Loop-Punkte im gehaltenen Teil setzen (Nulldurchgang, gleiche Phase), damit beliebig lange gehalten werden kann.
4. Als Opus/OGG mit JSON-Index ablegen (`grundfrequenz`, `korrekturCent`, `loopStart`, `loopEnd`).
5. Klangpakete pro Instrument nachladen (≈ 1–3 MB) und vom Service Worker zwischenspeichern.

Zur Wiedergabe dient ein `AudioBufferSourceNode` mit `loop` und einem `playbackRate`, das aus Zielfrequenz und korrigierter Sample-Frequenz berechnet wird.

## 7. Rückkopplungsschutz (NLMS)

**Problem:** Ohne Kopfhörer nimmt das Mikrofon den Referenzton aus dem Lautsprecher mit auf. Gerade im Zustand „Halten“ würde die App sonst ihren eigenen Ton als gespielten Ton erkennen.

**Lösung, mehrstufig:**

1. **Kalibrierung** (Knopf „Echo kalibrieren“): Die App spielt 0,5 s Rauschen und nimmt gleichzeitig Mikrofon und Sendesignal auf.
   - Die Kreuzkorrelation per FFT liefert die Echo-Laufzeit (Ausgabelatenz + Schallweg + Eingabelatenz).
   - Auf diesen Daten wird das Filter (256 Koeffizienten, ≈ 5 ms Nachhall) vortrainiert. So wirkt die Unterdrückung schon beim ersten Ton.
   - Findet die Kalibrierung kein Echo (Kopfhörer), bleibt die Unterdrückung aus.
2. **NLMS im AudioWorklet:** Das Filter schätzt das Echo aus dem bekannten Referenzsignal und zieht es vom Mikrofon ab. Die Tonerkennung arbeitet nur noch auf dem Restsignal.
   - Leaky-NLMS verhindert, dass die Koeffizienten bei schmalbandiger Referenz driften.
3. **Doppelsprech-Schutz:** Das Filter lernt nur im Zustand „Halten“ (dann klingt nur die Referenz). Steigt das Restsignal plötzlich an, weil der Musiker wieder spielt, friert das Lernen sofort ein. Sonst würde das Filter den Musiker selbst „wegfiltern“, dessen Ton ja fast dieselbe Frequenz hat.
4. **Plausibilitätsregel (Sicherheitsnetz):** Ein erkannter Ton, der auf ±1,2 Cent der Referenz (oder einem Vielfachen davon) liegt, gilt als Übersprechen, solange sein Pegel nicht deutlich über dem zu Beginn des Haltens gemessenen Restpegel liegt.

**Gemessen** (Simulation, `test/pitch.test.mjs`):
- Echodämpfung über 80 dB im Idealfall (lineares Echo).
- Bei gleichzeitigem Spiel 4 Cent neben der Referenz wird der Musiker exakt mit +4,00 ct erkannt.

Auf echten Geräten ist mit 20–35 dB zu rechnen, weil Smartphone-Lautsprecher nichtlinear verzerren.

**Empfehlung in der App:**
- Kabelkopfhörer, einseitig getragen oder offen, sind ideal.
- **Bluetooth-Kopfhörer sind ungeeignet:** Sie verzögern um 150–300 ms, die Referenz käme deutlich zu spät.

## 8. Grafik

- **Senkrechte Skala** von −20 bis +20 Cent, Graubereiche ober- und unterhalb. Darüber stehen groß der Notenname (z. B. „A₄“), die Abweichung mit einer Nachkommastelle und die Referenzfrequenz.
- **Farbiges Objekt (Kugel)** bewegt sich senkrecht. Damit es ruhig läuft, wird zweistufig geglättet:
  1. Der Median der letzten 7 Messungen (≈ 35 ms) entfernt Ausreißer.
  2. Danach folgt eine zeitbasierte Exponentialglättung im Bildtakt. Der Regler „Glättung“ stellt die Zeitkonstante ein (40–600 ms, Standard ≈ 180 ms).

  Beim Tonwechsel springt die Kugel ohne Glättung. Die Cent-Zahl zeigt den geglätteten Wert und wird höchstens 10× pro Sekunde aktualisiert. Die Tonerkennung und die Referenz selbst werden nicht geglättet und bleiben so schnell wie bisher.
- **Verlaufsspur** der letzten 3 Sekunden links der Kugel: zeigt Tendenzen wie Absacken am Bogenende oder Hochziehen beim Crescendo.
- **Farben:**

| Bereich | Farbe |
|---|---|
| −20 … −4 Cent | Violett → Blau (fließend) |
| −4 … −2 Cent | weicher Übergang Blau → Grün |
| **−2 … +2 Cent** | **Grün** |
| +2 … +4 Cent | weicher Übergang Grün → Gelb |
| +4 … +20 Cent | Gelb → Orange (fließend) |
| außerhalb ±20 Cent | Grau (Referenz spielt weiter) |
| Halten (kein Spiel) | Kugel blass grau, Restzeit als Balken |

- Der Regler „Grüner Bereich“ verschiebt die Mitte des Übergangs (Standard 3 → Übergang 2…4 Cent). Das grüne Hintergrundband blendet entsprechend weich aus.
- Eine Farbleiste am rechten Rand dient als Legende. Die Darstellung läuft per Canvas mit Bildwiederholrate und passt sich an Hell- und Dunkelmodus an.
- **Antippen der Anzeige** beendet den Referenzton.

## 9. Stoppsignal

**Einlernen:** Der Musiker macht sein Signal 4×, z. B. Zungenschnalzen. Für jede Aufnahme werden Merkmale berechnet:
- Spektralform in 12 breiten, logarithmisch verteilten Bändern (250 Hz – 12 kHz), unabhängig von der Lautstärke
- spektraler Schwerpunkt
- Dauer über −20 dB

Aus den vier Aufnahmen entsteht eine Vorlage. Die App zeigt an, wie gut die Aufnahmen untereinander übereinstimmen.

**Erkennung:** Nur im Zustand „Halten“. Das Worklet meldet plötzliche Pegelsprünge (> 11 dB über dem gleitenden Mittel) im echobereinigten Signal. Diese werden mit der Vorlage verglichen:

> Wert = (0,4 · Formähnlichkeit + 0,6 · Schwerpunktähnlichkeit) × Dauerfaktor

Die Schwelle ist einstellbar (Standard 60 %). Gespeichert wird lokal auf dem Gerät.

**Gemessen** (synthetische Signale, `test/stopsignal.test.mjs`):

| Eingelernt | Treffer | Fehlauslöser (Klatschen, Klopfen, Geigeneinsatz, „ts“) |
|---|---|---|
| Zungenschnalzen | 82–98 % | ≤ 5 % |
| breitbandiger Knack | 69–96 % | ≤ 5 % |

**Ausweichwege:** Antippen der Anzeige, automatische Abschaltung. Später zusätzlich ein Bluetooth-Blätterpedal (es meldet sich als Tastatur).

## 10. Technische Architektur

```
Mikrofon ──▶ ┌──────────────────────── AudioWorklet ───────────────────────┐
             │ DC-Sperre → NLMS (− Echo-Schätzung) → Ringpuffer             │
Referenz ──▶ │                     │                    │                   │
(Sendebus)   │                     ▼                    ▼                   │
             │            MPM-Tonerkennung      Transienten-Erkennung       │
             └──────────────────│─────────────────────│─────────────────────┘
                                ▼ alle ≈5 ms          ▼ Ereignis
             ┌──────────────── Hauptthread ─────────────────────────────────┐
             │ Zustandsautomat · Notenlogik · Stoppsignal-Vergleich          │
             │ Referenz-Engine (Synthese, später Sampler) → Sendebus         │
             │ Canvas-Anzeige · Einstellungen (localStorage)                 │
             └──────────────────────────────────────────────────────────────┘
Sendebus ──▶ Lautsprecher/Kopfhörer  und  ──▶ Worklet-Eingang 2 (für NLMS)
```

| Datei | Aufgabe |
|---|---|
| `worklet/dynatune-processor.js` | Audio-Thread: NLMS, MPM, Transienten, Kalibrier-Aufnahme |
| `js/app.js` | Audio-Aufbau, Zustandsautomat, Bedienung |
| `js/reference.js` | Referenzton-Engine |
| `js/display.js` | Grafik |
| `js/calibrate.js` | Echo-Laufzeit messen, NLMS vortrainieren |
| `js/stopsignal.js` | Merkmale und Vergleich für das Stoppsignal |
| `js/tuning.js` | Noten, Cent, Namen, Transposition |
| `sw.js`, `manifest.webmanifest` | Offline-Fähigkeit, Installation |

**Wichtige Browser-Einstellungen:**
- Mikrofon mit `echoCancellation`, `noiseSuppression` und `autoGainControl` = aus. Diese Filter würden Tonhöhe und Pegel verfälschen.
- `AudioContext` mit `latencyHint: 'interactive'`.
- Screen Wake Lock hält den Bildschirm an.
- Kein Build-Schritt, keine Abhängigkeiten: statisches Hosting genügt (z. B. GitHub Pages). HTTPS ist Pflicht für den Mikrofonzugriff.

## 11. Einstellungen

Die Einstellungen sind in vier Gruppen gegliedert: Referenzton, Erkennung & Anzeige, Halten & Stoppen, Rückkopplungsschutz. Jede Gruppe ist eine Tabelle mit einer Zeile je Funktion: Bezeichnung links, Regler bzw. Auswahl rechts. Die Zeilen wechseln zwischen Mittelgrau und Dunkelgrau (im hellen Modus zwei helle Grautöne). Die Gruppenüberschriften sind größer gesetzt.

## 12. Weitere Funktionen

- **Notennamen** deutsch (H, B, Cis) oder international (B, B♭, C♯).
- **Transposition** für C, B, A, F, Es: Die Anzeige zeigt die notierte Note, die Referenz klingt real.
- Alle Einstellungen werden lokal gespeichert.

## 13. Ausbaustufen

| Stufe | Inhalt | Status |
|---|---|---|
| 1 | Tonerkennung, synthetische Referenzklänge, Farbgrafik, Halten mit Zeitabschaltung, NLMS mit Kalibrierung, Stoppsignal, PWA | **Prototyp umgesetzt** |
| 2 | Instrumentensamples (VSCO 2 / Iowa) mit Vermessungs- und Loop-Skript | geplant |
| 3 | Praxistest auf iPhone und Android-Geräten; Feinabstimmung von Pegeln, Schwellen und NLMS-Länge; Latenzmessung | geplant |
| 4 | Stimmungssysteme (rein, pythagoreisch, bezogen auf Grundton), Übungsstatistik, Bluetooth-Pedal | Idee |

## 14. Risiken und offene Punkte

- **iOS:** Bei aktivem Mikrofon kann Safari die Ausgabe leiser oder über den Hörer ausgeben. Das muss auf echten Geräten geprüft werden. Mit Kopfhörern tritt das Problem nicht auf.
- **Android-Latenz** schwankt stark je nach Gerät. Die App zeigt den Wert an. Bei hoher Latenz helfen Kopfhörer und das Halten.
- **Lautsprecher-Verzerrung** begrenzt die Echodämpfung. Die Plausibilitätsregel fängt Reste ab. Bleibt das Übersprechen stark, hilft ein längeres Filter (512 Koeffizienten) oder eine Nachdämpfung bekannter Teiltöne.
- **Stoppsignal in lauter Umgebung:** Die Schwelle ist einstellbar; Antippen und Zeitabschaltung bleiben immer verfügbar.
- **Sehr tiefe Instrumente** (Kontrabass, Tuba unter 60 Hz) liegen außerhalb des aktuellen Bereichs. Sie bräuchten ein längeres Fenster und damit mehr Latenz.
