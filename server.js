/**
 * Training Analyzer Backend
 * - Garmin Connect: autenticación + actividades + stats
 * - Strava OAuth: autorización + edición de descripciones
 * - Anthropic: generación de entrenamientos diarios + análisis post-sesión
 *
 * Instalación: npm install
 * Uso:         node server.js
 */

import express from "express";
import cors from "cors";
import _garminPkg from "@gooin/garmin-connect";
const { GarminConnect } = _garminPkg;
import * as _corosPkg from "coros-connect";
const CorosConnect = _corosPkg.CorosConnect || _corosPkg.default || _corosPkg;
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// ── Strava config ─────────────────────────────────────────────────────────────
const STRAVA_CLIENT_ID     = process.env.STRAVA_CLIENT_ID     || "222061";
// Ignorar env var si Railway inyecta el placeholder del .env.example
const _envSecret = process.env.STRAVA_CLIENT_SECRET;
const STRAVA_CLIENT_SECRET = (_envSecret && _envSecret.length === 40 && !_envSecret.includes('_de_'))
  ? _envSecret
  : "13ea8e309ac7617a256dc2874eafa3d2f1b67ec3";
const STRAVA_REDIRECT      = process.env.STRAVA_REDIRECT_URL || `http://localhost:${PORT}/strava/callback`;
const STRAVA_TOKEN_FILE    = join(__dirname, ".strava_token.json");

let stravaToken = null;
// Prioridad: variable de entorno (persiste entre redeploys en Railway)
if (process.env.STRAVA_TOKEN_JSON) {
  try { stravaToken = JSON.parse(process.env.STRAVA_TOKEN_JSON); } catch {}
} else if (existsSync(STRAVA_TOKEN_FILE)) {
  try { stravaToken = JSON.parse(readFileSync(STRAVA_TOKEN_FILE, "utf8")); } catch {}
}

// ── Plan diario persistente ───────────────────────────────────────────────────
const PLAN_FILE = join(__dirname, ".daily_plan.json");
let dailyPlan = {};
if (existsSync(PLAN_FILE)) {
  try { dailyPlan = JSON.parse(readFileSync(PLAN_FILE, "utf8")); } catch {}
}
function savePlan() { writeFileSync(PLAN_FILE, JSON.stringify(dailyPlan, null, 2)); }

// ── Garmin client ─────────────────────────────────────────────────────────────
const GARMIN_SESSION_FILE = join(__dirname, ".garmin_session.json");
const garmin = new GarminConnect({ username: "placeholder", password: "placeholder" });
let garminLoggedIn = false;

// Intenta restaurar sesión guardada sin hacer login
async function tryRestoreGarminSession() {
  let saved = null;
  // Prioridad: variable de entorno (persiste entre redeploys en Railway)
  if (process.env.GARMIN_SESSION_JSON) {
    try { saved = JSON.parse(process.env.GARMIN_SESSION_JSON); } catch {}
  }
  // Fallback: archivo en disco (local)
  if (!saved && existsSync(GARMIN_SESSION_FILE)) {
    try { saved = JSON.parse(readFileSync(GARMIN_SESSION_FILE, "utf8")); } catch {}
  }
  if (!saved) return false;
  try {
    if (saved.oauth1Token) garmin.client.oauth1Token = saved.oauth1Token;
    if (saved.oauth2Token) garmin.client.oauth2Token = saved.oauth2Token;
    await garmin.getUserProfile();
    garminLoggedIn = true;
    console.log("Sesion Garmin restaurada");
    return true;
  } catch {
    console.log("Sesion Garmin expirada, requiere nuevo login");
    return false;
  }
}

function saveGarminSession() {
  try {
    writeFileSync(GARMIN_SESSION_FILE, JSON.stringify({
      oauth1Token: garmin.client.oauth1Token,
      oauth2Token: garmin.client.oauth2Token,
      savedAt: new Date().toISOString(),
    }, null, 2));
  } catch {}
}

// Restaurar sesión al arrancar
tryRestoreGarminSession();

// ── COROS client ──────────────────────────────────────────────────────────────
const COROS_TOKEN_FILE = join(__dirname, ".coros_token.json");
const coros = new CorosConnect();
let corosLoggedIn = false;

async function tryRestoreCorosSession() {
  let saved = null;
  if (process.env.COROS_TOKEN_JSON) {
    try { saved = JSON.parse(process.env.COROS_TOKEN_JSON); } catch {}
  }
  if (!saved && existsSync(COROS_TOKEN_FILE)) {
    try { saved = JSON.parse(readFileSync(COROS_TOKEN_FILE, "utf8")); } catch {}
  }
  if (!saved) return false;
  try {
    if (coros.loadToken) coros.loadToken(saved);
    else if (coros.token !== undefined) coros.token = saved.token || saved;
    // Verificar con llamada ligera
    await coros.getActivityList({ size: 1, pageNumber: 1 });
    corosLoggedIn = true;
    console.log("Sesion COROS restaurada");
    return true;
  } catch {
    console.log("Sesion COROS expirada, requiere nuevo login");
    return false;
  }
}

function saveCorosSession() {
  try {
    const tokenData = coros.getToken ? coros.getToken() : (coros.token || {});
    writeFileSync(COROS_TOKEN_FILE, JSON.stringify({ ...tokenData, savedAt: new Date().toISOString() }, null, 2));
  } catch {}
}

tryRestoreCorosSession();

// ── Anthropic client ──────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "" });

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cors({ origin: (o, cb) => cb(null, true), credentials: true }));

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDuration(s) {
  if (!s) return "—";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}` : `${m}:${String(sec).padStart(2,"0")}`;
}
function speedToPace(mps) {
  if (!mps || mps <= 0) return null;
  const spk = 1000 / mps;
  return `${Math.floor(spk/60)}:${String(Math.round(spk%60)).padStart(2,"0")}`;
}
function normalizeActivity(r) {
  return {
    activityId: r.activityId,
    name: r.activityName || r.name || "Actividad",
    type: r.activityType?.typeKey || "unknown",
    date: r.startTimeLocal ? new Date(r.startTimeLocal).toLocaleDateString("es-ES",{day:"2-digit",month:"short",year:"numeric"}) : "—",
    dateRaw: r.startTimeLocal,
    distanceKm: r.distance ? (r.distance/1000).toFixed(2) : null,
    durationFormatted: fmtDuration(r.duration),
    durationSeconds: r.duration,
    avgHr: r.averageHR ? Math.round(r.averageHR) : null,
    maxHr: r.maxHR ? Math.round(r.maxHR) : null,
    avgPace: r.averageSpeed ? speedToPace(r.averageSpeed) : null,
    elevationGain: r.elevationGain ? Math.round(r.elevationGain) : null,
    calories: r.calories ? Math.round(r.calories) : null,
    vo2max: r.vO2MaxValue || null,
    trainingEffect: r.aerobicTrainingEffect || null,
    avgCadence: r.averageRunningCadenceInStepsPerMinute || r.averageBikingCadenceInRevPerMinute || null,
  };
}
async function refreshStravaToken() {
  if (!stravaToken) return null;
  if (stravaToken.expires_at * 1000 > Date.now()) return stravaToken;
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: stravaToken.refresh_token,
    }),
  });
  stravaToken = await r.json();
  writeFileSync(STRAVA_TOKEN_FILE, JSON.stringify(stravaToken, null, 2));
  return stravaToken;
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", garminLoggedIn, corosLoggedIn, stravaConnected: !!stravaToken, time: new Date().toISOString() });
});

// ── Exportar sesión Garmin (para copiarlo a Railway Variables) ───────────────
app.get("/garmin/session-export", (_req, res) => {
  if (!garminLoggedIn) return res.status(404).json({ error: "No hay sesion de Garmin activa" });
  const sessionData = {
    oauth1Token: garmin.client.oauth1Token,
    oauth2Token: garmin.client.oauth2Token,
    savedAt: new Date().toISOString(),
  };
  res.json({ GARMIN_SESSION_JSON: JSON.stringify(sessionData) });
});

// ── Exportar token de Strava (para copiarlo a Railway Variables) ──────────────
app.get("/strava/token-export", (_req, res) => {
  if (!stravaToken) return res.status(404).json({ error: "No hay token de Strava" });
  res.json({ STRAVA_TOKEN_JSON: JSON.stringify(stravaToken) });
});

// ── Debug config de Strava ────────────────────────────────────────────────────
app.get("/strava/debug", (_req, res) => {
  const secret = STRAVA_CLIENT_SECRET;
  res.json({
    client_id: STRAVA_CLIENT_ID,
    client_secret_length: secret?.length,
    client_secret_preview: secret ? secret.slice(0,4) + "..." + secret.slice(-4) : null,
    redirect_url: STRAVA_REDIRECT,
    token_present: !!stravaToken,
  });
});

// ── Garmin auth ───────────────────────────────────────────────────────────────
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email y contraseña requeridos" });
  try {
    await garmin.login(email, password);
    garminLoggedIn = true;
    saveGarminSession();
    let displayName = email;
    try { const p = await garmin.getUserProfile(); displayName = p?.displayName || p?.userName || email; } catch {}
    res.json({ ok: true, displayName });
  } catch (err) {
    console.error("Garmin login error:", err.message);
    // Si tenemos tokens a pesar del error (bug de libreria con 429 post-login),
    // la sesion es valida — guardar y responder OK
    const hasTokens = garmin.client?.oauth1Token || garmin.client?.oauth2Token;
    if (hasTokens) {
      garminLoggedIn = true;
      saveGarminSession();
      console.log("Sesion Garmin valida a pesar del error:", err.message);
      return res.json({ ok: true, displayName: email });
    }
    garminLoggedIn = false;
    let msg = err.message || "Error desconocido";
    if (err.message?.toLowerCase().includes("429")) msg = "Demasiados intentos. Espera 30 minutos.";
    else if (err.message?.toLowerCase().includes("invalid")) msg = "Credenciales incorrectas";
    res.status(401).json({ error: msg, raw: err.message });
  }
});
app.get("/auth/status", (_req, res) => res.json({ loggedIn: garminLoggedIn }));
app.post("/auth/logout", (_req, res) => { garminLoggedIn = false; res.json({ ok: true }); });

// ── COROS auth ────────────────────────────────────────────────────────────────
app.post("/coros/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email y contraseña requeridos" });
  try {
    await coros.login(email, password);
    corosLoggedIn = true;
    saveCorosSession();
    res.json({ ok: true, displayName: email });
  } catch (err) {
    console.error("COROS login error:", err.message);
    corosLoggedIn = false;
    res.status(401).json({ error: err.message || "Error de autenticación con COROS" });
  }
});

app.get("/coros/status", (_req, res) => res.json({ loggedIn: corosLoggedIn }));
app.post("/coros/logout", (_req, res) => { corosLoggedIn = false; res.json({ ok: true }); });

app.get("/coros/activities", async (req, res) => {
  if (!corosLoggedIn) return res.status(401).json({ error: "No autenticado en COROS" });
  try {
    const limit = parseInt(req.query.limit) || 10;
    const data = await coros.getActivityList({ size: limit, pageNumber: 1 });
    const list = data?.data?.dataList || data?.dataList || [];
    const activities = list.map(a => ({
      activityId: a.labelId || a.activityId || a.id,
      name: a.name || a.sportType || "Actividad",
      date: a.startTime ? new Date(a.startTime * 1000).toLocaleDateString("es-ES", { day:"2-digit", month:"short", year:"numeric" }) : "—",
      dateRaw: a.startTime ? new Date(a.startTime * 1000).toISOString() : null,
      distanceKm: a.distance ? (a.distance / 100000).toFixed(2) : null,
      durationFormatted: a.totalTime ? `${Math.floor(a.totalTime/3600)}h ${Math.floor((a.totalTime%3600)/60)}m` : "—",
      avgHr: a.avgHr || null,
      avgPace: a.avgSpeed ? speedToPace(a.avgSpeed / 1000) : null,
      source: "coros",
    }));
    res.json({ activities });
  } catch (err) {
    res.status(500).json({ error: "Error al obtener actividades de COROS: " + err.message });
  }
});

app.get("/coros/session-export", (_req, res) => {
  if (!corosLoggedIn) return res.status(404).json({ error: "No hay sesion de COROS activa" });
  const tokenData = coros.getToken ? coros.getToken() : (coros.token || {});
  res.json({ COROS_TOKEN_JSON: JSON.stringify({ ...tokenData, savedAt: new Date().toISOString() }) });
});


// ── Actividades del año completo ──────────────────────────────────────────────

// GET /activities/year?year=2025 — descarga todas las actividades de un año
app.get("/activities/year", async (req, res) => {
  if (!garminLoggedIn) return res.status(401).json({ error: "No autenticado" });

  const year = parseInt(req.query.year) || new Date().getFullYear() - 1;
  const since = new Date(`${year}-01-01T00:00:00`);
  const until = new Date(`${year}-12-31T23:59:59`);

  console.log(`Descargando actividades de ${year}...`);
  const all = [];
  let start = 0;
  const batchSize = 100;
  let keepGoing = true;

  try {
    while (keepGoing) {
      console.log(`  Batch start=${start}...`);
      const batch = await garmin.getActivities(start, batchSize);
      if (!Array.isArray(batch) || batch.length === 0) break;

      for (const a of batch) {
        if (!a.startTimeLocal) continue;
        const d = new Date(a.startTimeLocal);
        if (d > until) continue;
        if (d < since) { keepGoing = false; break; }
        all.push(normalizeActivity(a));
      }

      if (batch.length < batchSize) break;
      start += batchSize;
      await new Promise(r => setTimeout(r, 300));
    }

    const cacheFile = join(__dirname, `.activities_${year}.json`);
    writeFileSync(cacheFile, JSON.stringify(all, null, 2));
    console.log(`✅ ${all.length} actividades de ${year} guardadas`);
    res.json({ year, count: all.length, activities: all });
  } catch (err) {
    console.error("Year activities error:", err.message);
    res.status(500).json({ error: err.message, partial: all });
  }
});

// GET /activities/year/cache?year=2025 — devuelve actividades cacheadas
app.get("/activities/year/cache", (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear() - 1;
  const cacheFile = join(__dirname, `.activities_${year}.json`);
  if (!existsSync(cacheFile)) return res.status(404).json({ error: `Sin caché para ${year}. Llama primero a /activities/year?year=${year}` });
  try {
    const data = JSON.parse(readFileSync(cacheFile, "utf8"));
    res.json({ year, count: data.length, activities: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Garmin activities ─────────────────────────────────────────────────────────
app.get("/activities", async (req, res) => {
  if (!garminLoggedIn) return res.status(401).json({ error: "No autenticado en Garmin" });
  const limit = parseInt(req.query.limit) || 20;
  const start = parseInt(req.query.start) || 0;
  try {
    const raw = await garmin.getActivities(start, limit);
    res.json({ activities: (Array.isArray(raw) ? raw : []).map(normalizeActivity) });
  } catch (err) {
    res.status(500).json({ error: "No se pudieron obtener actividades: " + err.message });
  }
});

app.get("/activity/:id", async (req, res) => {
  if (!garminLoggedIn) return res.status(401).json({ error: "No autenticado en Garmin" });
  const id = req.params.id;
  try {
    // Obtener datos en paralelo para mayor velocidad
    const [detail, splits, hrStream] = await Promise.allSettled([
      garmin.getActivity({ activityId: id }),
      garmin.getActivitySplits({ activityId: id }).catch(() => null),
      garmin.getActivityHrTimeSeries({ activityId: id }).catch(() => null),
    ]);

    const act = detail.status === "fulfilled" ? detail.value : {};
    const laps = splits.status === "fulfilled" && splits.value ? splits.value : null;
    const hr   = hrStream.status === "fulfilled" && hrStream.value ? hrStream.value : null;

    // Calcular métricas derivadas
    const metrics = computeActivityMetrics(act, laps, hr);
    res.json({ activity: act, laps, hrStream: hr, metrics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Calcula métricas avanzadas de una sesión
function computeActivityMetrics(act, laps, hrStream) {
  const metrics = {};

  // ── Drift de FC (cardiac drift) ───────────────────────────────────────────
  // Comparar FC primera mitad vs segunda mitad de la actividad
  if (laps && Array.isArray(laps.lapDTOs) && laps.lapDTOs.length >= 2) {
    const lapList = laps.lapDTOs;
    const mid = Math.floor(lapList.length / 2);
    const firstHalf = lapList.slice(0, mid).filter(l => l.averageHR);
    const secondHalf = lapList.slice(mid).filter(l => l.averageHR);
    if (firstHalf.length && secondHalf.length) {
      const avgFirst = firstHalf.reduce((s, l) => s + l.averageHR, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((s, l) => s + l.averageHR, 0) / secondHalf.length;
      metrics.hrDrift = parseFloat((avgSecond - avgFirst).toFixed(1));
      metrics.hrDriftPercent = parseFloat(((avgSecond - avgFirst) / avgFirst * 100).toFixed(1));
    }

    // ── Splits por km ──────────────────────────────────────────────────────
    metrics.splits = lapList.map((l, i) => ({
      lap: i + 1,
      distanceKm: l.distance ? (l.distance / 1000).toFixed(2) : null,
      pace: l.averageSpeed ? speedToPace(l.averageSpeed) : null,
      avgHr: l.averageHR ? Math.round(l.averageHR) : null,
      maxHr: l.maxHR ? Math.round(l.maxHR) : null,
      cadence: l.averageRunningCadenceInStepsPerMinute || null,
      elevGain: l.elevationGain ? Math.round(l.elevationGain) : null,
    }));

    // ── Pace drift (ritmo primera vs segunda mitad) ────────────────────────
    const firstPaces = lapList.slice(0, mid).filter(l => l.averageSpeed).map(l => l.averageSpeed);
    const secondPaces = lapList.slice(mid).filter(l => l.averageSpeed).map(l => l.averageSpeed);
    if (firstPaces.length && secondPaces.length) {
      const avgFirst = firstPaces.reduce((s,v) => s+v,0) / firstPaces.length;
      const avgSecond = secondPaces.reduce((s,v) => s+v,0) / secondPaces.length;
      const paceFirstSec = 1000 / avgFirst;
      const paceSecondSec = 1000 / avgSecond;
      metrics.paceDriftSeconds = parseFloat((paceSecondSec - paceFirstSec).toFixed(1));
      metrics.paceDriftPercent = parseFloat(((paceSecondSec - paceFirstSec) / paceFirstSec * 100).toFixed(1));
    }
  }

  // ── Carga de entrenamiento (Training Load) ─────────────────────────────────
  // TRIMP simplificado: duración(min) × FC_ratio × factor_intensidad
  if (act.averageHR && act.duration) {
    const fcMax = act.maxHR || 186;
    const fcRest = 50; // estimado
    const fcReserve = fcMax - fcRest;
    const fcRatio = (act.averageHR - fcRest) / fcReserve;
    const durationMin = act.duration / 60;
    // Factor de género (0.64 neutro)
    const trimp = Math.round(durationMin * fcRatio * 0.64 * Math.exp(1.92 * fcRatio));
    metrics.trimp = trimp;

    // Clasificación de carga
    metrics.loadCategory = trimp < 50 ? "baja" : trimp < 100 ? "moderada" : trimp < 150 ? "alta" : "muy alta";
  }

  // ── Eficiencia aeróbica (Aerobic Efficiency) ───────────────────────────────
  // pace (min/km) / FC_media — menor es mejor
  if (act.averageSpeed && act.averageHR) {
    const paceSecPerKm = 1000 / act.averageSpeed;
    metrics.aerobicEfficiency = parseFloat((paceSecPerKm / act.averageHR).toFixed(3));
  }

  // ── Decoupling aeróbico ────────────────────────────────────────────────────
  // Si pace se mantiene pero FC sube → mal decoupling (fatiga aeróbica)
  if (metrics.hrDriftPercent !== undefined && metrics.paceDriftPercent !== undefined) {
    metrics.aerobicDecoupling = parseFloat((metrics.hrDriftPercent - metrics.paceDriftPercent).toFixed(1));
    metrics.decouplingQuality = metrics.aerobicDecoupling < 5 ? "bueno" : metrics.aerobicDecoupling < 10 ? "aceptable" : "mejorable";
  }

  // ── Zonas de FC ────────────────────────────────────────────────────────────
  if (laps && Array.isArray(laps.lapDTOs)) {
    const fcMax = act.maxHR || 186;
    const zones = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
    laps.lapDTOs.forEach(l => {
      if (!l.averageHR || !l.duration) return;
      const pct = l.averageHR / fcMax;
      const t = l.duration / 60;
      if (pct < 0.60) zones.z1 += t;
      else if (pct < 0.70) zones.z2 += t;
      else if (pct < 0.80) zones.z3 += t;
      else if (pct < 0.90) zones.z4 += t;
      else zones.z5 += t;
    });
    const total = Object.values(zones).reduce((s,v) => s+v, 0) || 1;
    metrics.hrZones = Object.fromEntries(
      Object.entries(zones).map(([k,v]) => [k, parseFloat((v/total*100).toFixed(1))])
    );
  }

  return metrics;
}

// GET /activity/:id/analyze — análisis IA detallado de una sesión vs plan
app.post("/activity/:id/analyze-detail", async (req, res) => {
  if (!garminLoggedIn) return res.status(401).json({ error: "No autenticado" });
  const { plannedSession } = req.body;
  const id = req.params.id;

  try {
    const [detail, splits] = await Promise.allSettled([
      garmin.getActivity({ activityId: id }),
      garmin.getActivitySplits({ activityId: id }).catch(() => null),
    ]);
    const act = detail.status === "fulfilled" ? detail.value : {};
    const laps = splits.status === "fulfilled" ? splits.value : null;
    const metrics = computeActivityMetrics(act, laps, null);

    const splitsText = metrics.splits?.length
      ? metrics.splits.map(s => `  Km ${s.lap}: ${s.pace} min/km · ${s.avgHr} bpm · cad ${s.cadence || "—"}`).join("\n")
      : "Sin datos de splits";

    const prompt = `Eres un entrenador de élite. Analiza en detalle esta sesión de running.

SESIÓN REALIZADA:
- Nombre: ${act.activityName || "Running"}
- Distancia: ${act.distance ? (act.distance/1000).toFixed(2) : "—"} km
- Tiempo: ${fmtDuration(act.duration)}
- FC media: ${act.averageHR ? Math.round(act.averageHR) : "—"} bpm
- FC máxima: ${act.maxHR ? Math.round(act.maxHR) : "—"} bpm
- Ritmo medio: ${act.averageSpeed ? speedToPace(act.averageSpeed) : "—"} min/km
- Cadencia media: ${act.averageRunningCadenceInStepsPerMinute || "—"} spm
- Desnivel: ${act.elevationGain ? Math.round(act.elevationGain) : 0} m
- Calorías: ${act.calories ? Math.round(act.calories) : "—"}

MÉTRICAS AVANZADAS:
- TRIMP (carga): ${metrics.trimp || "—"} (${metrics.loadCategory || "—"})
- Drift de FC: ${metrics.hrDrift !== undefined ? `+${metrics.hrDrift} bpm (${metrics.hrDriftPercent}%)` : "—"}
- Drift de ritmo: ${metrics.paceDriftSeconds !== undefined ? `${metrics.paceDriftSeconds}s/km (${metrics.paceDriftPercent}%)` : "—"}
- Decoupling aeróbico: ${metrics.aerobicDecoupling !== undefined ? `${metrics.aerobicDecoupling}% (${metrics.decouplingQuality})` : "—"}
- Eficiencia aeróbica: ${metrics.aerobicEfficiency || "—"}
- Zonas FC: ${metrics.hrZones ? `Z1:${metrics.hrZones.z1}% Z2:${metrics.hrZones.z2}% Z3:${metrics.hrZones.z3}% Z4:${metrics.hrZones.z4}% Z5:${metrics.hrZones.z5}%` : "—"}

SPLITS POR KM:
${splitsText}

${plannedSession ? `OBJETIVO PLANIFICADO:
- Tipo: ${plannedSession.type}
- Objetivo: ${plannedSession.objective}
- Distancia objetivo: ${plannedSession.targetDistance}
- Ritmo objetivo: ${plannedSession.targetPace}
- FC objetivo: ${plannedSession.targetHr}` : ""}

Genera un análisis técnico detallado que incluya:
1. VALORACIÓN GLOBAL (nota /10 y resumen)
2. ANÁLISIS DEL DRIFT — qué indica el drift de FC y ritmo sobre la condición aeróbica
3. ANÁLISIS POR SPLITS — identifica patrones, km más duros, mejor tramo
4. CARGA DE TRABAJO — interpretación del TRIMP y distribución por zonas
5. PUNTOS DE MEJORA — 2-3 aspectos concretos a trabajar
6. RECOMENDACIÓN PARA LA PRÓXIMA SESIÓN — basada en esta carga

Sé técnico y específico con los números. Máximo 400 palabras. En español. Termina con la firma — IntKM`;

    const message = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });
    const analysis = message.content.map(b => b.text||"").join("").trim();
    res.json({ ok: true, analysis, metrics });
  } catch (err) {
    console.error("Analyze detail error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Strava OAuth ──────────────────────────────────────────────────────────────
app.get("/strava/auth", (_req, res) => {
  const url = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(STRAVA_REDIRECT)}&response_type=code&scope=activity:read_all,activity:write`;
  res.redirect(url);
});

app.get("/strava/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.send(`<script>window.opener.postMessage({stravaError:'${error||"cancelled"}'}, '*'); window.close();</script>`);
  try {
    const r = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET, code, grant_type: "authorization_code" }),
    });
    const tokenData = await r.json();
    if (!tokenData.access_token) {
      const errMsg = tokenData.message || JSON.stringify(tokenData);
      return res.send(`<script>window.opener.postMessage({stravaError:'${errMsg}'}, '*'); window.close();</script>`);
    }
    stravaToken = tokenData;
    writeFileSync(STRAVA_TOKEN_FILE, JSON.stringify(stravaToken, null, 2));
    const name = stravaToken.athlete?.firstname || "atleta";
    res.send(`<script>window.opener.postMessage({stravaOk:true, name:'${name}'}, '*'); window.close();</script>`);
  } catch (err) {
    res.send(`<script>window.opener.postMessage({stravaError:'${err.message}'}, '*'); window.close();</script>`);
  }
});

app.get("/strava/status", (_req, res) => {
  res.json({ connected: !!stravaToken, athlete: stravaToken?.athlete || null });
});

app.get("/strava/activities", async (req, res) => {
  const token = await refreshStravaToken();
  if (!token) return res.status(401).json({ error: "No conectado a Strava" });
  try {
    const r = await fetch(`https://www.strava.com/api/v3/athlete/activities?per_page=${req.query.limit||10}`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const acts = await r.json();
    if (!Array.isArray(acts)) {
      const msg = acts?.message || acts?.errors?.[0]?.field || JSON.stringify(acts);
      return res.status(401).json({ error: "Strava: " + msg });
    }
    res.json({ activities: acts.map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      date: new Date(a.start_date_local).toLocaleDateString("es-ES",{day:"2-digit",month:"short",year:"numeric"}),
      dateRaw: a.start_date_local,
      distanceKm: (a.distance/1000).toFixed(2),
      durationFormatted: fmtDuration(a.moving_time),
      avgHr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
      avgPace: a.average_speed ? speedToPace(a.average_speed) : null,
      description: a.description || "",
    }))});
  } catch (err) {
    res.status(500).json({ error: "Error al obtener actividades de Strava: " + err.message });
  }
});

app.put("/strava/activity/:id/description", async (req, res) => {
  const token = await refreshStravaToken();
  if (!token) return res.status(401).json({ error: "No conectado a Strava" });
  const { description } = req.body;
  try {
    const r = await fetch(`https://www.strava.com/api/v3/activities/${req.params.id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ description }),
    });
    const updated = await r.json();
    res.json({ ok: true, description: updated.description });
  } catch (err) {
    res.status(500).json({ error: "Error al actualizar Strava: " + err.message });
  }
});

// ── Plan diario + análisis IA ─────────────────────────────────────────────────

// GET /plan/today — devuelve el plan del día actual
app.get("/plan/today", (_req, res) => {
  const today = new Date().toISOString().slice(0,10);
  res.json({ date: today, plan: dailyPlan[today] || null });
});

// ── Helpers para construir workouts Garmin ────────────────────────────────────

// Extrae número de un string como "8 km", "8.5km", "8"
function parseKm(str) {
  if (!str) return null;
  const n = parseFloat(String(str).replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : n;
}
function paceToMps(pace) {
  if (!pace) return null;
  const clean = pace.replace(" min/km", "").trim();
  const [m, s] = clean.split(":").map(Number);
  if (isNaN(m)) return null;
  const secPerKm = m * 60 + (s || 0);
  return parseFloat((1000 / secPerKm).toFixed(4));
}

// Construye un step de workout Garmin
function makeStep(type, description, durationType, durationValueMeters, targetType, targetFrom, targetTo, order) {
  // IDs reales confirmados desde respuesta de Garmin:
  // conditionTypeId=2 → time (segundos)
  // conditionTypeId=3 → distance (metros)
  const durationTypeId = durationType === "distance" ? 3 : 2;

  return {
    type: "ExecutableStepDTO",
    stepId: null,
    stepOrder: order,
    stepType: { stepTypeId: type === "warmup" ? 1 : type === "cooldown" ? 2 : type === "interval" ? 3 : 4, stepTypeKey: type },
    description,
    durationType: { durationTypeId, durationTypeKey: durationType },
    endCondition: { conditionTypeId: durationTypeId, conditionTypeKey: durationType },
    endConditionValue: durationValueMeters,
    preferredEndConditionUnit: durationType === "distance" ? { unitId: 2, unitKey: "kilometer", factor: 100000 } : null,
    targetType: { workoutTargetTypeId: targetType === "pace" ? 6 : targetType === "heart_rate" ? 4 : 1, workoutTargetTypeKey: targetType === "heart_rate" ? "heart.rate.zone" : targetType },
    targetValueOne: targetFrom || null,
    targetValueTwo: targetTo || null,
  };
}

// Construye un repeat step (bloque de series)
function makeRepeatStep(repeatCount, steps, order) {
  return {
    type: "RepeatGroupDTO",
    stepId: null,
    stepOrder: order,
    stepType: { stepTypeId: 6, stepTypeKey: "repeat" },
    numberOfIterations: repeatCount,
    smartRepeat: false,
    workoutSteps: steps,
  };
}

function buildGarminWorkout(plan) {
  console.log("buildGarminWorkout:", JSON.stringify({ type: plan.type, targetDistance: plan.targetDistance, targetHr: plan.targetHr, targetPace: plan.targetPace, duration: plan.duration, intervals: plan.intervals }));
  const steps = [];
  let order = 1;
  const totalDistM = Math.round((parseKm(plan.targetDistance) || 8) * 1000);
  console.log(`totalDistM: ${totalDistM}m (de targetDistance: "${plan.targetDistance}")`);

  // Garmin endConditionValue para distancia debe estar en metros enteros
  const distToMeters = (km) => Math.round((parseKm(km) || 1) * 1000);

  if (plan.type === "interval" && plan.intervals) {
    const ivs = plan.intervals;
    const intFast = paceToMps(ivs.paceFast);
    const intSlow = paceToMps(ivs.paceSlow);
    const recSlow = paceToMps("6:30");
    const recFast = paceToMps("7:30");
    // Calentamiento + series + vuelta a la calma
    steps.push(makeStep("warmup", "Calentamiento suave", "distance", 2000, "pace", paceToMps("6:30"), paceToMps("6:00"), order++));
    const intervalStep = makeStep("interval", `Serie ${ivs.distanceMeters}m`, "distance", ivs.distanceMeters, "pace", intSlow, intFast, 1);
    const recoveryStep = makeStep("recovery", `Recuperación ${ivs.recoveryMeters}m`, "distance", ivs.recoveryMeters, "pace", recSlow, recFast, 2);
    steps.push(makeRepeatStep(ivs.reps, [intervalStep, recoveryStep], order++));
    steps.push(makeStep("cooldown", "Vuelta a la calma", "distance", 1000, "pace", paceToMps("6:30"), paceToMps("7:00"), order++));

  } else if (plan.type === "tempo") {
    const tFast = paceToMps(plan.targetPace?.replace(" min/km", ""));
    const tSlow = tFast ? parseFloat((tFast * 0.95).toFixed(4)) : null;
    // Calentamiento + tempo + vuelta a la calma
    steps.push(makeStep("warmup", "Calentamiento suave", "distance", 2000, "pace", paceToMps("6:30"), paceToMps("6:00"), order++));
    steps.push(makeStep("interval", "Tramo tempo", "distance", Math.round(totalDistM * 0.7), tFast ? "pace" : "no_target", tSlow, tFast, order++));
    steps.push(makeStep("cooldown", "Vuelta a la calma", "distance", 1000, "pace", paceToMps("6:30"), paceToMps("7:00"), order++));

  } else {
    // Easy / long — único bloque continuo por FC, sin warmup/cooldown separados
    const hrParts = (plan.targetHr || "140-155").split("-").map(Number);
    steps.push(makeStep("interval", plan.title || "Carrera continua", "distance", totalDistM, "heart_rate", hrParts[0] || 140, hrParts[1] || 155, order++));
  }

  return {
    sportType: { sportTypeId: 1, sportTypeKey: "running" },
    workoutName: plan.title || "Entrenamiento IA",
    description: plan.objective || "",
    estimatedDurationInSecs: Math.round((parseKm(plan.duration) || 50) * 60),
    estimatedDistanceInMeters: totalDistM,
    workoutSegments: [{
      segmentOrder: 1,
      sportType: { sportTypeId: 1, sportTypeKey: "running" },
      workoutSteps: steps,
    }],
  };
}

// Sube el workout a Garmin y lo programa para una fecha
async function uploadWorkoutToGarmin(plan, dateStr) {
  if (!garminLoggedIn) throw new Error("No autenticado en Garmin");
  const payload = buildGarminWorkout(plan);

  // 1. Crear el workout
  const created = await garmin.addWorkout(payload);
  const workoutId = created?.workoutId;
  if (!workoutId) throw new Error("Garmin no devolvió workoutId");

  // 2. Asegurar formato YYYY-MM-DD correcto
  const dateClean = dateStr ? dateStr.slice(0, 10) : new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const [y, m, d] = dateClean.split("-").map(Number);
  const dateObj = new Date(y, m - 1, d, 12, 0, 0); // mediodía local para evitar problemas de zona horaria
  console.log(`Programando workout ${workoutId} para ${dateClean}`);

  // 3. Programar — intentar con Date object y fallback a string
  try {
    await garmin.scheduleWorkout({ workoutId }, dateObj);
  } catch {
    await garmin.scheduleWorkout({ workoutId }, dateClean);
  }
  return workoutId;
}

// Extrae el primer objeto JSON completo de un string, aunque haya texto extra
function extractJSON(text) {
  const clean = text.replace(/^```json\s*/,'').replace(/```$/,'').trim();
  const start = clean.indexOf('{');
  if (start === -1) throw new Error('No JSON object found');
  let depth = 0, i = start, inStr = false, escape = false;
  for (; i < clean.length; i++) {
    const c = clean[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (!inStr) {
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return JSON.parse(clean.slice(start, i+1)); }
    }
  }
  return JSON.parse(clean.slice(start));
}

// POST /plan/annual — genera macrociclo anual basado en historial + eventos
app.post("/plan/annual", async (req, res) => {
  const { year, events } = req.body; // events: [{name, date}]
  const dataYear = year || new Date().getFullYear() - 1;
  const cacheFile = join(__dirname, `.activities_${dataYear}.json`);

  let activities = [];
  if (existsSync(cacheFile)) {
    activities = JSON.parse(readFileSync(cacheFile, "utf8"));
  } else {
    return res.status(400).json({ error: `No hay datos de ${dataYear}. Llama primero a /activities/year?year=${dataYear}` });
  }

  // Calcular métricas del año
  const running = activities.filter(a => ["running","trail_running","treadmill_running"].includes(a.type));
  const totalKm = running.reduce((s, a) => s + parseFloat(a.distanceKm || 0), 0);
  const totalHours = running.reduce((s, a) => s + (a.durationSeconds || 0), 0) / 3600;
  const avgHr = running.filter(a => a.avgHr).reduce((s, a, _, arr) => s + a.avgHr / arr.length, 0);

  // Volumen mensual
  const monthly = {};
  for (let m = 1; m <= 12; m++) monthly[m] = 0;
  running.forEach(a => {
    if (!a.dateRaw) return;
    const m = new Date(a.dateRaw).getMonth() + 1;
    monthly[m] += parseFloat(a.distanceKm || 0);
  });

  // Semana más cargada y más ligera
  const weekly = {};
  running.forEach(a => {
    if (!a.dateRaw) return;
    const d = new Date(a.dateRaw);
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - d.getDay());
    const key = weekStart.toISOString().slice(0,10);
    weekly[key] = (weekly[key] || 0) + parseFloat(a.distanceKm || 0);
  });
  const weeklyVals = Object.values(weekly);
  const maxWeekKm = Math.max(...weeklyVals);
  const avgWeekKm = weeklyVals.reduce((s,v) => s+v, 0) / (weeklyVals.length || 1);

  const prompt = `Eres un entrenador de atletismo de élite especializado en periodización anual. Analiza el historial real de este atleta y genera un plan anual completo con macrociclos.

DATOS REALES DEL AÑO ${dataYear}:
- Total actividades running: ${running.length}
- Distancia total: ${Math.round(totalKm)} km
- Horas totales: ${totalHours.toFixed(1)} h
- FC media histórica: ${Math.round(avgHr)} bpm
- Volumen semanal medio: ${avgWeekKm.toFixed(1)} km/sem
- Semana pico máxima: ${maxWeekKm.toFixed(1)} km
- Volumen mensual (km): ${Object.entries(monthly).map(([m,km]) => `${['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][m-1]}:${Math.round(km)}`).join(' ')}
${events?.length ? `\nEVENTOS OBJETIVO:\n${events.map(e => `- ${e.name}: ${e.date}`).join('\n')}` : ''}

Genera un plan anual completo para ${new Date().getFullYear()} con esta estructura exacta en JSON (sin markdown):
{
  "summary": "Resumen ejecutivo del atleta en 2-3 frases",
  "strengths": ["punto fuerte 1", "punto fuerte 2", "punto fuerte 3"],
  "weaknesses": ["área mejora 1", "área mejora 2"],
  "annualTarget": "Objetivo principal del año",
  "peakWeekKm": XX,
  "phases": [
    {
      "phase": "base|development|peak|recovery",
      "name": "Nombre de la fase",
      "startMonth": 1,
      "endMonth": 3,
      "weeklyKmTarget": XX,
      "intensityPercent": XX,
      "description": "Descripción de la fase",
      "keyWorkouts": ["tipo sesión 1", "tipo sesión 2", "tipo sesión 3"],
      "weekStructure": {
        "monday": "rest|easy|tempo|interval|long",
        "tuesday": "rest|easy|tempo|interval|long",
        "wednesday": "rest|easy|tempo|interval|long",
        "thursday": "rest|easy|tempo|interval|long",
        "friday": "rest|easy|tempo|interval|long",
        "saturday": "rest|easy|tempo|interval|long",
        "sunday": "rest|easy|tempo|interval|long"
      }
    }
  ]
}`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = message.content.map(b => b.text||"").join("").trim()
      .replace(/^```json\s*/,"").replace(/```$/,"").trim();
    const annualPlan = extractJSON(raw);

    // Guardar en disco
    const planFile = join(__dirname, `.annual_plan_${new Date().getFullYear()}.json`);
    writeFileSync(planFile, JSON.stringify({ ...annualPlan, generatedAt: new Date().toISOString(), basedOnYear: dataYear, events }, null, 2));

    res.json({ ok: true, plan: annualPlan });
  } catch (err) {
    console.error("Annual plan error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /plan/annual — devuelve el plan anual guardado
app.get("/plan/annual", (_req, res) => {
  const planFile = join(__dirname, `.annual_plan_${new Date().getFullYear()}.json`);
  if (!existsSync(planFile)) return res.status(404).json({ error: "No hay plan anual generado aún" });
  try {
    res.json(JSON.parse(readFileSync(planFile, "utf8")));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: determina en qué fase del plan anual estamos hoy
function getCurrentPhase(annualPlan) {
  if (!annualPlan?.phases?.length) return null;
  const today = new Date();
  const month = today.getMonth() + 1;
  return annualPlan.phases.find(p => month >= p.startMonth && month <= p.endMonth) || annualPlan.phases[0];
}

// Helper: calcula semana del año
function getWeekOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 1);
  return Math.ceil(((date - start) / 86400000 + start.getDay() + 1) / 7);
}

// Helper: calcula carga de la última semana
function getLastWeekLoad(activities) {
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const lastWeek = activities.filter(a => a.dateRaw && new Date(a.dateRaw) >= weekAgo);
  return {
    totalKm: lastWeek.reduce((s, a) => s + parseFloat(a.distanceKm || 0), 0).toFixed(1),
    sessions: lastWeek.length,
    avgHr: lastWeek.filter(a => a.avgHr).length
      ? Math.round(lastWeek.filter(a => a.avgHr).reduce((s, a) => s + a.avgHr, 0) / lastWeek.filter(a => a.avgHr).length)
      : null,
  };
}

// ── Métricas de adaptación corporal (CTL/ATL/TSB) ─────────────────────────────
function calcTRIMP(activity) {
  if (!activity.avgHr || !activity.durationSeconds) return 0;
  const fcMax = activity.maxHr || 186;
  const fcRest = 50;
  const fcRatio = Math.max(0, (activity.avgHr - fcRest) / (fcMax - fcRest));
  const durationMin = activity.durationSeconds / 60;
  return Math.round(durationMin * fcRatio * 0.64 * Math.exp(1.92 * fcRatio));
}

function computeBodyAdaptation(activities) {
  if (!activities.length) return null;
  const sorted = [...activities].filter(a => a.dateRaw).sort((a, b) => new Date(a.dateRaw) - new Date(b.dateRaw));

  // TRIMP por día
  const trimpByDay = {};
  sorted.forEach(a => {
    const day = a.dateRaw.slice(0, 10);
    trimpByDay[day] = (trimpByDay[day] || 0) + calcTRIMP(a);
  });

  // CTL (42d) y ATL (7d) con decaimiento exponencial
  const kCTL = 1 - Math.exp(-1 / 42);
  const kATL = 1 - Math.exp(-1 / 7);
  let ctl = 0, atl = 0;
  const firstDate = new Date(sorted[0].dateRaw);
  for (let d = new Date(firstDate); d <= new Date(); d.setDate(d.getDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const trimp = trimpByDay[key] || 0;
    ctl = ctl + kCTL * (trimp - ctl);
    atl = atl + kATL * (trimp - atl);
  }
  const tsb = ctl - atl;

  // Tendencia de ritmo últimas 4 semanas vs 4 anteriores
  const now = Date.now();
  const last4w = sorted.filter(a => new Date(a.dateRaw) >= new Date(now - 28 * 86400000));
  const prev4w = sorted.filter(a => { const d = new Date(a.dateRaw); return d >= new Date(now - 56 * 86400000) && d < new Date(now - 28 * 86400000); });

  const avgPaceSec = (acts) => {
    const w = acts.filter(a => a.avgPace);
    if (!w.length) return null;
    return w.reduce((s, a) => { const [m, sec] = a.avgPace.split(":").map(Number); return s + m * 60 + (sec || 0); }, 0) / w.length;
  };
  const pace4w = avgPaceSec(last4w), pacePrev = avgPaceSec(prev4w);
  const paceTrend = (pace4w && pacePrev) ? parseFloat(((pacePrev - pace4w) / pacePrev * 100).toFixed(1)) : null;

  // Tendencia FC últimas 2 semanas vs 2 anteriores
  const last2w = sorted.filter(a => new Date(a.dateRaw) >= new Date(now - 14 * 86400000) && a.avgHr);
  const prev2w = sorted.filter(a => { const d = new Date(a.dateRaw); return d >= new Date(now - 28 * 86400000) && d < new Date(now - 14 * 86400000) && a.avgHr; });
  const avgHr2w = last2w.length ? Math.round(last2w.reduce((s,a) => s+a.avgHr,0)/last2w.length) : null;
  const avgHrPrev = prev2w.length ? Math.round(prev2w.reduce((s,a) => s+a.avgHr,0)/prev2w.length) : null;
  const hrTrend = (avgHr2w && avgHrPrev) ? avgHrPrev - avgHr2w : null;

  // Adherencia: sesiones reales vs esperadas (4/sem)
  const weeksInPlan = Math.max(1, Math.ceil((Date.now() - firstDate.getTime()) / (7 * 86400000)));
  const adherence = Math.min(100, Math.round((sorted.length / (weeksInPlan * 4)) * 100));

  // Volumen medio últimas 4 semanas
  const avgKmWeek = parseFloat((last4w.reduce((s,a) => s + parseFloat(a.distanceKm||0), 0) / 4).toFixed(1));

  // Estado de forma
  let formState, formAdvice;
  if (tsb > 15)       { formState = "muy fresco";   formAdvice = "Forma óptima — ideal sesión de calidad máxima o competición"; }
  else if (tsb > 5)   { formState = "fresco";        formAdvice = "Buena forma — apto para sesión de calidad o tirada larga"; }
  else if (tsb > -5)  { formState = "equilibrado";   formAdvice = "Forma neutral — sesión moderada, escucha el cuerpo"; }
  else if (tsb > -15) { formState = "cargado";       formAdvice = "Fatiga moderada acumulada — bajar intensidad, priorizar Z2"; }
  else                { formState = "fatigado";       formAdvice = "Fatiga alta — descanso activo o día libre obligatorio"; }

  // Señales de sobreentrenamiento
  const overreachWarning = tsb < -20 || (hrTrend !== null && hrTrend < -5);

  return {
    ctl: Math.round(ctl), atl: Math.round(atl), tsb: Math.round(tsb),
    formState, formAdvice, overreachWarning,
    paceTrendPercent: paceTrend,
    paceTrendDir: paceTrend === null ? null : paceTrend > 0 ? "mejorando" : "empeorando",
    hrTrendBpm: hrTrend,
    hrTrendDir: hrTrend === null ? null : hrTrend > 0 ? "bajando (adaptación +)" : "subiendo (fatiga?)",
    adherencePercent: adherence,
    avgKmPerWeekLast4w: avgKmWeek,
    totalActivitiesAnalyzed: sorted.length,
  };
}

// GET /athlete/adaptation — métricas de adaptación actuales
app.get("/athlete/adaptation", (_req, res) => {
  try {
    let allActivities = [];
    for (const y of [2025, 2024]) {
      const f = join(__dirname, `.activities_${y}.json`);
      if (existsSync(f)) allActivities = allActivities.concat(JSON.parse(readFileSync(f, "utf8")));
    }
    if (!allActivities.length) return res.json({ error: "Sin datos — descarga primero las actividades" });
    res.json(computeBodyAdaptation(allActivities));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /plan/generate — genera el plan de mañana alineado con el macrociclo anual
app.post("/plan/generate", async (req, res) => {
  const { lastActivity, goal, weeksData } = req.body;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);
  const weekOfYear = getWeekOfYear(tomorrow);
  const dayOfWeek = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'][tomorrow.getDay()];

  // Cargar plan anual si existe
  const annualPlanFile = join(__dirname, `.annual_plan_${new Date().getFullYear()}.json`);
  let annualPlan = null;
  if (existsSync(annualPlanFile)) {
    try { annualPlan = JSON.parse(readFileSync(annualPlanFile, "utf8")); } catch {}
  }
  const currentPhase = getCurrentPhase(annualPlan);

  // Cargar actividades para métricas de adaptación
  let allCachedActivities = [];
  for (const y of [2025, 2024]) {
    const f = join(__dirname, `.activities_${y}.json`);
    if (existsSync(f)) {
      try { allCachedActivities = allCachedActivities.concat(JSON.parse(readFileSync(f, "utf8"))); } catch {}
    }
  }
  const recentActivities = allCachedActivities.slice(0, 30);
  const lastWeekLoad = getLastWeekLoad(recentActivities);
  const adaptation = allCachedActivities.length ? computeBodyAdaptation(allCachedActivities) : null;

  // Determinar tipo de sesión esperada según estructura semanal de la fase
  const dayMap = { 0:'sunday', 1:'monday', 2:'tuesday', 3:'wednesday', 4:'thursday', 5:'friday', 6:'saturday' };
  const expectedType = currentPhase?.weekStructure?.[dayMap[tomorrow.getDay()]] || null;

  const prompt = `Eres un entrenador de élite de running con visión de temporada completa y conocimiento profundo de fisiología deportiva. Genera el entrenamiento de MAÑANA (${tomorrowStr}, ${dayOfWeek}) para este atleta.

════════════════════════════════
PLAN ANUAL Y FASE ACTUAL
════════════════════════════════
${annualPlan ? `Objetivo anual: ${annualPlan.annualTarget || goal}
Fase actual: ${currentPhase?.name || "—"} (${currentPhase?.phase || "—"})
Meses de la fase: ${currentPhase?.startMonth}–${currentPhase?.endMonth}
Volumen semanal objetivo: ${currentPhase?.weeklyKmTarget || weeksData?.avgWeeklyKm || 50} km/sem
Intensidad objetivo: ${currentPhase?.intensityPercent || 70}%
Tipo esperado mañana según estructura semanal: ${expectedType || "libre"}
Sesiones clave de la fase: ${(currentPhase?.keyWorkouts || []).join(", ")}`
: `Sin plan anual — objetivo: ${goal || "mejorar velocidad y rendimiento"}`}

════════════════════════════════
ESTADO DE ADAPTACIÓN CORPORAL
════════════════════════════════
${adaptation ? `CTL (fitness acumulado, 42d): ${adaptation.ctl} — ${adaptation.ctl > 60 ? "nivel alto" : adaptation.ctl > 40 ? "nivel medio" : "nivel bajo"}
ATL (fatiga reciente, 7d): ${adaptation.atl} — ${adaptation.atl > adaptation.ctl ? "por encima del fitness base" : "dentro del rango"}
TSB (forma actual): ${adaptation.tsb} → ESTADO: ${adaptation.formState.toUpperCase()}
Consejo de forma: ${adaptation.formAdvice}
${adaptation.overreachWarning ? "⚠️ SEÑAL DE SOBREENTRENAMIENTO DETECTADA — reducir carga obligatorio" : ""}

Tendencias de rendimiento:
- Ritmo últimas 4 semanas: ${adaptation.paceTrendDir || "sin datos"} ${adaptation.paceTrendPercent !== null ? `(${adaptation.paceTrendPercent > 0 ? "+" : ""}${adaptation.paceTrendPercent}%)` : ""}
- FC media últimas 2 semanas: ${adaptation.hrTrendDir || "sin datos"} ${adaptation.hrTrendBpm !== null ? `(${adaptation.hrTrendBpm > 0 ? "-" : "+"}${Math.abs(adaptation.hrTrendBpm)} bpm)` : ""}
- Adherencia al plan: ${adaptation.adherencePercent}%
- Volumen medio últimas 4 semanas: ${adaptation.avgKmPerWeekLast4w} km/sem`
: "Sin datos suficientes para calcular adaptación"}

════════════════════════════════
CARGA SEMANAL ACTUAL
════════════════════════════════
Semana ${weekOfYear} — últimos 7 días:
- Sesiones completadas: ${lastWeekLoad.sessions}
- Km acumulados: ${lastWeekLoad.totalKm} km (objetivo: ${currentPhase?.weeklyKmTarget || 50} km)
- FC media esta semana: ${lastWeekLoad.avgHr || weeksData?.avgHr || 155} bpm

Última sesión (${lastActivity?.date || todayStr}):
${lastActivity ? `- ${lastActivity.name} · ${lastActivity.distanceKm} km · ${lastActivity.avgPace || "—"} min/km · ${lastActivity.avgHr || "—"} bpm` : "Sin datos de última sesión"}

════════════════════════════════
INSTRUCCIONES DE GENERACIÓN
════════════════════════════════
Genera el entrenamiento de mañana considerando TODOS estos factores:
1. FASE DEL MACROCICLO: coherente con ${currentPhase?.phase || "general"} — no ir contra la periodización
2. ESTADO CORPORAL: TSB=${adaptation?.tsb ?? "?"} (${adaptation?.formState ?? "desconocido"}) — ${adaptation?.tsb !== undefined ? (adaptation.tsb < -10 ? "REDUCIR intensidad/volumen" : adaptation.tsb > 10 ? "APTO para sesión de calidad" : "mantener intensidad moderada") : "usar criterio estándar"}
3. ${adaptation?.overreachWarning ? "⚠️ SOBREENTRENAMIENTO: forzar descanso activo independientemente de la fase" : "Sin señales de sobreentrenamiento"}
4. ADHERENCIA ${adaptation?.adherencePercent ?? "?"}%: ${adaptation?.adherencePercent !== undefined ? (adaptation.adherencePercent < 70 ? "baja adherencia — simplificar sesión para aumentar consistencia" : "buena adherencia — mantener dificultad") : ""}
5. TENDENCIA: ${adaptation?.paceTrendDir === "mejorando" ? "rendimiento mejorando — puedes exigir más" : adaptation?.paceTrendDir === "empeorando" ? "rendimiento bajando — revisar carga, posible sobreentrenamiento" : "tendencia no disponible"}
6. FC TREND: ${adaptation?.hrTrendDir || "sin datos"} — ${adaptation?.hrTrendBpm !== null && adaptation?.hrTrendBpm > 2 ? "FC bajando = buena adaptación aeróbica" : adaptation?.hrTrendBpm !== null && adaptation?.hrTrendBpm < -2 ? "FC subiendo = posible fatiga crónica" : ""}

Responde SOLO con JSON válido (sin markdown):
{
  "type": "easy|tempo|interval|long|rest",
  "title": "Nombre corto",
  "objective": "Objetivo en 1 frase mencionando la fase y estado de forma",
  "description": "Calentamiento, núcleo y vuelta a la calma detallados",
  "targetDistance": "X.X km",
  "targetPace": "M:SS min/km",
  "targetHr": "XXX-XXX bpm",
  "duration": "XX",
  "phaseContext": "Por qué este entreno encaja con la fase Y el estado corporal actual",
  "adaptationNote": "Nota sobre cómo el estado corporal actual ha influido en esta elección",
  "keyMetrics": ["métrica 1", "métrica 2", "métrica 3"],
  "intervals": {
    "reps": 6,
    "distanceMeters": 1000,
    "paceFast": "4:55 min/km",
    "paceSlow": "5:10 min/km",
    "recoveryMeters": 400
  }
}
"duration" = minutos estimados como número. "intervals" con valores nulos si no aplica.`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = message.content.map(b => b.text||"").join("").trim()
      .replace(/^```json\s*/,"").replace(/```$/,"").trim();
    const plan = extractJSON(raw);

    // Enriquecer con contexto del macrociclo
    plan.phase = currentPhase?.phase || null;
    plan.phaseName = currentPhase?.name || null;
    plan.weekOfYear = weekOfYear;

    dailyPlan[tomorrowStr] = { ...plan, generatedAt: new Date().toISOString(), date: tomorrowStr };
    savePlan();

    // Subir a Garmin
    let garminWorkoutId = null;
    let garminError = null;
    try {
      garminWorkoutId = await uploadWorkoutToGarmin(plan, tomorrowStr);
      dailyPlan[tomorrowStr].garminWorkoutId = garminWorkoutId;
      savePlan();
    } catch (ge) {
      garminError = ge.message;
      console.warn("Garmin workout upload failed:", ge.message);
    }

    res.json({ ok: true, date: tomorrowStr, plan: dailyPlan[tomorrowStr], garminWorkoutId, garminError });
  } catch (err) {
    console.error("Plan generate error:", err.message);
    res.status(500).json({ error: "Error al generar el plan: " + err.message });
  }
});

// GET /debug/test-workout — sube un workout de prueba hardcoded y loguea todo
app.get("/debug/test-workout", async (req, res) => {
  if (!garminLoggedIn) return res.status(401).json({ error: "No autenticado" });

  // Basado en respuesta real de Garmin:
  // conditionTypeId=2 → time (segundos)
  // conditionTypeId=3 → distance (metros)
  const testPayload = {
    sportType: { sportTypeId: 1, sportTypeKey: "running" },
    workoutName: "TEST 8km HR v2",
    description: "Test workout distancia correcta",
    workoutSegments: [{
      segmentOrder: 1,
      sportType: { sportTypeId: 1, sportTypeKey: "running" },
      workoutSteps: [{
        type: "ExecutableStepDTO",
        stepId: null,
        stepOrder: 1,
        stepType: { stepTypeId: 3, stepTypeKey: "interval" },
        description: "8km por FC",
        durationType: { durationTypeId: 3, durationTypeKey: "distance" },
        endCondition: { conditionTypeId: 3, conditionTypeKey: "distance" },
        endConditionValue: 8000,
        preferredEndConditionUnit: { unitId: 2, unitKey: "kilometer", factor: 100000 },
        targetType: { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone" },
        targetValueOne: 140,
        targetValueTwo: 155,
      }],
    }],
  };

  console.log("TEST PAYLOAD v2:", JSON.stringify(testPayload, null, 2));
  try {
    const result = await garmin.addWorkout(testPayload);
    console.log("GARMIN RESPONSE v2:", JSON.stringify(result, null, 2));
    res.json({ ok: true, result });
  } catch (err) {
    console.error("TEST ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /debug/methods — lista todos los métodos del cliente Garmin
app.get("/debug/methods", (_req, res) => {
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(garmin))
    .filter(m => m !== "constructor")
    .sort();
  res.json({ methods });
});

// GET /debug/workouts — lista workouts existentes para inspeccionar formato
app.get("/debug/workouts", async (req, res) => {
  if (!garminLoggedIn) return res.status(401).json({ error: "No autenticado" });
  try {
    const workouts = await garmin.getWorkouts(0, 5);
    res.json(workouts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /debug/workout/:id — detalle completo de un workout via API directa
app.get("/debug/workout/:id", async (req, res) => {
  if (!garminLoggedIn) return res.status(401).json({ error: "No autenticado" });
  try {
    const data = await garmin.get(`/workout-service/workout/${req.params.id}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /plan/upload-garmin — sube un plan existente a Garmin
app.post("/plan/upload-garmin", async (req, res) => {
  const { plan, date } = req.body;
  if (!plan) return res.status(400).json({ error: "Plan requerido" });
  try {
    const garminWorkoutId = await uploadWorkoutToGarmin(plan, date);
    res.json({ ok: true, garminWorkoutId });
  } catch (err) {
    console.error("Upload garmin error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /plan/analyze — analiza sesión realizada vs objetivo y genera descripción para Strava
app.post("/plan/analyze", async (req, res) => {
  const { plannedSession, actualActivity } = req.body;

  const prompt = `Eres un entrenador de élite de running. Analiza la sesión realizada comparándola con el objetivo planificado y genera una descripción para Strava.

OBJETIVO PLANIFICADO:
- Tipo: ${plannedSession?.type || "—"}
- Objetivo: ${plannedSession?.objective || "—"}
- Descripción: ${plannedSession?.description || "—"}
- Distancia objetivo: ${plannedSession?.targetDistance || "—"}
- Ritmo objetivo: ${plannedSession?.targetPace || "—"}
- FC objetivo: ${plannedSession?.targetHr || "—"}

SESIÓN REALIZADA (datos de Garmin):
- Actividad: ${actualActivity?.name || "—"}
- Distancia: ${actualActivity?.distanceKm || "—"} km
- Tiempo: ${actualActivity?.durationFormatted || "—"}
- FC media: ${actualActivity?.avgHr || "—"} bpm
- FC máxima: ${actualActivity?.maxHr || "—"} bpm
- Ritmo medio: ${actualActivity?.avgPace || "—"} min/km
- Cadencia media: ${actualActivity?.avgCadence || "—"} spm
- Desnivel: ${actualActivity?.elevationGain || 0} m
- Calorías: ${actualActivity?.calories || "—"}

Genera una descripción para Strava que incluya:
1. Resumen del objetivo del día
2. Análisis de lo realizado vs lo planificado (con números concretos)
3. Puntos destacados de la sesión
4. Una conclusión con aprendizaje para la próxima sesión

Tono: técnico pero personal, como un entrenador hablando con su atleta. Máximo 300 palabras. En español.`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    const description = message.content.map(b => b.text||"").join("").trim();
    const FIRMA = "\n\n— IntKM";
    res.json({ ok: true, description: description + FIRMA });
  } catch (err) {
    console.error("Analyze error:", err.message);
    res.status(500).json({ error: "Error al analizar la sesión: " + err.message });
  }
});

// ── Config API key en caliente
app.post("/config/apikey", (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: "API key requerida" });
  anthropic.apiKey = apiKey;
  process.env.ANTHROPIC_API_KEY = apiKey;
  res.json({ ok: true });
});

// ── Servir frontend ───────────────────────────────────────────────────────────
app.get("/app", (_req, res) => {
  try {
    const html = readFileSync(join(__dirname, "training-app.html"), "utf8");
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch {
    res.status(404).send("No se encontró training-app.html");
  }
});

// ── Arrancar ──────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✓ Training Analyzer server running on port ${PORT}`);
  console.log(`  Health: http://localhost:${PORT}/health`);
  console.log(`  App:    http://localhost:${PORT}/app`);
});

// ── Arrancar ──────────────�