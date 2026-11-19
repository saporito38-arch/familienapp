# KI-Assistent einrichten (einmalig, ca. 10 Minuten)

Die App funktioniert auch ohne KI. Mit KI kommen drei Funktionen dazu:

- **Einfach eintippen** (Startseite und Plus-Button): „Morgen 15 Uhr Zahnarzt mit Lina, Milch und Eier kaufen“ wird zu Termin und Einkauf.
- **Rezept aus Link übernehmen** (Listen → Rezepte): Link einer Rezeptseite einfügen, Zutaten und Zubereitung werden ausgelesen.
- **Abendessen vorschlagen** (Listen → Essen): Vorschläge für die freien Abende der Woche, eure Rezepte zuerst.

Die KI trägt nie selbst etwas ein. Ihr seht jeden Vorschlag vorher und bestätigt ihn.

## 1. API-Schlüssel bei Anthropic holen

1. Auf <https://console.anthropic.com> ein Konto anlegen.
2. Unter **Billing** Guthaben aufladen (z. B. 5 €) und unter **Limits** ein Monatslimit setzen, z. B. 5 €.
3. Unter **API Keys** → **Create Key** einen Schlüssel erstellen und kopieren (beginnt mit `sk-ant-`).
   Den Schlüssel nirgends sonst speichern oder weitergeben.

**Kosten (grobe Schätzung):** Die App nutzt das Modell Claude Opus 5.5 (4 $ pro Million Eingabe-Tokens, 20 $ pro Million Ausgabe-Tokens). Ein Eintrag oder Wochenplan kostet etwa 1 bis 3 Cent, ein Rezept-Import von einer Webseite etwa 5 bis 10 Cent. Bei 50 Einträgen und 10 Rezepten im Monat sind das etwa 1 bis 3 €. Das Monatslimit schützt vor Überraschungen.

## 2. Funktion in Supabase anlegen

1. Supabase-Dashboard → euer Projekt → links **Edge Functions**.
2. **Deploy a new function** → **Via Editor**.
3. Den gesamten Inhalt der Datei `supabase/functions/familie-ki/index.ts` aus diesem Repository einfügen.
4. Als Namen genau `familie-ki` eintragen und **Deploy** klicken.
5. Die Einstellung **Verify JWT** eingeschaltet lassen.

## 3. Schlüssel hinterlegen

1. In Supabase unter **Edge Functions** → **Secrets**.
2. Neues Secret: Name `ANTHROPIC_API_KEY`, Wert = der Schlüssel aus Schritt 1 → **Save**.

## 4. Prüfen

App schließen und neu öffnen. Unter dem Profilbild (oben rechts) → Abschnitt **KI-Assistent** steht dann **Aktiv**, und auf der Startseite erscheint die Zeile „Was steht an? Einfach eintippen“.

## Datenschutz

Was ihr in die KI-Felder eintippt (und die Vornamen der Familienmitglieder, damit Termine richtig zugeordnet werden), wird zur Verarbeitung an Anthropic geschickt. Der Kalender, die Listen und der Chat werden **nicht** übertragen. Nur angemeldete Familienmitglieder können die Funktion nutzen.

## Wenn etwas nicht klappt

- **Status bleibt „Nicht eingerichtet“:** Heißt die Funktion genau `familie-ki`? Ist das Secret genau `ANTHROPIC_API_KEY` geschrieben?
- **„Der API-Schlüssel der KI ist ungültig“:** Schlüssel neu erstellen und das Secret ersetzen.
- **„Die KI ist gerade nicht erreichbar“:** Guthaben in der Anthropic-Console prüfen.
- **Rezeptseite lässt sich nicht laden:** Manche Seiten sperren automatische Abrufe. Dann den Rezepttext markieren, kopieren und statt des Links einfügen.
