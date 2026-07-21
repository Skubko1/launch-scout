// Launch Scout Bot v3 — сканер запусков + бумажный трекинг PnL
// Для GitHub Actions. Секреты: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID.
// Новое в v3 (фикс "?x" и −11.5%):
//  1) ФИКС ЦЕН: retry с паузой при 429, user-agent, а если multi-запрос
//     упал — фолбэк на одиночные запросы по каждому пулу. Раньше при
//     любом сбое API позиции просто не обновлялись => вечные "?x".
//  2) ФИКС ВХОДОВ: порог "памп отыгран" снижен с +400% до +150%
//     (WHALE +366% и nice +340% больше не пройдут); добавлен фильтр
//     "падающий нож" — ch24 <= −30% для пулов моложе 3 дней
//     (MrSue −71% и JACOBIAN −69% больше не пройдут).
//  3) Диагностика: счётчик сбоев цен пишется в лог и в сводку,
//     чтобы проблема с API была видна сразу, а не через неделю.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "https://api.geckoterminal.com/api/v2";
const GOPLUS = "https://api.gopluslabs.io/api/v1";
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = "state.json";

const POSITION_USD = 100;           // бумажная ставка на сигнал
const SKIP_UNCHECKED_BELOW = 50000; // «проверка недоступна» + ликв ниже -> скип
const SUMMARY_EVERY_MS = 20 * 3600 * 1000;
const MAX_CH24 = 150;               // выше — считаем, что памп отыгран
const KNIFE_CH24 = -30;             // ниже для молодых пулов — падающий нож
const STOP_MULT = 0.5;              // стоп: −50% от входа
const TP_MULT = 2;                  // фиксация 50% на 2x

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// v3: retry при 429/5xx + явный user-agent (Actions-IP часто режут по UA)
async function getJson(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "launch-scout-bot/3.0" },
      });
      if (r.ok) return r.json();
      lastErr = new Error(`${url} -> ${r.status}`);
      if (r.status === 429 || r.status >= 500) { await sleep(12000 * (i + 1)); continue; }
      throw lastErr;
    } catch (e) {
      lastErr = e;
      await sleep(5000 * (i + 1));
    }
  }
  throw lastErr;
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

// ── Скоринг ───────────────────────────────────────────────
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

  // Ранний вход: молодым пулам нижний порог ликвидности снижен
  const liqFloor = ageH < 6 ? Math.min(12000, cfg.liq[0])
                 : ageH < 24 ? Math.min(15000, cfg.liq[0])
                 : cfg.liq[0];

  let score = 0;
  const flags = [];
  if (state.trend[net][sym] && p._addr !== state.trend[net][sym]) flags.push("клон тикера");
  if (ch1 > 200 && buyers < 300) flags.push("памп без покупателей");
  if (liq < 2000 && vol24 > 20000) flags.push("ликвидность слита");
  // v3: было >400 — пропускало входы на вершине (+340…+366%)
  if (ch24 > MAX_CH24) flags.push("памп уже отыгран (+" + ch24.toFixed(0) + "% за 24ч)");
  // v3: падающий нож — раньше −70% за сутки проходило, если пул старше 24ч
  if (ch24 <= KNIFE_CH24 && ageH < 72) flags.push("падающий нож (" + ch24.toFixed(0) + "% за 24ч)");
  if (ageH < 2) flags.push("моложе 2ч — снайперская фаза");
  if (ageH < 24 && ch24 < 0) flags.push("нисходящий тренд для молодого пула");
  if (ageH < 6 && (buyers < 500 || (sells > 0 && buys / sells < 1.3)))
    flags.push("слабое подтверждение для раннего входа");

  if (liq >= cfg.liq[1]) score += 25; else if (liq >= liqFloor) score += 15;
  if (buyers >= 500) score += 25; else if (buyers >= 100) score += 15;
  if (sells > 0 && buys / sells >= 1.2) score += 15;
  if (liq > 0 && vol24 / liq >= 0.3) score += 10;
  if (ageH >= 6 && (t1.buys || 0) + (t1.sells || 0) > 0) score += 10;
  if (fdv >= 100000 && fdv <= 500000000) score += 10;
  if (ageH >= 24 && buyers >= 300) score += 5;

  return { score: flags.length ? 0 : score, rawScore: score, flags, liq, buyers, fdv, vol24, ch24, ageH };
}

// ── GoPlus: проверка контракта + концентрация держателей ──
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

    // Концентрация — прокси бандл-скупки/дев-холдинга
    try {
      const creatorPct = parseFloat(d.creator_percent ?? d.creator_percentage ?? 0) || 0;
      const ownerPct = parseFloat(d.owner_percent ?? 0) || 0;
      let top10 = 0;
      if (Array.isArray(d.holders)) {
        top10 = d.holders.slice(0, 10)
          .reduce((s, h) => s + (parseFloat(h.percent ?? h.percentage ?? 0) || 0), 0);
        if (top10 <= 1.01) top10 *= 100;
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
const filterStats = {};
const nearMiss = [];
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
        for (const f of ev.flags) filterStats[f] = (filterStats[f] || 0) + 1;
        if (ev.flags.length && ev.rawScore >= 60) nearMiss.push(`${p._sym}(${net}): ${ev.flags[0]}`);
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

  if ((sec.unavailable && ev.liq < SKIP_UNCHECKED_BELOW) || sec.hardFail) {
    skipped++;
    console.log(`skip ${p._sym} (${net}): ${sec.text}, liq=${usd(ev.liq)}`);
    continue;
  }

  if (px > 0) {
    state.positions[key] = {
      sym: p._sym, net, addr: p._addr, entry: px, peak: px,
      t: Date.now(), status: "open", tpHit: false, realized: 0, miss: 0,
    };
  }

  state.lastAlert = Date.now();
  await sendTelegram(
    `🎯 <b>${p._sym}</b> · ${NETS[net].label}\n` +
    `${p._name}\n` +
    `Счёт: <b>${ev.score}/100</b> · Ликв: ${usd(ev.liq)} · Покупателей: ${ev.buyers}\n` +
    `Возраст: ${ev.ageH < 24 ? ev.ageH.toFixed(1) + "ч" : (ev.ageH / 24).toFixed(1) + "д"} · 24ч: ${ev.ch24 >= 0 ? "+" : ""}${ev.ch24.toFixed(0)}%\n` +
    `Контракт: ${sec.text}\n` +
    (px ? `Вход: $${fpx(px)} · 50% на 2x ($${fpx(px * TP_MULT)}) · стоп −50% ($${fpx(px * STOP_MULT)})\n` : "") +
    `https://www.geckoterminal.com/${net}/pools/${p._addr}`
  );
  sent++;
}

// ── 2. Трекинг открытых позиций ───────────────────────────
// v3: multi-запрос с фолбэком на одиночные. priceFails копится для диагностики.
const openByNet = {};
for (const [key, pos] of Object.entries(state.positions)) {
  if (pos.status === "open") (openByNet[pos.net] ||= []).push([key, pos]);
}

let priceFails = 0, priceOk = 0;
const closedNow = [];
for (const [net, list] of Object.entries(openByNet)) {
  for (let i = 0; i < list.length; i += 25) {
    const chunk = list.slice(i, i + 25);
    let priceMap = {};
    let apiOk = false;

    // Попытка 1: batch-запрос
    try {
      const addrs = chunk.map(([, p]) => p.addr).join(",");
      const j = await getJson(`${API}/networks/${net}/pools/multi/${addrs}`);
      apiOk = true;
      for (const d of j.data || []) {
        priceMap[d.attributes.address.toLowerCase()] =
          parseFloat(d.attributes.base_token_price_usd) || 0;
      }
    } catch (e) {
      console.error(`price multi ${net}:`, e.message);
    }

    // Попытка 2 (v3): фолбэк по одному пулу, если batch упал
    if (!apiOk) {
      let anyOk = false;
      for (const [, pos] of chunk) {
        try {
          const j = await getJson(`${API}/networks/${net}/pools/${pos.addr}`, 2);
          priceMap[pos.addr.toLowerCase()] =
            parseFloat(j.data?.attributes?.base_token_price_usd) || 0;
          anyOk = true;
        } catch (e) {
          // 404 => пула нет: оставляем без цены, miss-логика ниже посчитает
          if (String(e.message).includes("404")) { priceMap[pos.addr.toLowerCase()] = 0; anyOk = true; }
          else console.error(`price single ${net}/${pos.sym}:`, e.message);
        }
        await sleep(1500); // бережём rate-limit
      }
      apiOk = anyOk;
    }

    for (const [key, pos] of chunk) {
      const px = priceMap[pos.addr.toLowerCase()];
      if (!px) {
        if (!apiOk) { priceFails++; continue; } // сбой API — позицию не трогаем
        pos.miss = (pos.miss || 0) + 1;
        if (pos.miss >= 6) {
          if (!pos.tpHit) { pos.status = "stop"; pos.pnl = -POSITION_USD / 2; }
          else { pos.status = "trail"; pos.pnl = pos.realized + (POSITION_USD / 2) - POSITION_USD; }
          pos.closedAt = Date.now();
          closedNow.push([pos, "☠️ пул исчез из API, закрыт по правилам стопа"]);
        }
        continue;
      }
      priceOk++;
      pos.miss = 0;
      const qty = POSITION_USD / pos.entry;

      if (!pos.tpHit) {
        if (px >= pos.entry * TP_MULT) {
          pos.tpHit = true;
          pos.realized = POSITION_USD;
          pos.peak = px;
          closedNow.push([pos, `✅ достиг 2x — 50% зафиксировано ($${POSITION_USD}), остаток в трейлинге`]);
        } else if (px <= pos.entry * STOP_MULT) {
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
      pos.lastSeen = Date.now();
    }
  }
}

for (const [pos, msg] of closedNow) {
  await sendTelegram(`<b>${pos.sym}</b> · ${NETS[pos.net]?.label || pos.net}\n${msg}`);
}

// v3: если цены не получены НИ по одной позиции — кричим об этом в Telegram
// (раз в 24ч), а не молчим неделями с "?x"
state.lastPriceFailPing ||= 0;
if (priceFails > 0 && priceOk === 0 &&
    Date.now() - state.lastPriceFailPing > 24 * 3600 * 1000) {
  await sendTelegram(
    `⚠️ Не удалось получить цены ни по одной из ${priceFails} открытых позиций.\n` +
    `GeckoTerminal, похоже, режет запросы (rate-limit/блок). Трекинг PnL стоит.\n` +
    `Проверь логи Actions: "price multi" / "price single".`
  );
  state.lastPriceFailPing = Date.now();
}

// ── Heartbeat: сутки без сигналов ─────────────────────────
state.lastAlert ||= Date.now();
state.lastHeartbeat ||= 0;
if (Date.now() - state.lastAlert > 24 * 3600 * 1000 &&
    Date.now() - state.lastHeartbeat > 24 * 3600 * 1000) {
  const top = Object.entries(filterStats).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([f, n]) => `· ${f}: ${n}`).join("\n");
  await sendTelegram(
    `💤 Сутки без сигналов. Бот работает, кандидатов нет.\n` +
    (nearMiss.length ? `Почти прошли:\n${nearMiss.slice(0, 5).join("\n")}\n` : "") +
    (top ? `Отсев за прогон:\n${top}` : "Рынок пустой — пулы не проходят даже базовый скоринг.")
  );
  state.lastHeartbeat = Date.now();
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
  const stale = open.filter((p) => !p.last).length;

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
    (stale ? `\n⚠️ Без цены: ${stale} позиций (проблема с API)` : "") +
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
if (Object.keys(filterStats).length) console.log("Отсев:", JSON.stringify(filterStats));
if (nearMiss.length) console.log("Почти прошли:", nearMiss.slice(0, 8).join(" | "));
console.log(`Готово: алертов ${sent}, отфильтровано ${skipped}, цены ok=${priceOk}/fail=${priceFails}, позиций открыто ${Object.values(state.positions).filter(p => p.status === "open").length}, закрыто сейчас ${closedNow.length}`);
