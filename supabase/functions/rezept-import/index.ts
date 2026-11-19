// Familien-App: Rezept aus Link übernehmen (Supabase Edge Function "rezept-import")
//
// Ohne KI und ohne Zusatzkosten: Rezeptseiten (z. B. Chefkoch) enthalten fast immer
// strukturierte Rezeptdaten im Format schema.org/Recipe. Diese Funktion lädt die Seite
// und liest Titel, Zutaten, Zubereitung und Portionen daraus aus.
// Einrichtung: siehe supabase/REZEPT-IMPORT-EINRICHTEN.md

import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------- Sicherheit: nur öffentliche Webseiten ----------
export function publicUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return null;
  if (/^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return null; // keine IP-Adressen
  return u;
}

async function fetchPage(u: URL): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(u, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "de-DE,de;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (res.url && !publicUrl(res.url)) throw new Error("Weiterleitung auf eine interne Adresse");
    const reader = res.body?.getReader();
    if (!reader) return "";
    const parts: Uint8Array[] = [];
    let size = 0;
    while (size < 3_000_000) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});
    const buf = new Uint8Array(size);
    let off = 0;
    for (const p of parts) { buf.set(p, off); off += p.length; }
    return new TextDecoder().decode(buf);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Auslesen ----------
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", frac12: "½", frac14: "¼", frac34: "¾", deg: "°", ndash: "–" };
export function clean(s: unknown): string {
  return String(s ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+\d*);/gi, (m, n) => ENT[n] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}
const isRecipe = (o: Record<string, unknown>) => {
  const t = o["@type"];
  return t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"));
};
function findRecipe(node: unknown, depth = 0): Record<string, unknown> | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const r = findRecipe(n, depth + 1); if (r) return r; }
    return null;
  }
  const o = node as Record<string, unknown>;
  if (isRecipe(o)) return o;
  for (const k of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
    const r = findRecipe(o[k], depth + 1);
    if (r) return r;
  }
  return null;
}
function steps(ins: unknown): string[] {
  if (!ins) return [];
  if (typeof ins === "string") return ins.split(/\n+|(?<=\.)\s+(?=[A-ZÄÖÜ])/).map(clean).filter(Boolean);
  if (Array.isArray(ins)) return ins.flatMap(steps);
  if (typeof ins === "object") {
    const o = ins as Record<string, unknown>;
    if (o.itemListElement) return steps(o.itemListElement); // HowToSection
    return [clean(o.text ?? o.name)].filter(Boolean);       // HowToStep
  }
  return [];
}
function yieldText(y: unknown): string {
  const v = Array.isArray(y) ? y.find((x) => /\D/.test(String(x))) ?? y[0] : y;
  const s = clean(v);
  return /^\d+$/.test(s) ? `${s} Portionen` : s;
}

export function parseRecipe(html: string) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let data: unknown;
    try { data = JSON.parse(b[1].trim()); } catch {
      try { data = JSON.parse(b[1].trim().replace(/[\u0000-\u001f]+/g, " ")); } catch { continue; }
    }
    const r = findRecipe(data);
    if (!r) continue;
    const ingredients = (Array.isArray(r.recipeIngredient) ? r.recipeIngredient : Array.isArray(r.ingredients) ? r.ingredients : [])
      .map(clean).filter(Boolean).slice(0, 80);
    const title = clean(r.name).slice(0, 80);
    if (!title && !ingredients.length) continue;
    return {
      title,
      ingredients,
      steps: steps(r.recipeInstructions).slice(0, 60),
      portions: yieldText(r.recipeYield),
    };
  }
  return null;
}

// ---------- Einstieg ----------
if (import.meta.main) Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Nur POST" }, 405);

  // Nur angemeldete Familienmitglieder
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: userData } = await sb.auth.getUser();
  if (!userData?.user) return json({ error: "Bitte anmelden." }, 401);
  const { data: member } = await sb.from("members").select("id").eq("user_id", userData.user.id).maybeSingle();
  if (!member) return json({ error: "Kein Familienmitglied." }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }
  if (body.action === "ping") return json({ ok: true });

  const u = publicUrl(String(body.url ?? ""));
  if (!u) return json({ error: "Das ist kein gültiger Link zu einer Webseite." }, 400);
  let html = "";
  try { html = await fetchPage(u); } catch (_e) {
    return json({ error: "Die Seite konnte nicht geladen werden. Manche Seiten sperren das. Dann bitte Zutaten von Hand einfügen." }, 422);
  }
  const recipe = parseRecipe(html);
  if (!recipe) return json({ error: "Auf dieser Seite wurde kein Rezept erkannt. Dann bitte Zutaten von Hand einfügen." }, 422);
  return json({ ...recipe, link: u.href });
});
