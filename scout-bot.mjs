// Launch Scout Bot — сканер запусков для GitHub Actions
// Тот же скоринг, что в веб-приложении. Новые кандидаты уходят в Telegram.
// Требует Node 20+. Секреты: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "https://api.geckoterminal.com/api/v2";
const GOPLUS = "https://api.gopluslabs.io/api/v1";
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = "state.json";

const NETS = {
  base:   { label: "Base",     liq: [50000, 500000],   gp: "8453" },
  solana: { label: "Solana",   liq: [30000, 300000],   gp: "solana" },
  eth:    { label: "Ethereum", liq: [100000, 1000000], gp: "1" },
};

// ── Состояние: кого уже алертили + трендовые тикеры ──────
let state = { alerted: {}, trend: { base: {}, solana: {}, eth: {} } };
if (existsSync(STATE_FILE)) {
  try { state = JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch {}
}
state.trend ||= { base: {}, solana: {}, eth: {} };
state.alerted ||= {};

const usd = (n) => {
  n = parseFloat(n);
  if (isNaN(n)) return "—";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(0);
};

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

function decorate(p, tokens) {
  const a = p.attributes;
  const rel = p.relationships?.base_token?.data?.id;
  const tk = tokens[rel] || {};
  p._sym = tk.symbol || (a.name || "").split("/")[0].trim();
  p._name = tk.name || a.name || "";
  p._addr = a.address;
  p._tokAddr = tk.address || (rel ? rel.split("_").slice(1).join("_") : null);
  return p;
}
function indexTokens(json) {
  const map = {};
  for (const inc of json.included || []) if (inc.type === "token") map[inc.id] = inc.attributes;
  return map;
}

// ── Скоринг (идентичен веб-приложению) ────────────────────
function evaluate(p, net) {
  const a = p.attributes;
  const cfg = NETS[net];
  const liq = parseFloat(a.reserve_in_usd) || 0;
  const fdv = parseFloat(a.fdv_usd) || 0;
  const vol24 = parseFloat(a.volume_usd?.h24) || 0;
  const t24 = a.transactions?.h24 || {};
  const t1 = a.transactions?.h1 || {};
  const buyers = t24.buyers || 0, buys = t24.buys || 0, sells = t24.sells || 0;
  const ch1 = parseFloat(a.price_change_percentage?.h1) || 0;
  const ageH = (Date.now() - new Date(a.pool_created_at).getTime()) / 3600000;
  const sym = (p._sym || "").toUpperCase();

  let score = 0;
  const flags = [];
  if (state.trend[net][sym] && p._addr !== state.trend[net][sym]) flags.push("клон тикера");
  if (ch1 > 200 && buyers < 300) flags.push("памп без покупателей");
  if (liq < 2000 && vol24 > 20000) flags.push("ликвидность слита");

  if (liq >= cfg.liq[1]) score += 25; else if (liq >= cfg.liq[0]) score += 15;
  if (buyers >= 500) score += 25; else if (buyers >= 100) score += 15;
  if (sells > 0 && buys / sells >= 1.2) score += 15;
  if (liq > 0 && vol24 / liq >= 0.3) score += 10;
  if (ageH >= 6 && (t1.buys || 0) + (t1.sells || 0) > 0) score += 10;
  if (fdv >= 100000 && fdv <= 500000000) score += 10;
  if (ageH >= 24 && buyers >= 300) score += 5;

  return { score: flags.length ? 0 : score, flags, liq, buyers, fdv, vol24 };
}

// ── GoPlus: экспресс-проверка контракта ───────────────────
async function securityCheck(net, addr) {
  if (!addr) return "проверка недоступна";
  try {
    const url = net === "solana"
      ? `${GOPLUS}/solana/token_security?contract_addresses=${addr}`
      : `${GOPLUS}/token_security/${NETS[net].gp}?contract_addresses=${addr}`;
    const j = await getJson(url);
    const d = Object.values(j.result || {})[0];
    if (!d) return "проверка недоступна";
    const bad = [];
    if (net === "solana") {
      if (d.mintable?.status === "1") bad.push("минт НЕ отозван");
      if (d.freezable?.status === "1") bad.push("freeze активен");
    } else {
      if (d.is_honeypot === "1") bad.push("HONEYPOT");
      const st = parseFloat(d.sell_tax || 0) * 100;
      if (st >= 10) bad.push(`налог продажи ${st.toFixed(0)}%`);
      if (d.is_mintable === "1") bad.push("минт открыт");
      if (d.is_open_source === "0") bad.push("код не верифицирован");
      if (d.cannot_sell_all === "1") bad.push("нельзя продать всё");
    }
    return bad.length ? "🔴 " + bad.join(", ") : "🟢 базовые проверки чисты";
  } catch {
    return "проверка недоступна";
  }
}

async function sendTelegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) console.error("Telegram error:", await r.text());
}

// ── Основной цикл ─────────────────────────────────────────
const candidates = [];
for (const net of Object.keys(NETS)) {
  for (const kind of ["new_pools", "trending_pools"]) {
    try {
      const j = await getJson(`${API}/networks/${net}/${kind}?include=base_token`);
      const tokens = indexTokens(j);
      for (const p of j.data || []) {
        decorate(p, tokens);
        const sym = (p._sym || "").toUpperCase();
        if (kind === "trending_pools" && sym && !state.trend[net][sym]) {
          state.trend[net][sym] = p._addr;
        }
        const ageDays = (Date.now() - new Date(p.attributes.pool_created_at).getTime()) / 86400000;
        if (ageDays > 60) continue;
        const ev = evaluate(p, net);
        const key = `${net}_${p._addr}`;
        if (ev.score >= 60 && !state.alerted[key]) {
          state.alerted[key] = Date.now();
          candidates.push({ p, net, ev });
        }
      }
    } catch (e) {
      console.error(`skip ${net}/${kind}:`, e.message);
    }
  }
}

for (const { p, net, ev } of candidates.slice(0, 5)) {
  const sec = await securityCheck(net, p._tokAddr);
  const px = parseFloat(p.attributes.base_token_price_usd) || 0;
  const f = (n) => (n >= 1 ? n.toFixed(4) : n >= 0.0001 ? n.toFixed(6) : n.toExponential(2));
  await sendTelegram(
    `🎯 <b>${p._sym}</b> · ${NETS[net].label}\n` +
    `${p._name}\n` +
    `Счёт: <b>${ev.score}/100</b> · Ликв: ${usd(ev.liq)} · Покупателей: ${ev.buyers}\n` +
    `Контракт: ${sec}\n` +
    (px ? `План выхода: 50% на 2x ($${f(px * 2)}) · стоп −50% ($${f(px * 0.5)})\n` : "") +
    `https://www.geckoterminal.com/${net}/pools/${p._addr}`
  );
}

// Чистим alerted старше 30 дней, чтобы state не разрастался
const cutoff = Date.now() - 30 * 86400000;
for (const k of Object.keys(state.alerted)) {
  if (state.alerted[k] < cutoff) delete state.alerted[k];
}

writeFileSync(STATE_FILE, JSON.stringify(state));
console.log(`Готово: кандидатов отправлено ${Math.min(candidates.length, 5)} из ${candidates.length}`);
