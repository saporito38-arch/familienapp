# Rezept aus Link einrichten (einmalig, ca. 3 Minuten, kostenlos)

Damit könnt ihr unter **Listen → Rezepte** den Link einer Rezeptseite (z. B. Chefkoch) einfügen. Titel, Zutaten und Zubereitung werden automatisch übernommen. Es wird **keine KI** genutzt und es entstehen **keine Kosten**: Die Funktion läuft im kostenlosen Kontingent von Supabase.

## So geht's

1. Supabase-Dashboard → euer Projekt → links **Edge Functions**.
2. **Deploy a new function** → **Via Editor**.
3. Den gesamten Inhalt der Datei `supabase/functions/rezept-import/index.ts` aus diesem Repository einfügen.
4. Als Namen genau `rezept-import` eintragen und **Deploy** klicken. Die Einstellung **Verify JWT** eingeschaltet lassen.
5. App schließen und neu öffnen. Unter **Listen → Rezepte** erscheint dann der Knopf **„Rezept aus Link übernehmen“**.

Solange die Funktion nicht eingerichtet ist, bleibt der Knopf einfach unsichtbar.

## Gut zu wissen

- Die Funktion liest die Rezeptdaten, die Rezeptseiten für die Google-Suche hinterlegen (Format schema.org/Recipe). Das haben die allermeisten großen Rezeptseiten.
- Manche Seiten sperren automatische Abrufe oder haben kein solches Format. Dann erscheint ein Hinweis, und ihr tragt die Zutaten mit **„Von Hand eintragen“** ein. Der Link wird dabei mitgenommen.
- Auf der Einkaufsliste landen die Zutaten immer ohne Mengen.
- Nur angemeldete Familienmitglieder können die Funktion nutzen. Übertragen wird nur der Link, keine Daten aus der App.
