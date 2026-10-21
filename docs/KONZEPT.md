# Dynatune – Konzept

**Dynamisches Stimmgerät als Progressive Web App (PWA) für Smartphones**

Stand: 21.10.2026 · Version 1.5 (Echo-Laufzeit, Raumhall, Diagnose-Aufnahme) · Prototyp: Stufe 1 umgesetzt

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
| Rückkopplungsschutz | Einmessen beim Start, NLMS-Filter + Kammfilter über die Referenzperiode |
| Ende des Haltens | eingelerntes Stoppsignal, Antippen der Anzeige oder **automatische Abschaltung nach einstellbarer Zeit (5–60 s, Standard 20 s)** |

## 3. Bedienablauf

1. **Start** antippen und den Mikrofonzugriff erlauben.
2. Einmalig in den Einstellungen Klang und Kammerton wählen. Beim Start misst die App automatisch das Lautsprecher-Echo ein (≈ 3 s Rauschen und Ton, bitte still sein). Das **Stoppsignal** lässt sich direkt auf dem Hauptbildschirm einlernen (Schaltfläche neben Start); falls nötig, startet das Audio dabei automatisch.
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

## 7. Lautsprecher-Echo der Referenz

**Problem:** Ohne Kopfhörer hört das Mikrofon den eigenen Referenzton mit. Im ersten Praxistest führte das zu falschen Oktaven, verpassten Tonwechseln und einem Halten, das nie erreicht wurde (damit konnte auch das Stoppsignal nicht greifen).

Die Ursache zeigt die Simulation: Geige und Referenz-Echo bilden eine Mischung mit gemeinsamer Unterperiode. G4-Echo + gespieltes A4 (Verhältnis 8 : 9) ergibt C3, also einen Ton, der gar nicht klingt. Mit der Lautsprecher-Verzerrung reicht die NLMS-Unterdrückung allein (≈ 16 dB) dagegen nicht aus.

**Lösung, mehrstufig:**

1. **Einmessen beim Start** (abschaltbar, jederzeit wiederholbar), Dauer ≈ 3 s, der Musiker ist dabei still:
   - 0,5 s Rauschen über den Lautsprecher. Die Kreuzkorrelation liefert die Echo-Laufzeit, darauf wird das NLMS-Filter trainiert (256 Koeffizienten, Frequenzgang Lautsprecher → Mikrofon). Ohne messbares Echo (Kopfhörer) bleibt die Unterdrückung aus.
   - 0,5 s Tonprobe mit dem Referenzklang: Wie stark ist das Rest-Echo nach der Unterdrückung? Mit dem Filter rechnet die App daraus für **jeden** Ton das zu erwartende Echo aus. Das ist wichtig, weil Handylautsprecher je nach Tonhöhe sehr verschieden laut sind.
   - Das Filter wird danach nicht nachtrainiert. Es bleibt zeitlich konstant, und nur dann funktioniert der Kammfilter (Punkt 2) vollständig.
2. **Kammfilter über eine Referenzperiode:** Das Echo des Referenztons ist mit der Periode der Referenz streng periodisch, auch mit Lautsprecher-Verzerrung und Raumhall. Wird vom Signal das Signal genau eine Periode vorher abgezogen, verschwindet das Echo vollständig. Die gebrochene Verzögerung wird mit 32 Stützstellen interpoliert (gefensterte Sinc-Funktion), die Auslöschung liegt bei 73–89 dB. Die Tonerkennung läuft zusätzlich auf diesem bereinigten Signal. **Tonwechsel werden dort erkannt**, unabhängig vom Echopegel.
3. **Spieler auf dem Referenzton:** Spielt der Musiker genau den Referenzton (oder dessen Oktave), verschwindet er im bereinigten Signal mit. Dass er spielt, erkennt die App an drei Zeichen:
   - Pegel deutlich über dem erwarteten Echo
   - Die Tonhöhe des Gesamtsignals weicht von der Referenz ab: Reines Echo liegt exakt auf der Referenz (±0,1 ct); Schwebung und Vibrato verschieben die Mischung.
   - schwache, aber plausible Tonhöhe im bereinigten Signal (obere Teiltöne)

   Die Cent-Anzeige stammt dann aus dem bereinigten Signal. Das Gesamtsignal ist zur Referenz hin verfälscht und wird nur verwendet, wenn das Echo unter 25 % des Spielerpegels liegt; sonst wird die Kugel grau, statt einen geschönten Wert zu zeigen.
4. **Echo-Laufzeit:** Auf Android-Geräten braucht der Ton vom Lautsprecher zurück ins Mikrofon oft 100–400 ms. Nach einem Referenzwechsel hört das Mikrofon so lange noch das Echo des **alten** Tons. Version 1.4 schaltete den Kammfilter sofort um. Ab etwa 200 ms Laufzeit hielt die App das alte Echo für einen neuen Ton und schaltete in schneller Folge hin und her (im Praxistest: „spielt die Referenz in wilder Abfolge“).
   - Seit Version 1.5 schaltet der Audio-Thread den Kammfilter erst um, wenn das Echo des neuen Tons ankommt (um die gemessene Laufzeit verzögert).
   - Die Notenlogik richtet sich nach dem ankommenden Ton.
   - Das Einmessen erfasst Laufzeiten bis 800 ms; die Tonprobe misst erst nach Ankunft des Echos.
5. **Raumhall:** Das Einmessen misst auch, wie lange das Echo nachklingt (Abfall um 30 dB). Nach einem Wechsel läuft für diese Zeit ein zweiter Kammfilter für den alten Ton mit, damit dessen Nachhall sich nicht mit dem Spieler zu Fantasietönen mischt.
6. **Schutzregeln gegen Artefakte:**
   - Echo des alten Tons nach einem Wechsel (300 ms) bzw. nach dem Stopp (600 ms) ignorieren, in den ersten 150 ms auch als Mischklang (Unterharmonische)
   - Unterharmonische der Referenz (jede ganzzahlige, ½ … ⅟ₙ) im bereinigten Signal ignorieren, solange das Gesamtsignal auf der Referenz liegt (Vibrato-Artefakt, z. B. A5 → D4, E6 → A3)
   - Widerspricht das Gesamtsignal einem Ton aus dem bereinigten Signal, braucht der Wechsel 8 statt 3 Messungen (fängt z. B. 5/4-Fehler ab, wenn untere Teiltöne fehlen)
   - Im Zusammenklang mit der Referenz nur Oktavsprünge nach oben zulassen; nur diese sind im bereinigten Signal unsichtbar

**Gemessen** mit echten Geigen-Samples (16 Töne G3–E6, Legato und abgesetzt, Handy-Lautsprecher simuliert: Laufzeit, Hochpass 450 Hz, Verzerrung, Nachhall):

| Echo im Verhältnis zur Geige | Tonwechsel verpasst | falsche Note | fälschlich Halten |
|---|---|---|---|
| vorher (Version 1.3), −5 dB | 2 / 16 | 19 % | – |
| vorher (Version 1.3), +1 dB | 9 / 16 | 60 % | Halten nie erreicht |
| Kopfhörer | 0 / 16 | 0 % | 0 % |
| −5 dB | 0 / 16 | 0 % | 0 % |
| +1 dB | 0 / 16 | 0 % | 0 % |
| +6 dB | 0 / 16 | 0 % | 0 % |
| +10 dB (Extremfall) | 0 / 16 | 3,8 % | 1,9 % |
| +6 dB, ohne Einmessen | 0 / 16 | 0 % | 5,2 % |

Reaktionszeit beim Tonwechsel: Median 27 ms, höchstens 95 ms.

Zusätzlich geprüft (synthetische Geige, `test/closedloop.test.mjs`):

| Bedingung | Referenzwechsel zu viel | falsche Note |
|---|---|---|
| Laufzeit 300 ms | 0 (Version 1.4: +20) | 0,5 % |
| Laufzeit 500 ms | 0 (Version 1.4: +40) | 3,6 % (Sprünge 3 : 1 kommen ≈ 300 ms verzögert) |
| automatische Pegelregelung ±3 dB | 0 | 0 % |
| Raumhall 0,4 s | 0 | 5 % |

Mit Raumhall und lautem Echo zeigt die App bei exakt gestimmtem, ruhigem Ton oft „Hält“ (s. Grenzen); die Referenz klingt dabei weiter.

Cent-Anzeige nahe der Referenz (gespielt +3/+8/+15/+28/−12 ct): bis +6 dB Echo exakt; bei +10 dB werden Abweichungen unter ≈ 5 ct nicht mehr vom Echo unterschieden, die App geht dann ins Halten.

**Bekannte Grenze, Einstellung „Oktave tiefer“:** Springt der Musiker genau auf die Oktave der klingenden Referenz nach unten, ist das physikalisch nicht von „spielt weiter oben“ zu unterscheiden (identische Periode). Der Wechsel wird erst nach einer Pause erkannt.

**Empfehlung in der App:**
- Kabelkopfhörer, einseitig getragen oder offen, sind ideal.
- Ohne Kopfhörer: Lautstärke der Referenz nicht höher als nötig.
- **Bluetooth-Kopfhörer sind ungeeignet:** Sie verzögern um 150–300 ms.

**Bluetooth und Lautsprecher:** Ein offen gehaltenes Mikrofon hält Android im Kommunikationsmodus. Nach Bluetooth-Nutzung blieb dadurch der Lautsprecher stumm. Die App gibt deshalb das Audio vollständig frei, sobald sie in den Hintergrund geht. Wechselt das Audiogerät (Kopfhörer oder Bluetooth ein/aus), baut sie das Audio neu auf und misst neu ein.

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

**Einlernen:** über die Schaltfläche neben „Start“ (oder in den Einstellungen).
- Der Musiker macht sein Signal **5×**, z. B. Zungenschnalzen. Jede Aufnahme wird sofort quittiert (●●●○○).
- Danach zeigt die App die **Übereinstimmung** jeder Aufnahme mit den übrigen vier („gut“ ab 60 %).
- Anschließend folgt ein **Testmodus** im selben Dialog: Jedes Geräusch wird mit seinem Wert angezeigt, als ✓ Stoppsignal oder ✗ kein Stoppsignal.

**Merkmale** werden nur aus dem lauten Teil des Ereignisses berechnet (Rahmen über −20 dB des Spitzenwerts). So stören Raumhall, Grundrauschen und ein leiser Referenzton wenig:
- Spektralform: 10 Bänder (400 Hz – 10 kHz), gemittelt über 512er-Rahmen, lautstärkeunabhängig
- spektraler Schwerpunkt
- Dauer (logarithmisch)

**Vergleich:** Der Abstand zur Vorlage wird in Einheiten der beim Einlernen gemessenen Streuung gerechnet, mit einer Mindeststreuung. Gleichmäßige Signale werden dadurch streng geprüft, natürlich schwankende großzügiger. Ergebnis 0…100 %: 1 Streuung daneben ≈ 61 %, 2 ≈ 14 %. Schwelle einstellbar, Standard 50 %.

**Auslöser im Haltezustand:**
- Der Referenzton klingt ja weiter. Ein **Kammfilter** zieht deshalb das Signal von k Perioden des Referenztons vorher ab (k so gewählt, dass die Verzögerung ≥ 20 ms und fast ganzzahlig ist). Der gleichbleibende Referenzton löscht sich samt aller Obertöne aus, ein Schnalzer bleibt unverändert.
- Ausgelöst wird bei einem Pegelsprung von > 8 dB im Anteil über 1,5 kHz.
- Das wirkt auch ohne Kalibrierung der Echounterdrückung.
- Während des Spielens bleibt die Erkennung aus, weil z. B. der Zungenstoß bei Bläsern ähnlich klingt.

**Rückmeldung im Betrieb:** Unter der Anzeige erscheint kurz „Stoppsignal erkannt (72 %)“ oder „Geräusch: 31 % – Stoppsignal braucht 50 %“. So lässt sich die Schwelle gezielt anpassen.

**Gemessen** (synthetisch, mit Schwankungen in Resonanz ±15 %, Dauer ±40 %, Pegel ±10 dB, Raumhall und Grundrauschen):

| Test | Ergebnis |
|---|---|
| Übereinstimmung beim Einlernen (je gegen die übrigen) | 66–97 % |
| Treffer Zungenschnalzen (10 %-Quantil) | 82–84 % |
| Fehlauslöser (Schnipsen, Klatschen, Klopfen, Geigeneinsatz, „ts“, Husten) | höchstens 27 % |
| Kette Worklet → Merkmale → Vergleich, Referenz laut mitklingend | Schnalzer bei 0, −6 und −12 dB relativ zur Referenz: 15/15 gestoppt; Klatschen: 0/5 |

**Ausweichwege:** Antippen der Anzeige, automatische Abschaltung. Später zusätzlich ein Bluetooth-Blätterpedal (es meldet sich als Tastatur).

## 10. Technische Architektur

```
Mikrofon ──▶ ┌──────────────────────── AudioWorklet ─────────────────────────┐
             │ DC-Sperre → NLMS (− Echo-Schätzung, fest) → Ringpuffer          │
Referenz ──▶ │        │                        │                    │          │
(Sendebus)   │        ▼                        ▼                    ▼          │
             │  MPM-Tonerkennung   Kammfilter (1 Periode)  Kammfilter (≥ 20 ms)│
             │  (Gesamtsignal)     → MPM (ohne Echo)       → Transienten       │
             └────────│───────────────────│─────────────────────│─────────────┘
                      ▼ alle ≈ 5 ms: f, fc, Pegel, Echo-Schätzung ▼ Ereignis
             ┌──────────────── Hauptthread ────────────────────────────────────┐
             │ Notenlogik / Zustandsautomat (tracker.js) · Stoppsignal-Vergleich │
             │ Einmessen · Referenz-Engine → Sendebus · Anzeige · Einstellungen  │
             └─────────────────────────────────────────────────────────────────┘
Sendebus ──▶ Lautsprecher/Kopfhörer  und  ──▶ Worklet-Eingang 2 (NLMS, Kammfilter)
```

| Datei | Aufgabe |
|---|---|
| `worklet/dynatune-processor.js` | Audio-Thread: NLMS, MPM auf Gesamt- und bereinigtem Signal, Kammfilter, Transienten, Aufnahme fürs Einmessen |
| `js/tracker.js` | Notenlogik und Zustandsautomat (ohne Browser-Abhängigkeit, in Node simulierbar) |
| `js/app.js` | Audio-Aufbau, Einmessen, Gerätewechsel, Bedienung |
| `js/reference.js` | Referenzton-Engine |
| `js/display.js` | Grafik |
| `js/calibrate.js` | Echo-Laufzeit, NLMS-Training, Tonprobe, Nachhall |
| `js/diagnose.js` | Diagnose-Aufnahme (WAV + JSON), Teilen/Herunterladen |
| `js/stopsignal.js` | Merkmale und Vergleich für das Stoppsignal |
| `js/tuning.js` | Noten, Cent, Namen, Transposition |
| `sw.js`, `manifest.webmanifest` | Offline-Fähigkeit, Installation |

**Tests:**

| Datei | Prüft |
|---|---|
| `test/pitch.test.mjs` | Genauigkeit und Reaktionszeit, NLMS, Doppelsprechen, Auslöser |
| `test/closedloop.test.mjs` | geschlossener Kreis Geige + Lautsprecher-Echo: Tonwechsel, Oktaven, Halten, Stoppsignal, kein Neustart durch Echo |
| `test/stopsignal.test.mjs`, `test/stopchain.test.mjs` | Trennschärfe Stoppsignal, ganze Kette mit lauter Referenz |
| `test/e2e.mjs` | Browser mit simuliertem Mikrofon; `ECHO=0.5` mischt ein Lautsprecher-Echo ein (Testschalter `?echotest=`) |
| `test/e2e-train.mjs` | Einlernen und Testmodus im Browser |
| `test/e2e-diag.mjs` | Diagnose-Aufnahme im Browser, anschließend Nachspielen |
| `test/replay.mjs` | Diagnose-Aufnahme vom Gerät nachspielen und vergleichen |

**Wichtige Browser-Einstellungen:**
- Mikrofon mit `echoCancellation`, `noiseSuppression` und `autoGainControl` = aus. Diese Filter würden Tonhöhe und Pegel verfälschen.
- `AudioContext` mit `latencyHint: 'interactive'`.
- Screen Wake Lock hält den Bildschirm an.
- Kein Build-Schritt, keine Abhängigkeiten: statisches Hosting genügt (z. B. GitHub Pages). HTTPS ist Pflicht für den Mikrofonzugriff.

## 11. Diagnose-Aufnahme

Unter ⚙ → Diagnose nimmt die App 20 s auf:
- Mikrofon (unbearbeitet) und gesendete Referenz als WAV (32 bit float, stereo)
- Protokoll (JSON): Einstellungen, Einmess-Ergebnis inklusive Filterwerten, Gerät, Latenzen, jeder Zustands- und Notenwechsel

Die Dateien lassen sich teilen (Mail, Messenger, Cloud) oder herunterladen. `node test/replay.mjs <datei>.wav` schickt die Aufnahme exakt durch Audio-Thread und Notenlogik und vergleicht die Entscheidungen mit denen auf dem Gerät. Echte Gerätedaten ersetzen damit das Raten über Unterschiede zwischen Simulation und Gerät.

## 12. Einstellungen

Die Einstellungen sind in vier Gruppen gegliedert: Referenzton, Erkennung & Anzeige, Halten & Stoppen, Rückkopplungsschutz. Jede Gruppe ist ein eigener Block mit größerer Überschrift und einer Tabelle mit einer Zeile je Funktion: Bezeichnung links, Regler bzw. Auswahl rechts. **Der Grauton wechselt je Gruppe** (Mittelgrau / Dunkelgrau, im hellen Modus zwei helle Grautöne). Innerhalb einer Gruppe trennen feine Linien die Zeilen.

## 13. Weitere Funktionen

- **Notennamen** deutsch (H, B, Cis) oder international (B, B♭, C♯).
- **Transposition** für C, B, A, F, Es: Die Anzeige zeigt die notierte Note, die Referenz klingt real.
- Alle Einstellungen werden lokal gespeichert.

## 14. Ausbaustufen

| Stufe | Inhalt | Status |
|---|---|---|
| 1 | Tonerkennung, synthetische Referenzklänge, Farbgrafik, Halten mit Zeitabschaltung, Einmessen + Echo-Bereinigung, Stoppsignal, PWA | **Prototyp umgesetzt** |
| 2 | Instrumentensamples (VSCO 2 / Iowa) mit Vermessungs- und Loop-Skript | geplant |
| 3 | Praxistest auf iPhone und Android-Geräten; Feinabstimmung von Pegeln, Schwellen und NLMS-Länge; Latenzmessung | geplant |
| 4 | Stimmungssysteme (rein, pythagoreisch, bezogen auf Grundton), Übungsstatistik, Bluetooth-Pedal | Idee |

## 15. Risiken und offene Punkte

- **iOS:** Bei aktivem Mikrofon kann Safari die Ausgabe leiser oder über den Hörer ausgeben. Das muss auf echten Geräten geprüft werden. Mit Kopfhörern tritt das Problem nicht auf.
- **Android-Latenz** schwankt stark je nach Gerät. Die App zeigt den Wert an. Bei hoher Latenz helfen Kopfhörer und das Halten.
- **Sehr lautes Lautsprecher-Echo** (mehr als ≈ 6–10 dB über dem Instrument): Ein Spieler, der wenige Cent neben der Referenz liegt, ist dann nicht mehr vom Echo zu unterscheiden. Die App geht in dem Fall ins Halten, die Referenz klingt weiter. Abhilfe: Referenz leiser oder Kopfhörer.
- **Nur simuliert:** Die Echo-Verbesserungen sind mit echten Geigen-Samples und einem simulierten Handy-Lautsprecher geprüft, nicht mit echten Geräten. Version 1.4 bestand alle Simulationen und versagte trotzdem auf dem Gerät, weil die Simulation 30 ms statt realer 100–400 ms Laufzeit annahm. Deshalb gibt es die Diagnose-Aufnahme (Abschnitt 11). Ob der Lautsprecher-Fehler nach Bluetooth-Nutzung behoben ist, kann nur ein Gerätetest zeigen.
- **Sprung auf ein Vielfaches der Referenz** (z. B. D4 → A5 = 3 × D4): Der neue Ton ist im bereinigten Signal unsichtbar, bis Vibrato oder Intonation ihn von der Referenz wegbewegen; der Wechsel kann sich um einige hundert Millisekunden verzögern.
- **Stoppsignal in lauter Umgebung:** Die Schwelle ist einstellbar; Antippen und Zeitabschaltung bleiben immer verfügbar.
- **Sehr tiefe Instrumente** (Kontrabass, Tuba unter 60 Hz) liegen außerhalb des aktuellen Bereichs. Sie bräuchten ein längeres Fenster und damit mehr Latenz.
