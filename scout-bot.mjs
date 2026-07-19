// Launch Scout Bot v2 — сканер запусков + бумажный трекинг PnL
// Для GitHub Actions. Секреты: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID.
// Новое в v2:
//  1) при алерте пишем цену входа в state.json (state.positions)
//  2) каждый прогон проверяет открытые позиции: 2x -> фиксация 50%,
//     дальше трейлинг 50% от пика (пол — цена входа); стоп −50%
//  3) раз в ~20 часов шлёт сводку PnL в Telegram
//  4) фильтры: концентрация у деплоера/топ-10 (прокси бандл-скупки),
//     «проверка недоступна» + ликвидность < $50K -> алерт не уходит

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "https://api.geckoterminal.com/api/v2";
const GOPLUS = "https://api.gopluslabs.io/api/v1";
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = "state.json";

const POSITION_USD = 100;          // бумажная ставка на сигнал
const SKIP_UNCHECKED_BELOW = 50000; // «проверка недоступна» + ликв ниже -> скип
const SUMMARY_EVERY_MS = 20 * 3600 * 1000;

const NETS = {
  base:   { label: "Base",     liq: [20000, 300000],  gp: "8453" },
  solana: { label: "Solana",   liq: [20000, 300000],  gp: "solana" },
  eth:    { label: "Ethereum", liq: [50000, 1000000], gp: "1" },
};

// ── Состояние ─────────────────────────────────────────────
let state = { alerted: {}, trend: { base: {}, solana: {}, eth: {} }, positions: {}, lastSummary: 0 };
if (existsSync(STATE_FILE)) {
  try { state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) } } catch {}
}
state.trend ||= { base: {}, solana: {}, eth: {} };
state.alerted ||= {};
state.positions ||= {};
state.lastSummary ||= 0;

const usd = (n) => {
  n = parseFloat(n);
  if (isNaN(n)) return "—";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(0);
};
const fpx = (n) => (n >= 1 ? n.toFixed(4) : n >= 0.0001 ? n.toFixed(6) : n.toExponential(2));

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

// ── Скоринг (как в веб-приложении) ────────────────────────
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
  const ch24 = parseFloat(a.price_change_percentage?.h24) || 0;
  const sym = (p._sym || "").toUpperCase();

  // Ранний вход: молодым пулам нижний порог ликвидности снижен,
  // чтобы ловить до основного пампа, а не после
  const liqFloor = ageH < 6 ? Math.min(8000, cfg.liq[0])
                 : ageH < 24 ? Math.min(15000, cfg.liq[0])
                 : cfg.liq[0];

  let score = 0;
  const flags = [];
  if (state.trend[net][sym] && p._addr !== state.trend[net][sym]) flags.push("клон тикера");
  if (ch1 > 200 && buyers < 300) flags.push("памп без покупателей");
  if (liq < 2000 && vol24 > 20000) flags.push("ликвидность слита");
  if (ch24 > 400) flags.push("памп уже отыгран (+" + ch24.toFixed(0) + "% за 24ч)");

  if (liq >= cfg.liq[1]) score += 25; else if (liq >= liqFloor) score += 15;
  if (buyers >= 500) score += 25; else if (buyers >= 100) score += 15;
  if (sells > 0 && buys / sells >= 1.2) score += 15;
  if (liq > 0 && vol24 / liq >= 0.3) score += 10;
  if (ageH >= 6 && (t1.buys || 0) + (t1.sells || 0) > 0) score += 10;
  if (fdv >= 100000 && fdv <= 500000000) score += 10;
  if (ageH >= 24 && buyers >= 300) score += 5;

  return { score: flags.length ? 0 : score, flags, liq, buyers, fdv, vol24, ch24, ageH };
}

// ── GoPlus: проверка контракта + концентрация держателей ──
// Возвращает { text, hardFail } — hardFail=true значит алерт не отправляем.
async function securityCheck(net, addr) {
  if (!addr) return { text: "проверка недоступна", unavailable: true, hardFail: false };
  try {
    const url = net === "solana"
      ? `${GOPLUS}/solana/token_security?contract_addresses=${addr}`
      : `${GOPLUS}/token_security/${NETS[net].gp}?contract_addresses=${addr}`;
    const j = await getJson(url);
    const d = Object.values(j.result || {})[0];
    if (!d) return { text: "проверка недоступна", unavailable: true, hardFail: false };
    const bad = [];
    let hardFail = false;

    // Концентрация — прокси бандл-скупки/дев-холдинга (кейс SUNUSI)
    try {
      const creatorPct = parseFloat(d.creator_percent ?? d.creator_percentage ?? 0) || 0;
      const ownerPct = parseFloat(d.owner_percent ?? 0) || 0;
      let top10 = 0;
      if (Array.isArray(d.holders)) {
        top10 = d.holders.slice(0, 10)
          .reduce((s, h) => s + (parseFloat(h.percent ?? h.percentage ?? 0) || 0), 0);
        if (top10 <= 1.01) top10 *= 100; // GoPlus кое-где отдаёт доли, кое-где проценты
      }
      if (creatorPct * (creatorPct <= 1 ? 100 : 1) >= 10) { bad.push("деплоер держит ≥10%"); hardFail = true; }
      if (ownerPct * (ownerPct <= 1 ? 100 : 1) >= 10) { bad.push("владелец держит ≥10%"); hardFail = true; }
      if (top10 >= 70) { bad.push(`топ-10 держат ${top10.toFixed(0)}%`); hardFail = true; }
    } catch {}

    if (net === "solana") {
      if (d.mintable?.status === "1") bad.push("минт НЕ отозван");
      if (d.freezable?.status === "1") bad.push("freeze активен");
    } else {
      if (d.is_honeypot === "1") { bad.push("HONEYPOT"); hardFail = true; }
      const st = parseFloat(d.sell_tax || 0) * 100;
      if (st >= 10) bad.push(`налог продажи ${st.toFixed(0)}%`);
      if (d.is_mintable === "1") bad.push("минт открыт");
      if (d.is_open_source === "0") bad.push("код не верифицирован");
      if (d.cannot_sell_all === "1") { bad.push("нельзя продать всё"); hardFail = true; }
    }
    return {
      text: bad.length ? "🔴 " + bad.join(", ") : "🟢 базовые проверки чисты",
      unavailable: false,
      hardFail,
    };
  } catch {
    return { text: "проверка недоступна", unavailable: true, hardFail: false };
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

// ── 1. Скан рынка и новые алерты ──────────────────────────
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
          candidates.push({ p, net, ev, key });
        }
      }
    } catch (e) {
      console.error(`skip ${net}/${kind}:`, e.message);
    }
  }
}

let sent = 0, skipped = 0;
for (const { p, net, ev, key } of candidates.slice(0, 5)) {
  const sec = await securityCheck(net, p._tokAddr);
  const px = parseFloat(p.attributes.base_token_price_usd) || 0;

  // Фильтр 4: слепые токены с тонкой ликвидностью и жёсткие красные флаги
  if ((sec.unavailable && ev.liq < SKIP_UNCHECKED_BELOW) || sec.hardFail) {
    skipped++;
    console.log(`skip ${p._sym} (${net}): ${sec.text}, liq=${usd(ev.liq)}`);
    continue; // key остаётся в alerted — повторно не проверяем
  }

  // Пункт 1: открываем бумажную позицию с ценой входа
  if (px > 0) {
    state.positions[key] = {
      sym: p._sym, net, addr: p._addr, entry: px, peak: px,
      t: Date.now(), status: "open", tpHit: false, realized: 0, miss: 0,
    };
  }

  await sendTelegram(
    `🎯 <b>${p._sym}</b> · ${NETS[net].label}\n` +
    `${p._name}\n` +
    `Счёт: <b>${ev.score}/100</b> · Ликв: ${usd(ev.liq)} · Покупателей: ${ev.buyers}\n` +
    `Возраст: ${ev.ageH < 24 ? ev.ageH.toFixed(1) + "ч" : (ev.ageH / 24).toFixed(1) + "д"} · 24ч: ${ev.ch24 >= 0 ? "+" : ""}${ev.ch24.toFixed(0)}%\n` +
    `Контракт: ${sec.text}\n` +
    (px ? `Вход: $${fpx(px)} · 50% на 2x ($${fpx(px * 2)}) · стоп −50% ($${fpx(px * 0.5)})\n` : "") +
    `https://www.geckoterminal.com/${net}/pools/${p._addr}`
  );
  sent++;
}

// ── 2. Трекинг открытых позиций ───────────────────────────
// Правила на $100: до 2x стоп −50%; на 2x продаём половину (возврат $100),
// остаток — трейлинг 50% от пика, но не ниже цены входа.
const openByNet = {};
for (const [key, pos] of Object.entries(state.positions)) {
  if (pos.status === "open") (openByNet[pos.net] ||= []).push([key, pos]);
}

const closedNow = [];
for (const [net, list] of Object.entries(openByNet)) {
  for (let i = 0; i < list.length; i += 25) {
    const chunk = list.slice(i, i + 25);
    let priceMap = {};
    let apiOk = false; // промахи считаем ТОЛЬКО при успешном ответе API
    try {
      const addrs = chunk.map(([, p]) => p.addr).join(",");
      const j = await getJson(`${API}/networks/${net}/pools/multi/${addrs}`);
      apiOk = true;
      for (const d of j.data || []) {
        priceMap[d.attributes.address.toLowerCase()] =
          parseFloat(d.attributes.base_token_price_usd) || 0;
      }
    } catch (e) {
      console.error(`price check ${net}:`, e.message);
    }
    for (const [key, pos] of chunk) {
      const px = priceMap[pos.addr.toLowerCase()];
      if (!px) {
        if (!apiOk) continue; // сбой API — позицию не трогаем
        pos.miss = (pos.miss || 0) + 1;
        if (pos.miss >= 6) { // ~час подряд пула нет в API — считаем, что стоп сработал
          if (!pos.tpHit) { pos.status = "stop"; pos.pnl = -POSITION_USD / 2; }
          else { pos.status = "trail"; pos.pnl = pos.realized + (POSITION_USD / 2) - POSITION_USD; }
          pos.closedAt = Date.now();
          closedNow.push([pos, "☠️ пул исчез из API, закрыт по правилам стопа"]);
        }
        continue;
      }
      pos.miss = 0;
      const qty = POSITION_USD / pos.entry;

      if (!pos.tpHit) {
        if (px >= pos.entry * 2) {
          pos.tpHit = true;
          pos.realized = POSITION_USD; // половина продана по 2x
          pos.peak = px;
          closedNow.push([pos, `✅ достиг 2x — 50% зафиксировано ($${POSITION_USD}), остаток в трейлинге`]);
        } else if (px <= pos.entry * 0.5) {
          pos.status = "stop";
          pos.pnl = -POSITION_USD / 2;
          pos.closedAt = Date.now();
          closedNow.push([pos, `🛑 стоп −50% · итог −$${POSITION_USD / 2}`]);
        } else {
          pos.peak = Math.max(pos.peak || px, px);
        }
      } else {
        pos.peak = Math.max(pos.peak || px, px);
        const floor = Math.max(pos.entry, pos.peak * 0.5);
        if (px <= floor) {
          const value = pos.realized + (qty / 2) * floor;
          pos.status = "trail";
          pos.pnl = value - POSITION_USD;
          pos.closedAt = Date.now();
          closedNow.push([pos, `🏁 трейлинг закрыл остаток · итог ${pos.pnl >= 0 ? "+" : ""}$${pos.pnl.toFixed(0)}`]);
        }
      }
      pos.last = px;
    }
  }
}

for (const [pos, msg] of closedNow) {
  await sendTelegram(`<b>${pos.sym}</b> · ${NETS[pos.net]?.label || pos.net}\n${msg}`);
}

// ── 3. Суточная сводка ────────────────────────────────────
const positions = Object.values(state.positions);
if (positions.length && Date.now() - state.lastSummary >= SUMMARY_EVERY_MS) {
  const open = positions.filter((p) => p.status === "open");
  const closed = positions.filter((p) => p.status !== "open");
  const realizedPnl = closed.reduce((s, p) => s + (p.pnl || 0), 0);
  let unreal = 0;
  for (const p of open) {
    const px = p.last || p.entry;
    const qty = POSITION_USD / p.entry;
    unreal += (p.tpHit ? p.realized + (qty / 2) * px : qty * px) - POSITION_USD;
  }
  const tp = positions.filter((p) => p.tpHit).length;
  const stops = closed.filter((p) => p.status === "stop").length;
  const invested = positions.length * POSITION_USD;
  const total = realizedPnl + unreal;

  const openLines = open
    .sort((a, b) => (b.last / b.entry || 0) - (a.last / a.entry || 0))
    .slice(0, 10)
    .map((p) => {
      const x = p.last ? (p.last / p.entry).toFixed(2) : "?";
      return `${p.tpHit ? "🟢" : "⚪"} ${p.sym}: ${x}x`;
    })
    .join("\n");

  await sendTelegram(
    `📊 <b>Сводка Launch Scout</b>\n` +
    `Сигналов: ${positions.length} · Открыто: ${open.length} · Закрыто: ${closed.length}\n` +
    `Достигли 2x: ${tp} (${((tp / positions.length) * 100).toFixed(0)}%) · Стопов: ${stops}\n` +
    `Реализовано: ${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(0)} · ` +
    `Нереализовано: ${unreal >= 0 ? "+" : ""}$${unreal.toFixed(0)}\n` +
    `<b>Итог: ${total >= 0 ? "+" : ""}$${total.toFixed(0)} на $${invested} (${((total / invested) * 100).toFixed(1)}%)</b>` +
    (openLines ? `\n\nОткрытые:\n${openLines}` : "")
  );
  state.lastSummary = Date.now();
}

// ── Чистка ────────────────────────────────────────────────
const cutoff = Date.now() - 30 * 86400000;
for (const k of Object.keys(state.alerted)) {
  if (state.alerted[k] < cutoff) delete state.alerted[k];
}
for (const [k, p] of Object.entries(state.positions)) {
  if (p.status !== "open" && (p.closedAt || 0) < cutoff) delete state.positions[k];
}

writeFileSync(STATE_FILE, JSON.stringify(state));
console.log(`Готово: алертов ${sent}, отфильтровано ${skipped}, позиций открыто ${Object.values(state.positions).filter(p => p.status === "open").length}, закрыто сейчас ${closedNow.length}`);
