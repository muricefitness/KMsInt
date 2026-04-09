/**
 * Training Analyzer Backend — Multi-User Edition (feature/multi-user)
 *
 * Cambios vs main:
 * - Supabase Auth: JWT middleware en todos los endpoints protegidos
 * - Estado por usuario: Maps de userId -> { garminClient, stravaToken, corosClient, dailyPlan }
 * - Tokens persistidos en Supabase (garmin_sessions, strava_tokens, coros_tokens)
 * - Planes persistidos en Supabase (daily_plans, annual_plans)
 * - Rol coach/athlete: coaches pueden ver datos de sus atletas
 *
 * Variables de entorno adicionales:
 *   SUPABASE_URL             https://xxxxxxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  (en Railway Variables — NUNCA en frontend)
 */

import express from "express";
import cors from "cors";
import _garminPkg from "@gooin/garmin-connect";
const { GarminConnect } = _garminPkg;
import * as _corosPkg from "coros-connect";
const CorosConnect = _corosPkg.CorosConnect || _corosPkg.default || _corosPkg;
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// ── Supabase admin client (server-side only) ──────────────────────────────────
const SUPABASE_URL              = process.env.SUPABASE_URL             || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const MULTI_USER = !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
console.log(`Modo: ${MULTI_USER ? "multi-usuario (Supabase)" : "single-user (fallback)"}`);

// ── Strava config ─────────────────────────────────────────────────────────────
const STRAVA_CLIENT_ID     = process.env.STRAVA_CLIENT_ID     || "222061";
const _envSecret           = process.env.STRAVA_CLIENT_SECRET;
const STRAVA_CLIENT_SECRET = (_envSecret && _envSecret.length === 40 && !_envSecret.includes('_de_'))
  ? _envSecret
  : "13ea8e309ac7617a256dc2874eafa3d2f1b67ec3";
const STRAVA_REDIRECT      = process.env.STRAVA_REDIRECT_URL || `http://localhost:${PORT}/strava/callback`;

// ── Estado por usuario ────────────────────────────────────────────────────────
const garminClients = new Map();   // userId -> { client: GarminConnect, loggedIn: bool }
const stravaTokens  = new Map();   // userId -> token object
const corosClients  = new Map();   // userId -> { client: CorosConnect, loggedIn: bool }
const dailyPlans    = new Map();   // userId -> { [dateStr]: plan }
const annualPlans   = new Map();   // userId -> { [year]: plan }

// ── Fallback single-user (cuando no hay Supabase configurado) ─────────────────
const STRAVA_TOKEN_FILE   = join(__dirname, ".strava_token.json");
const GARMIN_SESSION_FILE = join(__dirname, ".garmin_session.json");
const COROS_TOKEN_FILE    = join(__dirname, ".coros_token.json");
const PLAN_FILE           = join(__dirname, ".daily_plan.json");
const SINGLE_USER_ID      = "single-user";

if (!MULTI_USER) {
  // Cargar estado single-user al arrancar (mismo que main branch)
  let st = null;
  if (process.env.STRAVA_TOKEN_JSON) {
    try { st = JSON.parse(process.env.STRAVA_TOKEN_JSON); } catch {}
  } else if (existsSync(STRAVA_TOKEN_FILE)) {
    try { st = JSON.parse(readFileSync(STRAVA_TOKEN_FILE, "utf8")); } catch {}
  }
  if (st) stravaTokens.set(SINGLE_USER_ID, st);

  // Garmin
  const gc = { client: new GarminConnect({ username: "p", password: "p" }), loggedIn: false };
  garminClients.set(SINGLE_USER_ID, gc);
  (async () => {
    let saved = null;
    if (process.env.GARMIN_SESSION_JSON) { try { saved = JSON.parse(process.env.GARMIN_SESSION_JSON); } catch {} }
    if (!saved && existsSync(GARMIN_SESSION_FILE)) { try { saved = JSON.parse(readFileSync(GARMIN_SESSION_FILE, "utf8")); } catch {} }
    if (saved) {
      try {
        if (saved.oauth1Token) gc.client.client.oauth1Token = saved.oauth1Token;
        if (saved.oauth2Token) gc.client.client.oauth2Token = saved.oauth2Token;
        await gc.client.getUserProfile();
        gc.loggedIn = true;
        console.log("Sesion Garmin single-user restaurada");
      } catch { console.log("Sesion Garmin expirada"); }
    }
  })();

  // COROS
  const cc = { client: new CorosConnect(), loggedIn: false };
  corosClients.set(SINGLE_USER_ID, cc);

  // Daily plan
  if (existsSync(PLAN_FILE)) {
    try { dailyPlans.set(SINGLE_USER_ID, JSON.parse(readFileSync(PLAN_FILE, "utf8"))); } catch {}
  }
}

// ── Helpers de estado ─────────────────────────────────────────────────────────
function getUserId(req) {
  return MULTI_USER ? req.user?.id : SINGLE_USER_ID;
}
function getGarmin(userId) {
  if (!garminClients.has(userId)) {
    garminClients.set(userId, { client: new GarminConnect({ username: "p", password: "p" }), loggedIn: false });
  }
  return garminClients.get(userId);
}
function getCoros(userId) {
  if (!corosClients.has(userId)) {
    corosClients.set(userId, { client: new CorosConnect(), loggedIn: false });
  }
  return corosClients.get(userId);
}
function getDailyPlan(userId) {
  if (!dailyPlans.has(userId)) dailyPlans.set(userId, {});
  return dailyPlans.get(userId);
}

// ── Anthropic ─────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "" });

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cors({ origin: (o, cb) => cb(null, true), credentials: true }));

// JWT middleware — solo activo en modo multi-usuario
async function verifyUser(req, res, next) {
  if (!MULTI_USER) { req.user = { id: SINGLE_USER_ID }; return next(); }
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token de autenticacion requerido" });
  }
  const token = authHeader.split("Bearer ")[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Token invalido o expirado" });
  req.user = user;
  next();
}

// ── Persistencia Supabase ─────────────────────────────────────────────────────
async function saveGarminSession(userId) {
  const gc = getGarmin(userId);
  const sessionData = {
    oauth1Token: gc.client.client?.oauth1Token,
    oauth2Token: gc.client.client?.oauth2Token,
    savedAt: new Date().toISOString(),
  };
  if (!MULTI_USER) {
    writeFileSync(GARMIN_SESSION_FILE, JSON.stringify(sessionData, null, 2));
    return;
  }
  await supabase.from("garmin_sessions").upsert({ user_id: userId, session_data: sessionData, updated_at: new Date().toISOString() });
}

async function loadGarminSession(userId) {
  if (!MULTI_USER) return;
  const { data } = await supabase.from("garmin_sessions").select("session_data").eq("user_id", userId).single();
  if (!data?.session_data) return;
  const gc = getGarmin(userId);
  const saved = data.session_data;
  try {
    if (saved.oauth1Token) gc.client.client.oauth1Token = saved.oauth1Token;
    if (saved.oauth2Token) gc.client.client.oauth2Token = saved.oauth2Token;
    await gc.client.getUserProfile();
    gc.loggedIn = true;
    console.log(`Sesion Garmin restaurada para ${userId}`);
  } catch { gc.loggedIn = false; }
}

async function saveStravaToken(userId, token) {
  stravaTokens.set(userId, token);
  if (!MULTI_USER) {
    writeFileSync(STRAVA_TOKEN_FILE, JSON.stringify(token, null, 2));
    return;
  }
  await supabase.from("strava_tokens").upsert({ user_id: userId, token_data: token, updated_at: new Date().toISOString() });
}

async function loadStravaToken(userId) {
  if (!MULTI_USER) return stravaTokens.get(userId) || null;
  if (stravaTokens.has(userId)) return stravaTokens.get(userId);
  const { data } = await supabase.from("strava_tokens").select("token_data").eq("user_id", userId).single();
  if (data?.token_data) stravaTokens.set(userId, data.token_data);
  return data?.token_data || null;
}

async function saveCorosSession(userId) {
  const cc = getCoros(userId);
  const tokenData = cc.client.getToken ? cc.client.getToken() : (cc.client.token || {});
  const payload = { ...tokenData, savedAt: new Date().toISOString() };
  if (!MULTI_USER) { writeFileSync(COROS_TOKEN_FILE, JSON.stringify(payload, null, 2)); return; }
  await supabase.from("coros_tokens").upsert({ user_id: userId, token_data: payload, updated_at: new Date().toISOString() });
}

async function saveDailyPlanToDB(userId, dateStr, plan) {
  const userPlans = getDailyPlan(userId);
  userPlans[dateStr] = plan;
  if (!MULTI_USER) {
    writeFileSync(PLAN_FILE, JSON.stringify(userPlans, null, 2));
    return;
  }
  await supabase.from("daily_plans").upsert({ user_id: userId, plan_date: dateStr, plan_data: plan });
}

async function saveAnnualPlanToDB(userId, year, plan) {
  if (!annualPlans.has(userId)) annualPlans.set(userId, {});
  annualPlans.get(userId)[year] = plan;
  if (!MULTI_USER) {
    writeFileSync(join(__dirname, `.annual_plan_${year}.json`), JSON.stringify(plan, null, 2));
    return;
  }
  await supabase.from("annual_plans").upsert({ user_id: userId, year, plan_data: plan });
}

async function getAnnualPlan(userId, year) {
  const cached = annualPlans.get(userId)?.[year];
  if (cached) return cached;
  if (!MULTI_USER) {
    const f = join(__dirname, `.annual_plan_${year}.json`);
    if (existsSync(f)) { try { return JSON.parse(readFileSync(f, "utf8")); } catch {} }
    return null;
  }
  const { data } = await supabase.from("annual_plans").select("plan_data").eq("user_id", userId).eq("year", year).single();
  return data?.plan_data || null;
}

// ── Helpers de formato ────────────────────────────────────────────────────────
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

async function refreshStravaToken(userId) {
  const token = await loadStravaToken(userId);
  if (!token) return null;
  if (token.expires_at * 1000 > Date.now()) return token;
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
    }),
  });
  const newToken = await r.json();
  await saveStravaToken(userId, newToken);
  return newToken;
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", multiUser: MULTI_USER, supabaseUrl: SUPABASE_URL || null, time: new Date().toISOString() });
});

// ── Auth: info del usuario actual ─────────────────────────────────────────────
app.get("/me", verifyUser, async (req, res) => {
  const userId = getUserId(req);
  if (!MULTI_USER) return res.json({ id: SINGLE_USER_ID, role: "athlete", display_name: "Usuario" });
  const { data } = await supabase.from("profiles").select("*").eq("id", userId).single();
  res.json(data || { id: userId });
});

// ── Equipos (coach endpoints) ─────────────────────────────────────────────────
app.get("/teams", verifyUser, async (req, res) => {
  if (!MULTI_USER) return res.json({ teams: [] });
  const userId = getUserId(req);
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", userId).single();
  if (profile?.role === "coach") {
    const { data } = await supabase.from("teams").select("*, team_members(athlete_id, profiles(display_name, id))").eq("coach_id", userId);
    return res.json({ teams: data || [] });
  }
  // Atleta: ver sus equipos
  const { data } = await supabase.from("team_members")
    .select("teams(id, name, coach_id, profiles!teams_coach_id_fkey(display_name))")
    .eq("athlete_id", userId);
  res.json({ teams: (data || []).map(d => d.teams).filter(Boolean) });
});

app.post("/teams", verifyUser, async (req, res) => {
  if (!MULTI_USER) return res.status(400).json({ error: "Modo multi-usuario no configurado" });
  const userId = getUserId(req);
  const { name } = req.body;
  const { data, error } = await supabase.from("teams").insert({ name, coach_id: userId }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true, team: data });
});

app.post("/teams/:teamId/members", verifyUser, async (req, res) => {
  if (!MULTI_USER) return res.status(400).json({ error: "Modo multi-usuario no configurado" });
  const { athleteId } = req.body;
  const { error } = await supabase.from("team_members").insert({ team_id: req.params.teamId, athlete_id: athleteId });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// GET /teams/:teamId/athletes/:athleteId/plan/annual — coach ve plan de su atleta
app.get("/teams/:teamId/athletes/:athleteId/plan/annual", verifyUser, async (req, res) => {
  if (!MULTI_USER) return res.status(400).json({ error: "Solo disponible en modo multi-usuario" });
  const { athleteId } = req.params;
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const plan = await getAnnualPlan(athleteId, year);
  if (!plan) return res.status(404).json({ error: "Sin plan anual para este atleta" });
  res.json(plan);
});

// POST /teams/:teamId/athletes/:athleteId/plan/annual — coach asigna plan a atleta
app.post("/teams/:teamId/athletes/:athleteId/plan/annual", verifyUser, async (req, res) => {
  if (!MULTI_USER) return res.status(400).json({ error: "Solo disponible en modo multi-usuario" });
  const { athleteId } = req.params;
  const { plan, year } = req.body;
  await saveAnnualPlanToDB(athleteId, year || new Date().getFullYear(), plan);
  res.json({ ok: true });
});

// ── Garmin auth ───────────────────────────────────────────────────────────────
app.post("/auth/login", verifyUser, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email y contrasena requeridos" });
  const userId = getUserId(req);
  const gc = getGarmin(userId);
  try {
    await gc.client.login(email, password);
    gc.loggedIn = true;
    await saveGarminSession(userId);
    let displayName = email;
    try { const p = await gc.client.getUserProfile(); displayName = p?.displayName || p?.userName || email; } catch {}
    res.json({ ok: true, displayName });
  } catch (err) {
    console.error("Garmin login error:", err.message);
    const hasTokens = gc.client.client?.oauth1Token || gc.client.client?.oauth2Token;
    if (hasTokens) {
      gc.loggedIn = true;
      await saveGarminSession(userId);
      return res.json({ ok: true, displayName: email });
    }
    gc.loggedIn = false;
    let msg = err.message || "Error desconocido";
    if (msg.toLowerCase().includes("429")) msg = "Demasiados intentos. Espera 30 minutos.";
    else if (msg.toLowerCase().includes("invalid")) msg = "Credenciales incorrectas";
    res.status(401).json({ error: msg, raw: err.message });
  }
});

app.get("/auth/status", verifyUser, async (req, res) => {
  const userId = getUserId(req);
  const gc = getGarmin(userId);
  if (!gc.loggedIn) await loadGarminSession(userId);
  res.json({ loggedIn: getGarmin(userId).loggedIn });
});

app.post("/auth/logout", verifyUser, (req, res) => {
  const userId = getUserId(req);
  if (garminClients.has(userId)) garminClients.get(userId).loggedIn = false;
  res.json({ ok: true });
});

app.get("/garmin/session-export", verifyUser, (req, res) => {
  const userId = getUserId(req);
  const gc = getGarmin(userId);
  if (!gc.loggedIn) return res.status(404).json({ error: "No hay sesion de Garmin activa" });
  const sessionData = { oauth1Token: gc.client.client?.oauth1Token, oauth2Token: gc.client.client?.oauth2Token, savedAt: new Date().toISOString() };
  res.json({ GARMIN_SESSION_JSON: JSON.stringify(sessionData) });
});

// ── COROS auth ────────────────────────────────────────────────────────────────
app.post("/coros/login", verifyUser, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email y contrasena requeridos" });
  const userId = getUserId(req);
  const cc = getCoros(userId);
  try {
    await cc.client.login(email, password);
    cc.loggedIn = true;
    await saveCorosSession(userId);
    res.json({ ok: true, displayName: email });
  } catch (err) {
    cc.loggedIn = false;
    res.status(401).json({ error: err.message || "Error de autenticacion con COROS" });
  }
});

app.get("/coros/status", verifyUser, (req, res) => {
  const userId = getUserId(req);
  res.json({ loggedIn: getCoros(userId).loggedIn });
});

app.post("/coros/logout", verifyUser, (req, res) => {
  const userId = getUserId(req);
  if (corosClients.has(userId)) corosClients.get(userId).loggedIn = false;
  res.json({ ok: true });
});

app.get("/coros/activities", verifyUser, async (req, res) => {
  const userId = getUserId(req);
  const cc = getCoros(userId);
  if (!cc.loggedIn) return res.status(401).json({ error: "No autenticado en COROS" });
  try {
    const limit = parseInt(req.query.limit) || 10;
    const data = await cc.client.getActivityList({ size: limit, pageNumber: 1 });
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

app.get("/coros/session-export", verifyUser, (req, res) => {
  const userId = getUserId(req);
  const cc = getCoros(userId);
  if (!cc.loggedIn) return res.status(404).json({ error: "No hay sesion de COROS activa" });
  const tokenData = cc.client.getToken ? cc.client.getToken() : (cc.client.token || {});
  res.json({ COROS_TOKEN_JSON: JSON.stringify({ ...tokenData, savedAt: new Date().toISOString() }) });
});

// ── Strava OAuth ──────────────────────────────────────────────────────────────
// state param lleva el userId para vincularlo tras el callback
app.get("/strava/auth", verifyUser, (req, res) => {
  const userId = getUserId(req);
  const state = encodeURIComponent(userId);
  const url = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(STRAVA_REDIRECT)}&response_type=code&scope=activity:read_all,activity:write&state=${state}`;
  res.redirect(url);
});

app.get("/strava/callback", async (req, res) => {
  const { code, error, state } = req.query;
  const userId = state ? decodeURIComponent(state) : SINGLE_USER_ID;
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
    await saveStravaToken(userId, tokenData);
    const name = tokenData.athlete?.firstname || "atleta";
    res.send(`<script>window.opener.postMessage({stravaOk:true, name:'${name}'}, '*'); window.close();</script>`);
  } catch (err) {
    res.send(`<script>window.opener.postMessage({stravaError:'${err.message}'}, '*'); window.close();</script>`);
  }
});

app.get("/strava/status", verifyUser, async (req, res) => {
  const userId = getUserId(req);
  const token = await loadStravaToken(userId);
  res.json({ connected: !!token, athlete: token?.athlete || null });
});

app.get("/strava/token-export", verifyUser, async (req, res) => {
  const userId = getUserId(req);
  const token = await loadStravaToken(userId);
  if (!token) return res.status(404).json({ error: "No hay token de Strava" });
  res.json({ STRAVA_TOKEN_JSON: JSON.stringify(token) });
});

app.get("/strava/debug", (req, res) => {
  res.json({
    client_id: STRAVA_CLIENT_ID,
    client_secret_length: STRAVA_CLIENT_SECRET?.length,
    client_secret_preview: STRAVA_CLIENT_SECRET ? STRAVA_CLIENT_SECRET.slice(0,4) + "..." + STRAVA_CLIENT_SECRET.slice(-4) : null,
    redirect_url: STRAVA_REDIRECT,
    multiUser: MULTI_USER,
  });
});

app.get("/strava/activities", verifyUser, async (req, res) => {
  const userId = getUserId(req);
  const token = await refreshStravaToken(userId);
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
      id: a.id, name: a.name, type: a.type,
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

app.put("/strava/activity/:id/description", verifyUser, async (req, res) => {
  const userId = getUserId(req);
  const token = await refreshStravaToken(userId);
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

// ── Actividades Garmin ────────────────────────────────────────────────────────
app.get("/activities", verifyUser, async (req, res) => {
  const userId = getUserId(req);
  const gc = getGarmin(userId);
  if (!gc.loggedIn) return res.status(401).json({ error: "No autenticado en Garmin" });
  const limit = parseInt(req.query.limit) || 20;
  const start = parseInt(req.query.start) || 0;
  try {
    const raw = await gc.client.getActivities(start, limit);
    res.json({ activities: (Array.isArray(raw) ? raw : []).map(normalizeActivity) });
  } catch (err) {
    res.status(500).json({ error: "No se pudieron obtener actividades: " + err.message });
  }
});

app.get("/activities/year", verifyUser, async (req, res) => {
  const userId = getUserId(req);
  const gc = getGarmin(userId);
  if (!gc.loggedIn) return res.status(401).json({ error: "No autenticado" });
  const year = parseInt(req.query.year) || new Date().getFullYear() - 1;
  const since = new Date(`${year}-01-01T00:00:00`);
  const until = new Date(`${year}-12-31T23:59:59`);
  const all = []; let start = 0; const batchSize = 100; let keepGoing = true;
  try {
    while (keepGoing) {
      const batch = await gc.client.getActivities(start, batchSize);
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
    // Cachear en Supabase o disco
    if (MULTI_USER) {
      await supabase.from("annual_plans").upsert({
        user_id: userId, year,
        plan_data: { activities: all, type: "activities_cache", count: all.length }
      });
    } else {
      writeFileSync(join(__dirname, `.activities_${year}.json`), JSON.stringify(all, null, 2));
    }
    res.json({ year, count: all.length, activities: all });
  } catch (err) {
    res.status(500).json({ error: err.message, partial: all });
  }
});

app.get("/activities/year/cache", verifyUser, async (req, res) => {
  const userId = getUserId(req);
  const year = parseInt(req.query.year) || new Date().getFullYear() - 1;
  if (!MULTI_USER) {
    const cacheFile = join(__dirname, `.activities_${year}.json`);
    if (!existsSync(cacheFile)) return res.status(404).json({ error: `Sin cache para ${year}` });
    try { return res.json({ year, activities: JSON.parse(readFileSync(cacheFile, "utf8")) }); } catch (err) { return res.status(500).json({ error: err.message }); }
  }
  // Multi-user: leer de Supabase (almacenado como annual_plans con type activities_cache)
  const { data } = await supabase.from("annual_plans").select("plan_data").eq("user_id", userId).eq("year", year).single();
  if (!data?.plan_data?.activities) return res.status(404).json({ error: `Sin cache para ${year}` });
  res.json({ year, count: data.plan_data.activities.length, activities: data.plan_data.activities });
});

// ── Helpers computeActivityMetrics ────────────────────────────────────────────
function computeActivityMetrics(act, laps, hrStream) {
  const metrics = {};
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
    metrics.splits = lapList.map((l, i) => ({ lap: i + 1, distanceKm: l.distance ? (l.distance/1000).toFixed(2) : null, pace: l.averageSpeed ? speedToPace(l.averageSpeed) : null, avgHr: l.averageHR ? Math.round(l.averageHR) : null, maxHr: l.maxHR ? Math.round(l.maxHR) : null, cadence: l.averageRunningCadenceInStepsPerMinute || null, elevGain: l.elevationGain ? Math.round(l.elevationGain) : null }));
    const firstPaces = lapList.slice(0, mid).filter(l => l.averageSpeed).map(l => l.averageSpeed);
    const secondPaces = lapList.slice(mid).filter(l => l.averageSpeed).map(l => l.averageSpeed);
    if (firstPaces.length && secondPaces.length) {
      const ap1 = firstPaces.reduce((s,v)=>s+v,0)/firstPaces.length, ap2 = secondPaces.reduce((s,v)=>s+v,0)/secondPaces.length;
      metrics.paceDriftSeconds = parseFloat((1000/ap2 - 1000/ap1).toFixed(1));
      metrics.paceDriftPercent = parseFloat(((1000/ap2 - 1000/ap1) / (1000/ap1) * 100).toFixed(1));
    }
  }
  if (act.averageHR && act.duration) {
    const fcMax = act.maxHR || 186, fcRest = 50;
    const fcRatio = (act.averageHR - fcRest) / (fcMax - fcRest);
    const durationMin = act.duration / 60;
    const trimp = Math.round(durationMin * fcRatio * 0.64 * Math.exp(1.92 * fcRatio));
    metrics.trimp = trimp;
    metrics.loadCategory = trimp < 50 ? "baja" : trimp < 100 ? "moderada" : trimp < 150 ? "alta" : "muy alta";
  }
  if (act.averageSpeed && act.averageHR) metrics.aerobicEfficiency = parseFloat(((1000/act.averageSpeed)/act.averageHR).toFixed(3));
  if (metrics.hrDriftPercent !== undefined && metrics.paceDriftPercent !== undefined) {
    metrics.aerobicDecoupling = parseFloat((metrics.hrDriftPercent - metrics.paceDriftPercent).toFixed(1));
    metrics.decouplingQuality = metrics.aerobicDecoupling < 5 ? "bueno" : metrics.aerobicDecoupling < 10 ? "aceptable" : "mejorable";
  }
  if (laps && Array.isArray(laps.lapDTOs)) {
    const fcMax = act.maxHR || 186;
    const zones = { z1:0, z2:0, z3:0, z4:0, z5:0 };
    laps.lapDTOs.forEach(l => {
      if (!l.averageHR || !l.duration) return;
      const pct = l.averageHR / fcMax, t = l.duration / 60;
      if (pct < .60) zones.z1 += t; else if (pct < .70) zones.z2 += t; else if (pct < .80) zones.z3 += t; else if (pct < .90) zones.z4 += t; else zones.z5 += t;
    });
    const total = Object.values(zones).reduce((s,v)=>s+v,0) || 1;
    metrics.hrZones = Object.fromEntries(Object.entries(zones).map(([k,v]) => [k, parseFloat((v/total*100).toFixed(1))]));
  }
  return metrics;
}

app.get("/activity/:id", verifyUser, async (req, res) => {
  const userId = getUserId(req);
  const gc = getGarmin(userId);
  if (!gc.loggedIn) return res.status(401).json({ error: "No autenticado en Garmin" });
  const id = req.params.id;
  try {
    const [detail, splits] = await Promise.allSettled([
      gc.client.getActivity({ activityId: id }),
      gc.client.getActivitySplits({ activityId: id }).catch(() => null),
    ]);
    const act = detail.status === "fulfilled" ? detail.value : {};
    const laps = splits.status === "fulfilled" ? splits.value : null;
    const metrics = computeActivityMetrics(act, laps, null);
    res.json({ activity: act, laps, metrics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Plan diario ───────────────────────────────────────────────────────────────
app.get("/plan/today", verifyUser, async (req, res) => {
  const userId = getUserId(req);
  const today = new Date().toISOString().slice(0,10);
  if (!MULTI_USER) {
    const plan = getDailyPlan(userId)[today] || null;
    return res.json({ date: today, plan });
  }
  const { data } = await supabase.from("daily_plans").select("plan_data").eq("user_id", userId).eq("plan_date", today).single();
  res.json({ date: today, plan: data?.plan_data || null });
});

// ── Métricas adaptación + plan anual (misma lógica que main, adaptada a multi-user) ──
function calcTRIMP(activity) {
  if (!activity.avgHr || !activity.durationSeconds) return 0;
  const fcMax = activity.maxHr || 186, fcRest = 50;
  const fcRatio = Math.max(0, (activity.avgHr - fcRest) / (fcMax - fcRest));
  return Math.round((activity.durationSeconds/60) * fcRatio * 0.64 * Math.exp(1.92 * fcRatio));
}

function computeBodyAdaptation(activities) {
  if (!activities.length) return null;
  const sorted = [...activities].filter(a => a.dateRaw).sort((a, b) => new Date(a.dateRaw) - new Date(b.dateRaw));
  const trimpByDay = {};
  sorted.forEach(a => { const day = a.dateRaw.slice(0,10); trimpByDay[day] = (trimpByDay[day]||0) + calcTRIMP(a); });
  const kCTL = 1 - Math.exp(-1/42), kATL = 1 - Math.exp(-1/7);
  let ctl = 0, atl = 0;
  for (let d = new Date(sorted[0].dateRaw); d <= new Date(); d.setDate(d.getDate()+1)) {
    const key = d.toISOString().slice(0,10);
    ctl = ctl + kCTL * ((trimpByDay[key]||0) - ctl);
    atl = atl + kATL * ((trimpByDay[key]||0) - atl);
  }
  const tsb = ctl - atl;
  const now = Date.now();
  const last4w = sorted.filter(a => new Date(a.dateRaw) >= new Date(now - 28*86400000));
  const avgKmWeek = parseFloat((last4w.reduce((s,a) => s+parseFloat(a.distanceKm||0),0)/4).toFixed(1));
  let formState, formAdvice;
  if (tsb > 15)      { formState = "muy fresco";  formAdvice = "Forma optima"; }
  else if (tsb > 5)  { formState = "fresco";       formAdvice = "Buena forma"; }
  else if (tsb > -5) { formState = "equilibrado";  formAdvice = "Forma neutral"; }
  else if (tsb > -15){ formState = "cargado";      formAdvice = "Reducir intensidad"; }
  else               { formState = "fatigado";      formAdvice = "Descanso activo obligatorio"; }
  const weeksInPlan = Math.max(1, Math.ceil((now - new Date(sorted[0].dateRaw).getTime())/(7*86400000)));
  return { ctl: Math.round(ctl), atl: Math.round(atl), tsb: Math.round(tsb), formState, formAdvice, overreachWarning: tsb < -20, avgKmPerWeekLast4w: avgKmWeek, totalActivitiesAnalyzed: sorted.length, adherencePercent: Math.min(100, Math.round((sorted.length/(weeksInPlan*4))*100)) };
}

async function getUserActivities(userId) {
  if (!MULTI_USER) {
    let all = [];
    for (const y of [new Date().getFullYear(), new Date().getFullYear()-1]) {
      const f = join(__dirname, `.activities_${y}.json`);
      if (existsSync(f)) { try { all = all.concat(JSON.parse(readFileSync(f,"utf8"))); } catch {} }
    }
    return all;
  }
  // Multi-user: leer actividades cacheadas de annual_plans
  const { data } = await supabase.from("annual_plans").select("plan_data").eq("user_id", userId).in("year", [new Date().getFullYear(), new Date().getFullYear()-1]);
  if (!data) return [];
  return data.flatMap(d => d.plan_data?.activities || []);
}

app.get("/athlete/adaptation", verifyUser, async (req, res) => {
  try {
    const userId = getUserId(req);
    const activities = await getUserActivities(userId);
    if (!activities.length) return res.json({ error: "Sin datos de actividades" });
    res.json(computeBodyAdaptation(activities));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    if (!inStr) { if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) return JSON.parse(clean.slice(start,i+1)); } }
  }
  return JSON.parse(clean.slice(start));
}

app.post("/plan/annual", verifyUser, async (req, res) => {
  const { year, events } = req.body;
  const userId = getUserId(req);
  const dataYear = year || new Date().getFullYear() - 1;
  const activities = await getUserActivities(userId);
  const yearActivities = activities.filter(a => a.dateRaw && new Date(a.dateRaw).getFullYear() === dataYear);
  if (!yearActivities.length) return res.status(400).json({ error: `Sin datos de ${dataYear}. Descarga primero las actividades.` });

  const running = yearActivities.filter(a => ["running","trail_running","treadmill_running"].includes(a.type));
  const totalKm = running.reduce((s,a) => s+parseFloat(a.distanceKm||0),0);
  const totalHours = running.reduce((s,a) => s+(a.durationSeconds||0),0)/3600;
  const avgHr = running.filter(a=>a.avgHr).reduce((s,a,_,arr) => s+a.avgHr/arr.length,0);
  const monthly = {}; for (let m=1;m<=12;m++) monthly[m]=0;
  running.forEach(a => { if (!a.dateRaw) return; const m=new Date(a.dateRaw).getMonth()+1; monthly[m]+=parseFloat(a.distanceKm||0); });
  const weekly = {};
  running.forEach(a => { if (!a.dateRaw) return; const d=new Date(a.dateRaw); const ws=new Date(d); ws.setDate(d.getDate()-d.getDay()); const key=ws.toISOString().slice(0,10); weekly[key]=(weekly[key]||0)+parseFloat(a.distanceKm||0); });
  const weeklyVals = Object.values(weekly);
  const maxWeekKm = weeklyVals.length ? Math.max(...weeklyVals) : 0;

  const prompt = `Eres un entrenador de atletismo de élite. Genera un plan anual para ${new Date().getFullYear()} basado en historial ${dataYear}.

DATOS ${dataYear}: ${running.length} actividades, ${Math.round(totalKm)} km totales, ${totalHours.toFixed(1)} h, FC media ${Math.round(avgHr)} bpm, semana pico ${maxWeekKm.toFixed(1)} km
Volumen mensual: ${Object.entries(monthly).map(([m,km]) => `${['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][m-1]}:${Math.round(km)}`).join(' ')}
${events?.length ? `EVENTOS: ${events.map(e=>`${e.name}(${e.date})`).join(',')}` : ''}

Responde SOLO con JSON:
{"summary":"...","strengths":["..."],"weaknesses":["..."],"annualTarget":"...","peakWeekKm":0,"phases":[{"phase":"base|development|peak|recovery","name":"...","startMonth":1,"endMonth":3,"weeklyKmTarget":0,"intensityPercent":0,"description":"...","keyWorkouts":["..."],"weekStructure":{"monday":"rest|easy|tempo|interval|long","tuesday":"...","wednesday":"...","thursday":"...","friday":"...","saturday":"...","sunday":"..."}}]}`;

  try {
    const message = await anthropic.messages.create({ model: "claude-opus-4-5", max_tokens: 2000, messages: [{ role: "user", content: prompt }] });
    const annualPlan = extractJSON(message.content.map(b=>b.text||"").join("").trim());
    await saveAnnualPlanToDB(userId, new Date().getFullYear(), { ...annualPlan, generatedAt: new Date().toISOString(), basedOnYear: dataYear, events });
    res.json({ ok: true, plan: annualPlan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/plan/annual", verifyUser, async (req, res) => {
  const userId = getUserId(req);
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const plan = await getAnnualPlan(userId, year);
  if (!plan) return res.status(404).json({ error: "No hay plan anual generado" });
  res.json(plan);
});

function getCurrentPhase(annualPlan) {
  if (!annualPlan?.phases?.length) return null;
  const month = new Date().getMonth() + 1;
  return annualPlan.phases.find(p => month >= p.startMonth && month <= p.endMonth) || annualPlan.phases[0];
}
function getWeekOfYear(date) { const start = new Date(date.getFullYear(),0,1); return Math.ceil(((date-start)/86400000+start.getDay()+1)/7); }
function getLastWeekLoad(activities) {
  const weekAgo = new Date(Date.now()-7*86400000);
  const lastWeek = activities.filter(a => a.dateRaw && new Date(a.dateRaw) >= weekAgo);
  return { totalKm: lastWeek.reduce((s,a)=>s+parseFloat(a.distanceKm||0),0).toFixed(1), sessions: lastWeek.length, avgHr: lastWeek.filter(a=>a.avgHr).length ? Math.round(lastWeek.filter(a=>a.avgHr).reduce((s,a)=>s+a.avgHr,0)/lastWeek.filter(a=>a.avgHr).length) : null };
}

app.post("/plan/generate", verifyUser, async (req, res) => {
  const { lastActivity, goal } = req.body;
  const userId = getUserId(req);
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1);
  const tomorrowStr = tomorrow.toISOString().slice(0,10);
  const weekOfYear = getWeekOfYear(tomorrow);
  const dayOfWeek = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'][tomorrow.getDay()];

  const annualPlan = await getAnnualPlan(userId, new Date().getFullYear());
  const currentPhase = getCurrentPhase(annualPlan);
  const allActivities = await getUserActivities(userId);
  const adaptation = allActivities.length ? computeBodyAdaptation(allActivities) : null;
  const lastWeekLoad = getLastWeekLoad(allActivities.slice(0,30));
  const dayMap = { 0:'sunday',1:'monday',2:'tuesday',3:'wednesday',4:'thursday',5:'friday',6:'saturday' };
  const expectedType = currentPhase?.weekStructure?.[dayMap[tomorrow.getDay()]] || null;

  const prompt = `Eres un entrenador de élite de running. Genera el entrenamiento de manana (${tomorrowStr}, ${dayOfWeek}).
${annualPlan ? `Fase actual: ${currentPhase?.name||"—"} | Tipo esperado: ${expectedType||"libre"} | km/sem objetivo: ${currentPhase?.weeklyKmTarget||50}` : `Objetivo: ${goal||"mejorar rendimiento"}`}
${adaptation ? `CTL:${adaptation.ctl} ATL:${adaptation.atl} TSB:${adaptation.tsb} → ${adaptation.formState} (${adaptation.formAdvice})` : "Sin datos adaptacion"}
Ultima semana: ${lastWeekLoad.sessions} sesiones, ${lastWeekLoad.totalKm} km, FC ${lastWeekLoad.avgHr||"—"} bpm
Ultima actividad: ${lastActivity ? `${lastActivity.name} ${lastActivity.distanceKm}km ${lastActivity.avgPace||""}` : "sin datos"}

Responde SOLO con JSON:
{"type":"easy|tempo|interval|long|rest","title":"...","objective":"...","description":"...","targetDistance":"X.X km","targetPace":"M:SS min/km","targetHr":"XXX-XXX bpm","duration":"XX","phaseContext":"...","adaptationNote":"...","keyMetrics":["..."],"intervals":{"reps":6,"distanceMeters":1000,"paceFast":"4:55 min/km","paceSlow":"5:10 min/km","recoveryMeters":400}}`;

  try {
    const message = await anthropic.messages.create({ model: "claude-opus-4-5", max_tokens: 1500, messages: [{ role: "user", content: prompt }] });
    const plan = extractJSON(message.content.map(b=>b.text||"").join("").trim());
    plan.phase = currentPhase?.phase || null;
    plan.phaseName = currentPhase?.name || null;
    plan.weekOfYear = weekOfYear;
    const fullPlan = { ...plan, generatedAt: new Date().toISOString(), date: tomorrowStr };
    await saveDailyPlanToDB(userId, tomorrowStr, fullPlan);

    // Subir a Garmin si está conectado
    let garminWorkoutId = null, garminError = null;
    const gc = getGarmin(userId);
    if (gc.loggedIn) {
      try { garminWorkoutId = await uploadWorkoutToGarmin(gc.client, plan, tomorrowStr); } catch (ge) { garminError = ge.message; }
    }
    res.json({ ok: true, date: tomorrowStr, plan: fullPlan, garminWorkoutId, garminError });
  } catch (err) {
    res.status(500).json({ error: "Error al generar el plan: " + err.message });
  }
});

// ── Helpers Garmin Workout ────────────────────────────────────────────────────
function parseKm(str) { if (!str) return null; const n = parseFloat(String(str).replace(/[^0-9.]/g,"")); return isNaN(n) ? null : n; }
function paceToMps(pace) { if (!pace) return null; const clean = pace.replace(" min/km","").trim(); const [m,s] = clean.split(":").map(Number); if (isNaN(m)) return null; return parseFloat((1000/(m*60+(s||0))).toFixed(4)); }
function makeStep(type, description, durationType, durationValueMeters, targetType, targetFrom, targetTo, order) {
  const durationTypeId = durationType === "distance" ? 3 : 2;
  return { type:"ExecutableStepDTO", stepId:null, stepOrder:order, stepType:{stepTypeId:type==="warmup"?1:type==="cooldown"?2:type==="interval"?3:4,stepTypeKey:type}, description, durationType:{durationTypeId,durationTypeKey:durationType}, endCondition:{conditionTypeId:durationTypeId,conditionTypeKey:durationType}, endConditionValue:durationValueMeters, preferredEndConditionUnit:durationType==="distance"?{unitId:2,unitKey:"kilometer",factor:100000}:null, targetType:{workoutTargetTypeId:targetType==="pace"?6:targetType==="heart_rate"?4:1,workoutTargetTypeKey:targetType==="heart_rate"?"heart.rate.zone":targetType}, targetValueOne:targetFrom||null, targetValueTwo:targetTo||null };
}
function makeRepeatStep(repeatCount, steps, order) { return { type:"RepeatGroupDTO", stepId:null, stepOrder:order, stepType:{stepTypeId:6,stepTypeKey:"repeat"}, numberOfIterations:repeatCount, smartRepeat:false, workoutSteps:steps }; }
function buildGarminWorkout(plan) {
  const steps = []; let order = 1;
  const totalDistM = Math.round((parseKm(plan.targetDistance)||8)*1000);
  if (plan.type === "interval" && plan.intervals) {
    const ivs = plan.intervals;
    steps.push(makeStep("warmup","Calentamiento","distance",2000,"pace",paceToMps("6:30"),paceToMps("6:00"),order++));
    const iv = makeStep("interval",`Serie ${ivs.distanceMeters}m`,"distance",ivs.distanceMeters,"pace",paceToMps(ivs.paceSlow),paceToMps(ivs.paceFast),1);
    const rv = makeStep("recovery",`Rec ${ivs.recoveryMeters}m`,"distance",ivs.recoveryMeters,"pace",paceToMps("6:30"),paceToMps("7:30"),2);
    steps.push(makeRepeatStep(ivs.reps,[iv,rv],order++));
    steps.push(makeStep("cooldown","Vuelta calma","distance",1000,"pace",paceToMps("6:30"),paceToMps("7:00"),order++));
  } else if (plan.type === "tempo") {
    const tFast = paceToMps(plan.targetPace?.replace(" min/km","")), tSlow = tFast ? parseFloat((tFast*.95).toFixed(4)) : null;
    steps.push(makeStep("warmup","Calentamiento","distance",2000,"pace",paceToMps("6:30"),paceToMps("6:00"),order++));
    steps.push(makeStep("interval","Tramo tempo","distance",Math.round(totalDistM*.7),tFast?"pace":"no_target",tSlow,tFast,order++));
    steps.push(makeStep("cooldown","Vuelta calma","distance",1000,"pace",paceToMps("6:30"),paceToMps("7:00"),order++));
  } else {
    const hrParts = (plan.targetHr||"140-155").split("-").map(Number);
    steps.push(makeStep("interval",plan.title||"Carrera continua","distance",totalDistM,"heart_rate",hrParts[0]||140,hrParts[1]||155,order++));
  }
  return { sportType:{sportTypeId:1,sportTypeKey:"running"}, workoutName:plan.title||"Entrenamiento IA", description:plan.objective||"", estimatedDurationInSecs:Math.round((parseKm(plan.duration)||50)*60), estimatedDistanceInMeters:totalDistM, workoutSegments:[{segmentOrder:1,sportType:{sportTypeId:1,sportTypeKey:"running"},workoutSteps:steps}] };
}

async function uploadWorkoutToGarmin(garminClient, plan, dateStr) {
  const payload = buildGarminWorkout(plan);
  const created = await garminClient.addWorkout(payload);
  const workoutId = created?.workoutId;
  if (!workoutId) throw new Error("Garmin no devolvio workoutId");
  const dateClean = dateStr ? dateStr.slice(0,10) : new Date(Date.now()+86400000).toISOString().slice(0,10);
  const [y,m,d] = dateClean.split("-").map(Number);
  const dateObj = new Date(y,m-1,d,12,0,0);
  try { await garminClient.scheduleWorkout({workoutId},dateObj); } catch { await garminClient.scheduleWorkout({workoutId},dateClean); }
  return workoutId;
}

app.post("/plan/upload-garmin", verifyUser, async (req, res) => {
  const { plan, date } = req.body;
  const userId = getUserId(req);
  const gc = getGarmin(userId);
  if (!gc.loggedIn) return res.status(401).json({ error: "No autenticado en Garmin" });
  if (!plan) return res.status(400).json({ error: "Plan requerido" });
  try {
    const garminWorkoutId = await uploadWorkoutToGarmin(gc.client, plan, date);
    res.json({ ok: true, garminWorkoutId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/plan/analyze", verifyUser, async (req, res) => {
  const { plannedSession, actualActivity } = req.body;
  const prompt = `Eres un entrenador de élite de running. Analiza la sesion realizada vs objetivo y genera descripcion Strava.
OBJETIVO: tipo ${plannedSession?.type||"—"}, objetivo ${plannedSession?.objective||"—"}, distancia ${plannedSession?.targetDistance||"—"}, ritmo ${plannedSession?.targetPace||"—"}, FC ${plannedSession?.targetHr||"—"}
REALIZADO: ${actualActivity?.name||"—"}, ${actualActivity?.distanceKm||"—"}km, ${actualActivity?.durationFormatted||"—"}, FC ${actualActivity?.avgHr||"—"}bpm, ritmo ${actualActivity?.avgPace||"—"}min/km
Genera descripcion Strava (max 300 palabras, espanol, tono tecnico-personal). Termina con "— IntKM"`;
  try {
    const message = await anthropic.messages.create({ model: "claude-opus-4-5", max_tokens: 600, messages: [{ role: "user", content: prompt }] });
    res.json({ ok: true, description: message.content.map(b=>b.text||"").join("").trim() });
  } catch (err) {
    res.status(500).json({ error: "Error al analizar la sesion: " + err.message });
  }
});

app.post("/activity/:id/analyze-detail", verifyUser, async (req, res) => {
  const userId = getUserId(req);
  const gc = getGarmin(userId);
  if (!gc.loggedIn) return res.status(401).json({ error: "No autenticado" });
  const { plannedSession } = req.body;
  try {
    const [detail, splits] = await Promise.allSettled([gc.client.getActivity({activityId:req.params.id}), gc.client.getActivitySplits({activityId:req.params.id}).catch(()=>null)]);
    const act = detail.status==="fulfilled" ? detail.value : {};
    const laps = splits.status==="fulfilled" ? splits.value : null;
    const metrics = computeActivityMetrics(act,laps,null);
    const splitsText = metrics.splits?.length ? metrics.splits.map(s=>`Km ${s.lap}: ${s.pace} · ${s.avgHr}bpm`).join("\n") : "Sin splits";
    const prompt = `Analiza esta sesion de running en español (max 400 palabras, firma — IntKM):
Distancia:${act.distance?(act.distance/1000).toFixed(2):"—"}km, Tiempo:${fmtDuration(act.duration)}, FC:${act.averageHR?Math.round(act.averageHR):"—"}bpm, Ritmo:${act.averageSpeed?speedToPace(act.averageSpeed):"—"}, TRIMP:${metrics.trimp||"—"}, Decoupling:${metrics.aerobicDecoupling||"—"}%, Estado zonas:${metrics.hrZones?`Z1:${metrics.hrZones.z1}% Z2:${metrics.hrZones.z2}% Z3:${metrics.hrZones.z3}% Z4:${metrics.hrZones.z4}% Z5:${metrics.hrZones.z5}%`:"—"}
Splits:\n${splitsText}
${plannedSession?`Objetivo: ${plannedSession.type} ${plannedSession.targetDistance} ${plannedSession.targetPace}`:""}`;
    const message = await anthropic.messages.create({ model:"claude-opus-4-5", max_tokens:800, messages:[{role:"user",content:prompt}] });
    res.json({ ok:true, analysis:message.content.map(b=>b.text||"").join("").trim(), metrics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/config/apikey", verifyUser, (req, res) => {
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
    res.status(404).send("No se encontro training-app.html");
  }
});

// ── Arrancar ──────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Training Analyzer (multi-user) running on port ${PORT}`);
  console.log(`Supabase: ${MULTI_USER ? SUPABASE_URL : "no configurado (modo single-user)"}`);
});
