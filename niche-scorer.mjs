#!/usr/bin/env node
// niche-scorer v2 — pontua nichos de YouTube por demanda e oportunidade para canais pequenos.
//
// Uso:
//   YT_API_KEY=... node niche-scorer.mjs --config niches.json --locales en:US,en:GB
//   node niche-scorer.mjs --config niches.json --locales pt:BR --niches car_savings --pages 2 --format long
//   node niche-scorer.mjs --config niches.json --dry-run          (só estima a cota, não chama a API)
//
// Requer Node 18+ (fetch nativo). Sem dependências.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ===================== CLI =====================
function parseArgs(argv) {
  const args = {
    config: "niches.json",
    locales: null, // "en:US,pt:BR"
    niches: null, // "a,b"
    pages: 2,
    passes: "viewCount,date",
    format: "long", // long | shorts | all
    minLongSec: 480, // 8 min
    months: 12,
    out: "niche-report",
    cacheDir: ".yt-cache",
    cacheHours: 24,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--config": args.config = next(); break;
      case "--locales": args.locales = next(); break;
      case "--niches": args.niches = next(); break;
      case "--pages": args.pages = Number(next()); break;
      case "--passes": args.passes = next(); break;
      case "--format": args.format = next(); break;
      case "--min-long-sec": args.minLongSec = Number(next()); break;
      case "--months": args.months = Number(next()); break;
      case "--out": args.out = next(); break;
      case "--cache-dir": args.cacheDir = next(); break;
      case "--cache-hours": args.cacheHours = Number(next()); break;
      case "--dry-run": args.dryRun = true; break;
      case "-h": case "--help":
        console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 10).join("\n"));
        process.exit(0);
      default:
        console.error(`Argumento desconhecido: ${a}`);
        process.exit(1);
    }
  }
  return args;
}

const ARGS = parseArgs(process.argv);

// ===================== TUNING =====================
// Oportunidade: vídeo de canal pequeno performando acima do tamanho do canal.
const OPP = {
  minDaysAlive: 14, // precisa de tempo para ter sinal
  maxSubs: 50_000, // "canal pequeno"
  minVpd: 300, // views por dia mínimas
  minOutlierRatio: 1.0, // views >= inscritos
};
const NEW_CHANNEL_MAX_DAYS = 180; // canal "novo" = até 6 meses
const VPD_MIN_DAYS = 7; // vpd = views / max(dias, 7)

// Referências fixas (escala log) para o score ser comparável entre execuções.
const DEMAND_REF = { low: 100, high: 20_000 }; // vpd mediano: 100 -> 0 pts, 20k -> 100 pts
const RATIO_REF = { low: 1, high: 30 }; // razão views/inscritos mediana das oportunidades

const W_DEMAND = 0.4;
const W_OPP = 0.6;

// Fator de monetização (relativo, aproximado — ajuste com dados reais do seu AdSense).
// Por categoria do YouTube (snippet.categoryId):
const CATEGORY_RPM = {
  "2": 1.0, // Autos & Vehicles
  "27": 0.95, // Education
  "28": 1.0, // Science & Technology
  "26": 0.85, // Howto & Style
  "25": 0.8, // News & Politics
  "22": 0.7, // People & Blogs
  "19": 0.75, // Travel & Events
  "17": 0.65, // Sports
  "15": 0.6, // Pets & Animals
  "1": 0.55, // Film & Animation
  "24": 0.55, // Entertainment
  "23": 0.5, // Comedy
  "20": 0.45, // Gaming
  "10": 0.35, // Music
};
// Por região do público:
const REGION_RPM = {
  US: 1.0, GB: 0.9, AU: 0.95, CA: 0.9, NZ: 0.85, IE: 0.8,
  DE: 0.8, CH: 0.9, NL: 0.75, NO: 0.85, SE: 0.75, DK: 0.8,
  FR: 0.55, IT: 0.45, ES: 0.45, JP: 0.6, KR: 0.5,
  BR: 0.25, MX: 0.25, PT: 0.35, IN: 0.12, PH: 0.1, ID: 0.1,
};
const DEFAULT_RPM = 0.5;

// ===================== CONFIG DE NICHOS =====================
// niches.json:
// {
//   "car_savings": {
//     "rpm": 1.0,                    (opcional: sobrescreve o fator da categoria)
//     "queries": { "en": ["cheap reliable used cars", ...], "pt": ["carros baratos que duram", ...] }
//   }
// }
function loadConfig() {
  if (!fs.existsSync(ARGS.config)) {
    console.error(`❌ Config não encontrada: ${ARGS.config}`);
    process.exit(1);
  }
  let cfg;
  try {
    // Tolera JSONC: remove comentários // e /* */ fora de strings, e vírgulas finais.
    const raw = fs.readFileSync(ARGS.config, "utf8")
      .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "")
      .replace(/,(\s*[}\]])/g, "$1");
    cfg = JSON.parse(raw);
  } catch (e) {
    console.error(`❌ JSON inválido em ${ARGS.config}: ${e.message}`);
    process.exit(1);
  }
  // Aceita também um wrapper { "niches": { ... } } ou { "niches": [ { "id": ..., "label": ..., "queries": ... } ] }
  if (cfg && typeof cfg.niches === "object") cfg = cfg.niches;
  if (Array.isArray(cfg)) {
    const map = {};
    cfg.forEach((n, i) => {
      const id = n?.id || n?.key || n?.name || `niche_${i + 1}`;
      map[id] = n;
    });
    cfg = map;
  }

  const isQueryMap = (o) =>
    o && typeof o === "object" && !Array.isArray(o) &&
    Object.values(o).some((v) => Array.isArray(v) && v.every((s) => typeof s === "string"));

  const wanted = ARGS.niches ? new Set(ARGS.niches.split(",").map((s) => s.trim())) : null;
  const out = {};
  const skipped = [];
  for (const [k, v] of Object.entries(cfg ?? {})) {
    if (k.startsWith("_")) continue;
    if (wanted && !wanted.has(k)) { skipped.push(`${k}: fora do filtro --niches`); continue; }
    if (isQueryMap(v?.queries)) {
      out[k] = v; // formato v2: { rpm?, queries: { en: [...] } }
    } else if (isQueryMap(v)) {
      // formato v1: { en: [...], pt: [...] }
      const queries = Object.fromEntries(Object.entries(v).filter(([, arr]) => Array.isArray(arr)));
      out[k] = { rpm: typeof v.rpm === "number" ? v.rpm : undefined, queries };
    } else {
      skipped.push(`${k}: sem lista de buscas por idioma (esperado "queries": { "en": ["..."] })`);
    }
  }
  if (!Object.keys(out).length) {
    console.error("❌ Nenhum nicho válido na config.");
    for (const s of skipped) console.error(`   - ${s}`);
    if (!skipped.length) console.error("   (arquivo vazio ou só com chaves começando por \"_\")");
    console.error('   Formato esperado: { "meu_nicho": { "queries": { "en": ["busca 1", "busca 2"] } } }');
    process.exit(1);
  }
  if (skipped.length) for (const s of skipped) console.warn(`⚠️ Ignorado ${s}`);
  return out;
}

function parseLocales(niches) {
  if (ARGS.locales) {
    return ARGS.locales.split(",").map((s) => {
      const [lang, reg] = s.trim().split(":");
      return { lang, region: (reg || "US").toUpperCase() };
    });
  }
  // Padrão: todo idioma presente na config, com uma região típica.
  const defaults = { en: "US", pt: "BR", es: "ES", fr: "FR", de: "DE", it: "IT", ja: "JP", hi: "IN" };
  const langs = new Set();
  for (const n of Object.values(niches)) for (const l of Object.keys(n.queries)) langs.add(l);
  return [...langs].map((lang) => ({ lang, region: defaults[lang] || "US" }));
}

// ===================== HELPERS =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const toInt = (x) => { const n = Number.parseInt(x, 10); return Number.isFinite(n) ? n : 0; };
const daysSince = (iso) => Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));

function median(nums) {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function trimmedMean(nums, trim = 0.1) {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  const cut = Math.floor(a.length * trim);
  const s = a.slice(cut, Math.max(cut + 1, a.length - cut));
  return s.reduce((t, x) => t + x, 0) / s.length;
}
function logScore(value, { low, high }) {
  if (!(value > 0)) return 0;
  return clamp01((Math.log10(value) - Math.log10(low)) / (Math.log10(high) - Math.log10(low)));
}
function mode(arr) {
  const c = new Map();
  for (const x of arr) c.set(x, (c.get(x) || 0) + 1);
  let best = null, n = 0;
  for (const [k, v] of c) if (v > n) { best = k; n = v; }
  return best;
}
function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}
function matchesFormat(sec) {
  if (ARGS.format === "all") return true;
  if (ARGS.format === "shorts") return sec > 0 && sec <= 180;
  return sec >= ARGS.minLongSec;
}

const STOPWORDS = new Set(
  ("the a an and or of in on for to is are this that these those with you your my i it its be at by from as how why what " +
    "de da do das dos e o a os as um uma que em no na nos nas para por com se mais").split(" "),
);
function topWords(titles, n = 25) {
  const c = new Map();
  for (const t of titles) {
    const words = t.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
    for (const w of new Set(words)) c.set(w, (c.get(w) || 0) + 1);
  }
  return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([word, count]) => ({ word, count }));
}

// ===================== API (com cache e contador de cota) =====================
const API_KEY = process.env.YT_API_KEY;
const QUOTA = { search: 100, videos: 1, channels: 1 };
let quotaUsed = 0;
let cacheHits = 0;

class QuotaExceededError extends Error {}

function cachePath(endpoint, params) {
  const h = crypto.createHash("sha1").update(endpoint + JSON.stringify(params)).digest("hex");
  return path.join(ARGS.cacheDir, `${endpoint}-${h}.json`);
}

async function ytGet(endpoint, params) {
  const file = cachePath(endpoint, params);
  if (fs.existsSync(file)) {
    const ageH = (Date.now() - fs.statSync(file).mtimeMs) / 3_600_000;
    if (ageH < ARGS.cacheHours) {
      cacheHits++;
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  }

  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  url.searchParams.set("key", API_KEY);

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      quotaUsed += QUOTA[endpoint] ?? 1;
      fs.mkdirSync(ARGS.cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(body));
      return body;
    }
    const reason = body?.error?.errors?.[0]?.reason || "";
    const msg = body?.error?.message || res.statusText;
    if (res.status === 403 && /quota|dailyLimit|rateLimit/i.test(reason + msg)) {
      throw new QuotaExceededError(`Cota esgotada (${reason || msg}).`);
    }
    if (res.status === 400 || res.status === 403 || res.status === 404) {
      throw new Error(`API ${endpoint} ${res.status}: ${msg}`);
    }
    lastErr = new Error(`API ${endpoint} ${res.status}: ${msg}`);
    await sleep(1000 * 2 ** attempt);
  }
  throw lastErr;
}

// ===================== COLETA =====================
async function searchQuery(q, lang, region, publishedAfter) {
  const found = new Map(); // videoId -> Set(passes)
  for (const order of ARGS.passes.split(",").map((s) => s.trim())) {
    let pageToken;
    for (let p = 0; p < ARGS.pages; p++) {
      const res = await ytGet("search", {
        part: "id",
        q,
        type: "video",
        maxResults: 50,
        order,
        relevanceLanguage: lang,
        regionCode: region,
        publishedAfter,
        videoDuration: effectiveDurationFilter(),
        pageToken,
      });
      for (const it of res.items ?? []) {
        const id = it?.id?.videoId;
        if (!id) continue;
        if (!found.has(id)) found.set(id, new Set());
        found.get(id).add(order);
      }
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
  }
  return found;
}
// Nota: na API, videoDuration=long só traz vídeos > 20 min e short < 4 min. Com --min-long-sec
// abaixo de 1200 buscamos sem esse filtro e cortamos pela duração real depois (no videos.list).
function effectiveDurationFilter() {
  if (ARGS.format === "long" && ARGS.minLongSec >= 1200) return "long";
  if (ARGS.format === "shorts") return "short";
  return undefined;
}

async function fetchVideos(ids) {
  const out = [];
  for (const c of chunk(ids, 50)) {
    const res = await ytGet("videos", { part: "snippet,statistics,contentDetails", id: c.join(","), maxResults: 50 });
    out.push(...(res.items ?? []));
  }
  return out;
}

async function fetchChannels(ids) {
  const map = new Map();
  for (const c of chunk(ids, 50)) {
    const res = await ytGet("channels", { part: "snippet,statistics", id: c.join(","), maxResults: 50 });
    for (const ch of res.items ?? []) {
      map.set(ch.id, {
        id: ch.id,
        title: ch.snippet?.title ?? "",
        country: ch.snippet?.country ?? null,
        createdAt: ch.snippet?.publishedAt ?? null,
        ageDays: ch.snippet?.publishedAt ? daysSince(ch.snippet.publishedAt) : null,
        subs: ch.statistics?.hiddenSubscriberCount ? null : toInt(ch.statistics?.subscriberCount),
        videoCount: toInt(ch.statistics?.videoCount),
        totalViews: toInt(ch.statistics?.viewCount),
      });
    }
  }
  return map;
}

// ===================== ANÁLISE =====================
async function analyzeNiche(key, niche, { lang, region }) {
  const queries = niche.queries?.[lang] ?? [];
  if (!queries.length) return null;

  // Arredondado ao dia para o cache valer entre execuções no mesmo dia.
  const publishedAfter = new Date(Date.now() - ARGS.months * 30.44 * 86_400_000).toISOString().slice(0, 10) + "T00:00:00Z";
  console.log(`\n🚀 ${key} | ${lang}-${region} | ${queries.length} buscas`);

  const passesByVideo = new Map();
  for (const q of queries) {
    process.stdout.write(`   🔎 "${q}" ... `);
    const found = await searchQuery(q, lang, region, publishedAfter);
    for (const [id, s] of found) {
      if (!passesByVideo.has(id)) passesByVideo.set(id, new Set());
      for (const p of s) passesByVideo.get(id).add(p);
    }
    console.log(`${found.size} vídeos`);
  }
  if (!passesByVideo.size) return null;

  const rawVideos = await fetchVideos([...passesByVideo.keys()]);
  const channels = await fetchChannels([...new Set(rawVideos.map((v) => v.snippet?.channelId).filter(Boolean))]);

  const videos = [];
  let droppedFormat = 0;
  for (const v of rawVideos) {
    const durationSec = parseDuration(v.contentDetails?.duration);
    if (!matchesFormat(durationSec)) { droppedFormat++; continue; }
    const ch = channels.get(v.snippet?.channelId);
    const views = toInt(v.statistics?.viewCount);
    const daysAlive = daysSince(v.snippet?.publishedAt);
    const vpd = views / Math.max(daysAlive, VPD_MIN_DAYS);
    const subs = ch?.subs ?? null;
    const outlierRatio = subs != null ? views / Math.max(subs, 100) : null;
    videos.push({
      id: v.id,
      url: `https://youtu.be/${v.id}`,
      title: v.snippet?.title ?? "",
      channelId: v.snippet?.channelId,
      channelTitle: v.snippet?.channelTitle ?? "",
      categoryId: v.snippet?.categoryId ?? null,
      tags: v.snippet?.tags ?? [],
      publishedAt: v.snippet?.publishedAt,
      durationMin: Math.round(durationSec / 60),
      daysAlive,
      views,
      likes: toInt(v.statistics?.likeCount),
      comments: toInt(v.statistics?.commentCount),
      vpd: Math.round(vpd),
      subs,
      outlierRatio: outlierRatio != null ? Number(outlierRatio.toFixed(2)) : null,
      channelAgeDays: ch?.ageDays ?? null,
      channelVideoCount: ch?.videoCount ?? null,
      passes: [...(passesByVideo.get(v.id) ?? [])],
    });
  }
  if (!videos.length) return null;

  // ---- Demanda: vídeos que aparecem na passagem por viewCount (o "teto" do nicho)
  const demandPool = videos.filter((v) => v.passes.includes("viewCount"));
  const demandVpds = (demandPool.length ? demandPool : videos).map((v) => v.vpd);
  const demandMedian = median(demandVpds);
  const demandTrimmed = trimmedMean(demandVpds);
  const demandValue = demandMedian * 0.6 + demandTrimmed * 0.4;

  // ---- Oportunidade: canais pequenos com vídeo acima do próprio tamanho
  const opps = videos.filter(
    (v) =>
      v.subs != null &&
      v.daysAlive >= OPP.minDaysAlive &&
      v.subs <= OPP.maxSubs &&
      v.vpd >= OPP.minVpd &&
      v.outlierRatio >= OPP.minOutlierRatio,
  );
  const oppChannels = new Set(opps.map((v) => v.channelId));
  const newChannelOpps = opps.filter((v) => v.channelAgeDays != null && v.channelAgeDays <= NEW_CHANNEL_MAX_DAYS);
  const newOppChannels = new Set(newChannelOpps.map((v) => v.channelId));
  const oppRate = opps.length / videos.length;
  const oppMedianRatio = median(opps.map((v) => v.outlierRatio));
  const oppMedianVpd = median(opps.map((v) => v.vpd));

  // ---- Concentração: quanto da audiência fica com os 5 maiores canais (alto = dominado por big players)
  const viewsByChannel = new Map();
  for (const v of videos) viewsByChannel.set(v.channelId, (viewsByChannel.get(v.channelId) || 0) + v.views);
  const totalViews = [...viewsByChannel.values()].reduce((a, b) => a + b, 0) || 1;
  const top5Share = [...viewsByChannel.values()].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0) / totalViews;

  // ---- Scores (0–100, escala absoluta)
  const demandScore = logScore(demandValue, DEMAND_REF);
  const oppScore =
    0.3 * clamp01(oppRate / 0.2) + // 20% de oportunidades = nota máxima
    0.25 * clamp01(Math.log10(1 + oppChannels.size) / Math.log10(1 + 15)) + // 15 canais distintos = máximo
    0.25 * logScore(oppMedianRatio, RATIO_REF) +
    0.2 * clamp01(newOppChannels.size / 5); // 5 canais novos estourando = máximo
  const attention = Math.round(100 * (W_DEMAND * demandScore + W_OPP * oppScore));

  const categoryId = mode(videos.map((v) => v.categoryId).filter(Boolean));
  const catFactor = niche.rpm ?? CATEGORY_RPM[categoryId] ?? DEFAULT_RPM;
  const regionFactor = REGION_RPM[region] ?? DEFAULT_RPM;
  const moneyFactor = Number((catFactor * regionFactor).toFixed(3));
  const moneyScore = Math.round(attention * moneyFactor);

  let status = "📊 ESTÁVEL";
  if (newOppChannels.size >= 3 && oppRate >= 0.1) status = "🔥 CANAIS NOVOS ESTOURANDO";
  else if (oppChannels.size >= 6 && oppRate >= 0.1) status = "🟦 PROMISSOR";
  else if (demandScore >= 0.6 && (oppRate < 0.05 || top5Share > 0.6)) status = "🟥 DOMINADO POR GRANDES";
  else if (demandScore >= 0.5 && oppChannels.size < 3) status = "🟧 DEMANDA ALTA, ENTRADA DIFÍCIL";
  else if (demandScore < 0.25) status = "⬜ POUCA DEMANDA";

  // ---- Listas para análise
  const topOutliers = [...opps].sort((a, b) => b.outlierRatio - a.outlierRatio).slice(0, 25);
  const risingChannels = [...newOppChannels]
    .map((id) => {
      const vs = opps.filter((v) => v.channelId === id);
      const ch = channels.get(id);
      return {
        channel: ch?.title,
        url: `https://www.youtube.com/channel/${id}`,
        subs: ch?.subs,
        ageDays: ch?.ageDays,
        videoCount: ch?.videoCount,
        totalViews: ch?.totalViews,
        hits: vs.length,
        bestVideo: vs.sort((a, b) => b.views - a.views)[0]?.title,
      };
    })
    .sort((a, b) => b.totalViews - a.totalViews);

  return {
    niche: key,
    label: niche.label ?? null,
    lang,
    region,
    queries,
    status,
    scores: {
      attention, // 0–100: demanda + oportunidade
      money: moneyScore, // attention × fator de monetização
      demand: Math.round(100 * demandScore),
      opportunity: Math.round(100 * oppScore),
      moneyFactor,
      categoryId,
    },
    sample: {
      videosAnalyzed: videos.length,
      droppedByFormat: droppedFormat,
      channels: viewsByChannel.size,
      top5ChannelShare: Number(top5Share.toFixed(2)),
      medianDurationMin: median(videos.map((v) => v.durationMin)),
    },
    demand: { medianVpd: Math.round(demandMedian), trimmedMeanVpd: Math.round(demandTrimmed) },
    opportunity: {
      count: opps.length,
      rate: Number(oppRate.toFixed(3)),
      distinctChannels: oppChannels.size,
      newChannels: newOppChannels.size,
      medianOutlierRatio: Number(oppMedianRatio.toFixed(2)),
      medianVpd: Math.round(oppMedianVpd),
      rules: OPP,
    },
    titleWords: topWords(topOutliers.map((v) => v.title)),
    risingChannels,
    topOutliers: topOutliers.map(({ tags, passes, categoryId, ...v }) => ({ ...v, tags: tags.slice(0, 15) })),
  };
}

// ===================== RUN =====================
function estimateQuota(niches, locales) {
  let searches = 0;
  for (const n of Object.values(niches))
    for (const loc of locales) searches += (n.queries?.[loc.lang]?.length ?? 0) * ARGS.passes.split(",").length * ARGS.pages;
  const maxVideos = searches * 50;
  return { searches, units: searches * QUOTA.search + Math.ceil(maxVideos / 50) * 2 };
}

function toCsv(report) {
  const cols = ["niche", "lang", "region", "status", "money", "attention", "demand", "opportunity", "moneyFactor",
    "demandMedianVpd", "oppCount", "oppRate", "oppChannels", "newChannels", "oppMedianRatio", "top5Share", "videos"];
  const rows = report.map((r) => [r.niche, r.lang, r.region, r.status, r.scores.money, r.scores.attention, r.scores.demand,
    r.scores.opportunity, r.scores.moneyFactor, r.demand.medianVpd, r.opportunity.count, r.opportunity.rate,
    r.opportunity.distinctChannels, r.opportunity.newChannels, r.opportunity.medianOutlierRatio,
    r.sample.top5ChannelShare, r.sample.videosAnalyzed]);
  const esc = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
  return [cols, ...rows].map((r) => r.map(esc).join(",")).join("\n");
}

function save(report, partial) {
  report.sort((a, b) => b.scores.money - a.scores.money);
  const meta = {
    generatedAt: new Date().toISOString(),
    partial,
    args: { ...ARGS, dryRun: undefined },
    quotaUsedEstimate: quotaUsed,
    cacheHits,
  };
  fs.writeFileSync(`${ARGS.out}.json`, JSON.stringify({ meta, results: report }, null, 2));
  fs.writeFileSync(`${ARGS.out}.csv`, toCsv(report));
  console.table(report.map((r) => ({
    niche: r.niche, loc: `${r.lang}-${r.region}`, status: r.status, money: r.scores.money,
    attention: r.scores.attention, demand: r.scores.demand, opp: r.scores.opportunity,
    newCh: r.opportunity.newChannels, oppCh: r.opportunity.distinctChannels,
  })));
  console.log(`\n✅ Salvo: ${ARGS.out}.json e ${ARGS.out}.csv  |  cota usada ≈ ${quotaUsed} unidades  |  cache: ${cacheHits} hits`);
}

async function main() {
  const niches = loadConfig();
  const locales = parseLocales(niches);
  const est = estimateQuota(niches, locales);
  console.log(`📋 ${Object.keys(niches).length} nicho(s) × ${locales.map((l) => `${l.lang}-${l.region}`).join(", ")}`);
  console.log(`💰 Estimativa (sem cache): ${est.searches} buscas ≈ ${est.units} unidades de cota (padrão: 10.000/dia)`);
  if (ARGS.dryRun) return;
  if (!API_KEY) {
    console.error("❌ Defina YT_API_KEY.");
    process.exit(1);
  }

  const report = [];
  try {
    for (const [key, niche] of Object.entries(niches)) {
      for (const loc of locales) {
        const r = await analyzeNiche(key, niche, loc);
        if (r) report.push(r);
      }
    }
  } catch (e) {
    if (e instanceof QuotaExceededError) {
      console.warn(`\n⚠️ ${e.message} Salvando resultado parcial. Rode de novo amanhã: o cache evita repetir as buscas já feitas.`);
      if (report.length) save(report, true);
      else console.warn("Nenhum nicho foi concluído antes da cota acabar; nada salvo.");
      process.exit(2);
    }
    throw e;
  }
  if (!report.length) {
    console.error("❌ Nenhum dado coletado.");
    process.exit(1);
  }
  save(report, false);
}

main().catch((e) => {
  console.error("Fatal:", e?.message ?? e);
  process.exit(1);
});
