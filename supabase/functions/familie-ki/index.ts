// Familien-App: KI-Assistent (Supabase Edge Function "familie-ki")
//
// Aufgaben:
//   ping       – prüft, ob die KI eingerichtet ist (kostet nichts)
//   eintrag    – "Morgen 15 Uhr Zahnarzt mit Lina" → Termine, Aufgaben, Einkauf, Essen, Geburtstage
//   rezept     – Rezept aus Link oder eingefügtem Text auslesen
//   wochenplan – Abendessen für freie Tage vorschlagen
//
// Einrichtung: siehe supabase/KI-EINRICHTEN.md
// Benötigtes Secret: ANTHROPIC_API_KEY (Supabase → Edge Functions → Secrets)
// Die KI schreibt nie selbst in die Datenbank: Die App zeigt jeden Vorschlag zuerst an.

import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const MODEL = "claude-opus-5-5";
const MAX_INPUT_CHARS = 60_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------- Antwort-Schemata (JSON Schema für strukturierte Ausgaben) ----------
type Json = Record<string, unknown>;
const str = (description?: string): Json => (description ? { type: "string", description } : { type: "string" });
const strOrNull = (description: string): Json => ({ type: ["string", "null"], description });
const obj = (properties: Record<string, Json>): Json => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});

const EintragSchema = obj({
  eintraege: { type: "array", items: obj({
    typ: { type: "string", enum: ["termin", "aufgabe", "einkauf", "essen", "geburtstag"] },
    titel: str("Kurzer Titel. Bei Geburtstag: Name der Person. Bei Einkauf: leer."),
    datum: strOrNull("YYYY-MM-DD: Termin-, Fälligkeits-, Essens- oder Geburtsdatum"),
    start: strOrNull("HH:MM, nur bei Terminen mit Uhrzeit"),
    ende: strOrNull("HH:MM, nur wenn genannt"),
    personen: { type: "array", items: str(), description: "IDs der betroffenen Familienmitglieder" },
    sterne: { type: ["integer", "null"], description: "0 bis 5, nur bei Aufgaben mit genannter Belohnung" },
    dinge: { type: "array", items: str(), description: "Nur bei Einkauf: Artikel ohne Mengenangaben" },
    mahlzeit: { type: ["string", "null"], enum: ["mittag", "abend", null] },
    jahr_bekannt: { type: "boolean", description: "Nur bei Geburtstag: ob das Geburtsjahr genannt wurde" },
  }) },
  rueckfrage: strOrNull("Nur wenn gar nichts verstanden wurde: kurze Rückfrage"),
});

const RezeptSchema = obj({
  gefunden: { type: "boolean" },
  titel: str(),
  zutaten: { type: "array", items: str(), description: "Eine Zutat pro Eintrag, mit Menge wie im Rezept" },
  zubereitung: { type: "array", items: str(), description: "Arbeitsschritte in der richtigen Reihenfolge" },
  portionen: strOrNull("z. B. 4 Portionen"),
});

const WochenSchema = obj({
  vorschlaege: { type: "array", items: obj({
    datum: str("YYYY-MM-DD, nur aus der Liste der freien Tage"),
    titel: str(),
    aus_rezepten: { type: "boolean", description: "true, wenn es exakt ein gespeichertes Rezept ist" },
    zutaten: { type: "array", items: str(), description: "Nur wenn aus_rezepten false: Zutaten ohne Mengen" },
    grund: str("Sehr kurze Begründung, höchstens 6 Wörter"),
  }) },
});

type Eintrag = {
  typ: string; titel: string; datum: string | null; start: string | null; ende: string | null;
  personen: string[]; sterne: number | null; dinge: string[]; mahlzeit: string | null; jahr_bekannt: boolean;
};
type EintragOut = { eintraege: Eintrag[]; rueckfrage: string | null };
type RezeptOut = { gefunden: boolean; titel: string; zutaten: string[]; zubereitung: string[]; portionen: string | null };
type WochenOut = { vorschlaege: { datum: string; titel: string; aus_rezepten: boolean; zutaten: string[]; grund: string }[] };

// ---------- Hilfsfunktionen ----------
const WOCHENTAGE = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);

function isPublicHttpUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return null;
  if (/^[\d.]+$/.test(h) || h.includes(":")) return null; // keine IP-Adressen
  return u;
}

async function fetchPage(u: URL): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(u, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FamilienApp-Rezeptimport)", "Accept": "text/html,*/*" },
    });
    if (!res.ok) throw new Error(`Seite antwortet mit ${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < 2_000_000) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});
    const buf = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.length, size - off)), off); off += c.length; if (off >= size) break; }
    return new TextDecoder().decode(buf);
  } finally {
    clearTimeout(timer);
  }
}

// Rezeptseiten enthalten fast immer strukturierte Daten (schema.org/Recipe). Die nehmen wir bevorzugt.
function pageToText(html: string): string {
  const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1].trim())
    .filter((s) => /recipe/i.test(s))
    .join("\n");
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  const text = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|li|h\d|div|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return clip(`Seitentitel: ${title}\n\nStrukturierte Rezeptdaten:\n${ld || "(keine)"}\n\nSeitentext:\n${text}`, MAX_INPUT_CHARS);
}

async function ask<T>(client: Anthropic, schema: Json, system: string, user: string): Promise<T> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content: user }],
  });
  if (response.stop_reason === "refusal") throw new Error("Die KI hat diese Anfrage abgelehnt.");
  if (response.stop_reason === "max_tokens") throw new Error("Die Antwort der KI war zu lang. Bitte kürzer formulieren.");
  const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Die KI-Antwort war unvollständig. Bitte noch einmal versuchen.");
  }
}

// ---------- Aufgaben ----------
type Member = { id: string; name: string };

async function eintrag(client: Anthropic, body: Record<string, unknown>) {
  const text = clip(body.text, 1500).trim();
  if (!text) throw new Error("Bitte etwas eintippen.");
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(body.today)) ? String(body.today) : new Date().toISOString().slice(0, 10);
  const wd = WOCHENTAGE[new Date(today + "T12:00:00").getDay()];
  const members = (Array.isArray(body.members) ? body.members : []).slice(0, 12) as Member[];
  const me = clip(body.me, 40);
  const system = `Du wandelst kurze deutsche Notizen einer Familie in Einträge für ihre Familien-App um.
Heute ist ${wd}, der ${today}. Die Woche beginnt am Montag.
Familienmitglieder (ID: Name): ${members.map((m) => `${clip(m.id, 40)}: ${clip(m.name, 40)}`).join(", ")}.
Die Person, die tippt, hat die ID "${me}". "ich", "mir", "mein" meint diese Person.

Typen:
- termin: Verabredung/Ereignis mit Datum. Ohne Uhrzeit ganztägig (start = null). "alle", "Familie", "wir" = alle IDs. Ohne Personenangabe: die tippende Person.
- aufgabe: etwas, das jemand erledigen soll ("Lina soll Zimmer aufräumen"). personen = genau eine ID, sonst die tippende Person. datum = Fälligkeit, falls genannt.
- einkauf: Dinge zum Kaufen. Alle Artikel in "dinge", ohne Mengen und Einheiten ("2 Liter Milch" → "Milch"). Ein Eintrag für alle Artikel.
- essen: geplantes Gericht ("Freitag Pizza"). mahlzeit "abend", wenn nicht anders gesagt.
- geburtstag: "Oma Rosi hat am 14.3. Geburtstag" / "geboren 12.05.1946". Ohne Jahr: Jahr 2000 eintragen und jahr_bekannt = false.

Regeln: Relative Angaben ("morgen", "nächsten Dienstag", "übermorgen") in echte Daten umrechnen. Ein Satz kann mehrere Einträge ergeben.
Erfinde nichts dazu. Titel kurz und natürlich auf Deutsch, ohne Datum und ohne Namen der Personen.
Felder, die für einen Typ nicht gelten: null bzw. leere Liste bzw. false.`;
  const out = await ask<EintragOut>(client, EintragSchema, system, text);
  const ids = new Set(members.map((m) => m.id));
  out.eintraege.forEach((e) => { e.personen = e.personen.filter((p) => ids.has(p)); });
  return out;
}

async function rezept(client: Anthropic, body: Record<string, unknown>) {
  const input = clip(body.input, MAX_INPUT_CHARS).trim();
  if (!input) throw new Error("Bitte einen Link oder Rezepttext einfügen.");
  let source = input;
  let link: string | null = null;
  if (/^https?:\/\/\S+$/i.test(input)) {
    const u = isPublicHttpUrl(input);
    if (!u) throw new Error("Dieser Link kann nicht geöffnet werden.");
    link = u.href;
    try {
      source = pageToText(await fetchPage(u));
    } catch (_e) {
      throw new Error("Die Rezeptseite konnte nicht geladen werden. Kopiere stattdessen den Rezepttext hinein.");
    }
  }
  const system = `Du liest Rezepte aus Webseiten oder eingefügtem Text aus und gibst sie sauber auf Deutsch zurück.
Übernimm Zutaten mit Mengen genau wie angegeben (eine Zutat pro Eintrag, Zwischenüberschriften wie "Für den Teig" weglassen).
Zubereitung als kurze, klare Schritte. Ignoriere Werbung, Kommentare und Navigation.
Ist kein Rezept enthalten, setze gefunden = false und lasse die Listen leer.`;
  const out = await ask<RezeptOut>(client, RezeptSchema, system, source);
  return { ...out, link };
}

async function wochenplan(client: Anthropic, body: Record<string, unknown>) {
  const days = (Array.isArray(body.days) ? body.days : []).map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 14);
  if (!days.length) throw new Error("In dieser Woche ist schon jeder Abend geplant.");
  const recipes = (Array.isArray(body.recipes) ? body.recipes : []).map((r) => clip(r, 80)).slice(0, 200);
  const recent = (Array.isArray(body.recent) ? body.recent : []).map((r) => clip(r, 80)).slice(0, 60);
  const wishes = clip(body.wishes, 300);
  const system = `Du planst Abendessen für eine Familie mit Kindern in Deutschland: alltagstauglich, abwechslungsreich, eher unkompliziert unter der Woche.
Plane genau ein Abendessen für jeden dieser freien Tage: ${days.map((d) => `${d} (${WOCHENTAGE[new Date(d + "T12:00:00").getDay()]})`).join(", ")}.
Bevorzuge die gespeicherten Rezepte der Familie (Titel dann exakt übernehmen, aus_rezepten = true), ergänze sonst mit eigenen Ideen.
Wiederhole keine Gerichte der letzten Wochen und keines doppelt.`;
  const user = `Gespeicherte Rezepte: ${recipes.join("; ") || "(keine)"}
Zuletzt gegessen: ${recent.join("; ") || "(nichts bekannt)"}
Wünsche: ${wishes || "(keine)"}`;
  const out = await ask<WochenOut>(client, WochenSchema, system, user);
  const allowed = new Set(days);
  out.vorschlaege = out.vorschlaege.filter((v) => allowed.has(v.datum));
  return out;
}

// ---------- Einstieg ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Nur POST" }, 405);

  // Nur angemeldete Familienmitglieder dürfen die KI nutzen
  const auth = req.headers.get("Authorization") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: userData } = await sb.auth.getUser();
  if (!userData?.user) return json({ error: "Bitte anmelden." }, 401);
  const { data: member } = await sb.from("members").select("id").eq("user_id", userData.user.id).maybeSingle();
  if (!member) return json({ error: "Kein Familienmitglied." }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (body.action === "ping") return json({ ok: !!key });
  if (!key) return json({ error: "Die KI ist noch nicht eingerichtet (ANTHROPIC_API_KEY fehlt)." }, 503);

  const client = new Anthropic({ apiKey: key });
  try {
    if (body.action === "eintrag") return json(await eintrag(client, body));
    if (body.action === "rezept") return json(await rezept(client, body));
    if (body.action === "wochenplan") return json(await wochenplan(client, body));
    return json({ error: "Unbekannte Aktion." }, 400);
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: "Die KI ist gerade ausgelastet. Bitte gleich noch einmal versuchen." }, 429);
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "Der API-Schlüssel der KI ist ungültig." }, 503);
    if (e instanceof Anthropic.APIError) { console.error(e); return json({ error: "Die KI ist gerade nicht erreichbar." }, 502); }
    return json({ error: e instanceof Error ? e.message : "Unbekannter Fehler." }, 400);
  }
});
