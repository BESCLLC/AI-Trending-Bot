// index.js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');

// ---------- ENV ----------
const {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MINUTES = '3',
  TRENDING_SIZE = '8',

  MIN_LIQ_USD = '3000',
  MIN_VOL24_USD = '500',
  MIN_BUYS_24H = '2',

  BURST_MIN_ABS_USD = '500',
  BURST_MIN_PCT = '0.5',

  NEW_POOL_MAX_MIN = '10',
  NEW_POOL_MIN_LIQ_USD = '3000',
  NEW_POOL_MIN_VOL24_USD = '500',
  NEW_POOL_MIN_BUYERS = '3',
  NEW_ALERT_COOLDOWN_MIN = '30',

  OPENAI_API_KEY,
  AI_MODEL = 'gpt-4o-mini',
  AI_WEIGHT = '2000',
  AI_TIMEOUT_MS = '20000',

  CLAUDE_API_KEY,
  CLAUDE_MODEL = 'claude-3-5-sonnet-20240620',
  GROQ_API_KEY,
  GROQ_MODEL = 'llama-3.1-405b-reasoning',

  SPONSORED_POOLS = '',

  HISTORY_FILE = './history.json',
  HISTORY_MAX_POINTS = '4032',
  RISK_FILE = './risk_cache.json',
} = process.env;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  throw new Error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');
}

const bot = new TelegramBot(TELEGRAM_TOKEN);
const GT_BASE = 'https://api.geckoterminal.com/api/v2';
const lastVolumes = new Map();
const alertedNewPools = new Map();
const riskCache = fs.existsSync(RISK_FILE) ? JSON.parse(fs.readFileSync(RISK_FILE)) : {};
let lastPinnedId = null;
let errorCount = 0;

// ---------- STARTUP CHECK ----------
if (process.version.split('.')[0].slice(1) < 14) {
  console.error('Node.js version 14 or higher required for full functionality');
  process.exit(1);
}

// ---------- HISTORY & RISK CACHE ----------
const history = fs.existsSync(HISTORY_FILE)
  ? JSON.parse(fs.readFileSync(HISTORY_FILE))
  : {};

function updateHistory(address, vol24) {
  if (!history[address]) history[address] = [];
  history[address].push({ t: Date.now(), v: vol24 });
  if (history[address].length > Number(HISTORY_MAX_POINTS))
    history[address].shift();
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function getHistoryStats(address) {
  const arr = history[address] || [];
  if (!arr.length) return { avg: 0, trend: 0, vola: 0 };
  const avg = arr.reduce((a, b) => a + b.v, 0) / arr.length;
  const recent = arr.slice(-12); // Last 12 points for trend
  const trend = recent.length > 1 ? (recent[recent.length - 1].v - recent[0].v) / recent[0].v : 0;
  const vola = arr.length > 1 ? Math.sqrt(arr.reduce((sum, p) => sum + Math.pow(p.v - avg, 2), 0) / arr.length) / avg : 0;
  return { avg, trend, vola: vola * 100 };
}

function updateRiskCache(address, risk) {
  riskCache[address] = { risk, updated: Date.now() };
  if (Object.keys(riskCache).length > 1000) {
    const keys = Object.keys(riskCache).sort((a, b) => riskCache[b].updated - riskCache[a].updated);
    keys.slice(500).forEach(k => delete riskCache[k]);
  }
  fs.writeFileSync(RISK_FILE, JSON.stringify(riskCache, null, 2));
}

function getCachedRisk(address) {
  const entry = riskCache[address];
  if (entry && (Date.now() - entry.updated) < 3600000) return entry.risk; // 1h cache
  return null;
}

// ---------- UTILS ----------
function fmtUsd(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
}

function fmtPct(n) {
  return `${(n >= 0 ? '+' : '')}${n.toFixed(1)}%`;
}

function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function nowMs() {
  return Date.now();
}

async function safeFetch(fn, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      console.error(`[Retry] Attempt ${i + 1} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw new Error('All retries failed');
}

// ---------- FETCH POOLS ----------
async function fetchPoolsPage(page = 1) {
  const url = `${GT_BASE}/networks/besc-hyperchain/pools`;
  const { data } = await axios.get(url, {
    params: { sort: 'h24_volume_usd_desc', page, include: 'base_token,quote_token' },
    timeout: 20000,
    headers: { 'User-Agent': 'BESC-TrendingBot/1.0' },
  });
  return data?.data ?? [];
}

async function fetchAllPools() {
  const [p1, p2, p3] = await Promise.allSettled([
    fetchPoolsPage(1),
    fetchPoolsPage(2),
    fetchPoolsPage(3),
  ]);
  const arr = [];
  [p1, p2, p3].forEach(p => {
    if (p.status === 'fulfilled') arr.push(...p.value);
  });
  return arr;
}

function isGoodPool(p) {
  const a = p.attributes || {};
  const liq = Number(a.reserve_in_usd || 0);
  const vol = Number(a.volume_usd?.h24 || 0);
  const buys = Number(a.transactions?.h24?.buys || 0);
  const ageMin = (nowMs() - new Date(a.pool_created_at).getTime()) / 60000;
  return liq >= Number(MIN_LIQ_USD) && vol >= Number(MIN_VOL24_USD) && buys >= Number(MIN_BUYS_24H) && ageMin >= 1;
}

function buildFeatures(p) {
  const a = p.attributes || {};
  const volNow = Number(a.volume_usd?.h24 || 0);
  const volPrev = Number(lastVolumes.get(a.address) || volNow);
  const delta = volNow - volPrev;
  const rate = volPrev > 0 ? delta / volPrev : 0;
  const liq = Number(a.reserve_in_usd || 0);
  const fdv = Number(a.market_cap_usd || a.fdv_usd || 0);
  const change = Number(a.price_change_percentage?.h24 || 0);
  const buys = Number(a.transactions?.h24?.buys || 0);
  const sells = Number(a.transactions?.h24?.sells || 0);
  const buyers = Number(a.transactions?.h24?.buyers || 0);
  const bsr = (buys + 1) / (sells + 1);
  const ageMin = (nowMs() - new Date(a.pool_created_at).getTime()) / 60000;
  const histStats = getHistoryStats(a.address);
  const cachedRisk = getCachedRisk(a.address);
  return {
    address: a.address,
    name: a.name,
    liq_usd: liq,
    fdv_usd: fdv,
    age_min: ageMin,
    vol24_now: volNow,
    vol24_delta_5m: delta,
    vol24_delta_rate: rate,
    change24_abs: Math.abs(change),
    buy_sell_ratio: bsr,
    buyers24: buyers,
    buys24: buys,
    sells24: sells,
    hist_avg: histStats.avg,
    hist_trend: histStats.trend,
    hist_vola: histStats.vola,
    vol_vs_avg_pct: histStats.avg
      ? ((volNow - histStats.avg) / histStats.avg) * 100
      : 0,
    risk_level: cachedRisk || 'med',
    link: `https://www.geckoterminal.com/besc-hyperchain/pools/${a.address}`,
  };
}

// ---------- AI SCORING ----------
function cleanJsonString(raw) {
  if (!raw) return '{}';
  const match = raw.match(/\{[\s\S]*\}/);
  let json = match ? match[0] : raw;
  json = json.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
  return json;
}

async function aiScores(model, endpoint, key, items, isSummary = false) {
  try {
    const isClaude = endpoint.includes('anthropic');
    const prompt = isSummary
      ? `Provide a concise 1-2 sentence summary of the BESC HyperChain market based on these top pools, including overall sentiment and key trend: ${JSON.stringify(items)}`
      : `As an expert DeFi analyst for BESC HyperChain, analyze these liquidity pools. Return ONLY valid JSON object mapping each pool address to: {"score":0-100 (higher for momentum/risk-adjusted potential), "risk":"low|med|high" (consider liquidity, volatility, buy pressure), "tags":["up to 5 keywords like 'gem', 'pump', 'dip'"], "reason":"insight <20 words on why", "prediction":"bullish|bearish|sideways" (24h outlook)}. Incorporate on-chain metrics like vol spike, buyer ratio, FDV. Pools: ${JSON.stringify(items)}`;

    const payload = isClaude
      ? {
          model,
          max_tokens: isSummary ? 250 : 1500,
          temperature: 0.1,
          messages: [{ role: 'user', content: prompt }],
        }
      : {
          model,
          temperature: 0.1,
          response_format: isSummary ? undefined : { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: isSummary
                ? 'You are a sharp crypto market summarizer for BESC HyperChain. Keep it brief, actionable, with sentiment.'
                : 'You are a precise on-chain analyst for BESC HyperChain pools. Output strict JSON with score (momentum + safety), risk, tags, reason, prediction. Favor undervalued gems with buy pressure.',
            },
            { role: 'user', content: prompt },
          ],
        };

    const headers = isClaude
      ? {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        }
      : {
          Authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        };

    const { data } = await axios.post(endpoint, payload, {
      headers,
      timeout: Number(AI_TIMEOUT_MS),
    });

    let raw = isClaude ? data.content?.[0]?.text : data.choices?.[0]?.message?.content;
    raw = cleanJsonString(raw);

    return isSummary ? raw.trim() : JSON.parse(raw || '{}');
  } catch (e) {
    console.error(`[AI/${model}] fail:`, e.message);
    return isSummary ? '' : {};
  }
}

async function getAIScores(items) {
  const [openai, claude, groq] = await Promise.allSettled([
    OPENAI_API_KEY ? aiScores(AI_MODEL, 'https://api.openai.com/v1/chat/completions', OPENAI_API_KEY, items) : {},
    CLAUDE_API_KEY ? aiScores(CLAUDE_MODEL, 'https://api.anthropic.com/v1/messages', CLAUDE_API_KEY, items) : {},
    GROQ_API_KEY ? aiScores(GROQ_MODEL, 'https://api.groq.com/openai/v1/chat/completions', GROQ_API_KEY, items) : {},
  ]);

  const merged = {};
  for (const it of items) {
    const addr = it.address;
    const scores = [
      openai.value?.[addr]?.score,
      claude.value?.[addr]?.score,
      groq.value?.[addr]?.score,
    ].filter((x) => typeof x === 'number');

    if (!scores.length) continue;

    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const risks = [openai.value?.[addr]?.risk, claude.value?.[addr]?.risk, groq.value?.[addr]?.risk].filter(Boolean);
    const modeRisk = risks.sort((a,b) => risks.filter(v => v===a).length - risks.filter(v => v===b).length).pop() || 'med';
    const tags = [...new Set([
      ...(openai.value?.[addr]?.tags || []),
      ...(claude.value?.[addr]?.tags || []),
      ...(groq.value?.[addr]?.tags || []),
    ])].slice(0, 5);
    const predictions = [openai.value?.[addr]?.prediction, claude.value?.[addr]?.prediction, groq.value?.[addr]?.prediction].filter(Boolean);
    const modePred = predictions.sort((a,b) =>
      predictions.filter(v => v===a).length - predictions.filter(v => v===b).length
    ).pop() || 'sideways';
    const reasons = [openai.value?.[addr]?.reason, claude.value?.[addr]?.reason, groq.value?.[addr]?.reason].filter(Boolean);
    const reason = reasons.join(' | ').substring(0, 50);

    merged[addr] = {
      score: Math.min(100, Math.max(0, avg)),
      risk: modeRisk,
      tags,
      reason,
      prediction: modePred,
      disagree: Math.max(...scores) - Math.min(...scores) > 20,
      confidence: 100 - (Math.max(...scores) - Math.min(...scores)),
    };

    // Cache risk
    updateRiskCache(addr, modeRisk);
  }
  return merged;
}

async function getMarketSummary(items) {
  if (!OPENAI_API_KEY && !CLAUDE_API_KEY && !GROQ_API_KEY) return '';
  if (CLAUDE_API_KEY) {
    return await aiScores(CLAUDE_MODEL, 'https://api.anthropic.com/v1/messages', CLAUDE_API_KEY, items, true);
  }
  if (OPENAI_API_KEY) {
    return await aiScores(AI_MODEL, 'https://api.openai.com/v1/chat/completions', OPENAI_API_KEY, items, true);
  }
  return '';
}

// ---------- NEW POOL ALERTS ----------
async function checkNewPools(candidates) {
  const newish = candidates.filter(p => {
    const a = p.attributes;
    const ageMin = (nowMs() - new Date(a.pool_created_at).getTime()) / 60000;
    return ageMin <= Number(NEW_POOL_MAX_MIN) &&
           Number(a.reserve_in_usd || 0) >= Number(NEW_POOL_MIN_LIQ_USD) &&
           Number(a.volume_usd?.h24 || 0) >= Number(NEW_POOL_MIN_VOL24_USD) &&
           Number(a.transactions?.h24?.buyers || 0) >= Number(NEW_POOL_MIN_BUYERS);
  });

  for (const p of newish) {
    const a = p.attributes;
    const key = a.address;
    const lastAlert = alertedNewPools.get(key) || 0;
    if (nowMs() - lastAlert > Number(NEW_ALERT_COOLDOWN_MIN) * 60000) {
      const feat = buildFeatures(p);
      const msg = `🆕 <b>New Pool Alert!</b> ${esc(a.name)}\n` +
                  `💧 LQ: ${fmtUsd(feat.liq_usd)} | 💵 Vol: ${fmtUsd(feat.vol24_now)}\n` +
                  `🛒 Buyers: ${feat.buyers24} | 📈 24h: ${fmtPct(Number(a.price_change_percentage?.h24 || 0))}\n` +
                  `<a href="${esc(feat.link)}">View on Gecko</a>`;
      await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
      alertedNewPools.set(key, nowMs());
    }
  }
}

// ---------- RANKING ----------
function baseHotness(f) {
  const burstBoost = Math.max(0, f.vol24_delta_5m) * 3;
  const buyerBoost = (f.buyers24 || 0) * 100;
  const recencyBonus = f.age_min < 60 ? 1000 : f.age_min < 360 ? 500 : 0;
  const trendBoost = f.hist_trend > 0.1 ? f.vol24_now * 0.2 : 0;
  const volaPenalty = f.hist_vola > 50 ? f.vol24_now * 0.15 : 0;
  const sellPenalty = f.buy_sell_ratio < 0.3 ? f.vol24_now * 0.3 : 0;
  const riskAdjust = f.risk_level === 'low' ? 1.2 : f.risk_level === 'high' ? 0.7 : 1;
  return (f.vol24_now + burstBoost + buyerBoost + recencyBonus + trendBoost - volaPenalty - sellPenalty) * riskAdjust;
}

function computeBurstLabel(f) {
  if (f.vol24_delta_5m >= Number(BURST_MIN_ABS_USD) && f.vol24_delta_rate * 100 >= Number(BURST_MIN_PCT))
    return `⚡ <b>Vol Burst:</b> +${fmtUsd(f.vol24_delta_5m)} (${fmtPct(f.vol24_delta_rate * 100)})\n`;
  return '';
}

function getRiskEmoji(risk) {
  return risk === 'low' ? '🟢' : risk === 'med' ? '🟡' : '🔴';
}

// ---------- TG OUTPUT ----------
function formatTrending(rows, aiMap, summary) {
  if (!rows.length)
    return `😴 <b>No trending pools right now</b>\n🕒 Chain is quiet — check back later. Total TXN 24h: ${fmtUsd(0)}`;

  const lines = [
    `🔥 <b>BESC HyperChain — AI Alpha Top ${rows.length}</b>`,
    `🕒 Last ${POLL_INTERVAL_MINUTES} min | 🚀 Movers First | 🤖 Multi-AI Scored | 📊 Enhanced Analytics\n`,
    `─────────────────`,
  ];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const a = r.pool.attributes;
    const f = r.feat;
    const ai = aiMap[f.address] || {};
    const icon = ai.prediction === 'bullish' ? '📈' : ai.prediction === 'bearish' ? '🔻' : ai.prediction === 'sideways' ? '➡️' : '❓';
    const riskIcon = getRiskEmoji(f.risk_level || ai.risk || 'med');
    const insightLine = ai.reason ? `💡 <i>${esc(ai.reason)}</i>\n` : '';
    const tagsLine = ai.tags?.length ? `🏷 <i>${esc(ai.tags.join(', '))}</i>\n` : '';
    const predictionLine = ai.prediction ? `${icon} <b>AI Pred (${ai.confidence?.toFixed(0)}% conf):</b> ${esc(ai.prediction.toUpperCase())}\n` : '';
    const momentumLine = f.vol24_delta_5m > (f.hist_avg || 0) * 0.05 ? '🔥 <b>Momentum Spike</b>\n' : '';
    const newPoolLine = f.age_min < Number(NEW_POOL_MAX_MIN) ? '🆕 <b>Fresh Launch</b>\n' : '';
    const trendLine = f.hist_trend ? `📈 <b>Trend:</b> ${fmtPct(f.hist_trend * 100)} | Volatility: ${f.hist_vola.toFixed(1)}%\n` : '';
    let pressure = '';
    if (f.buys24 > f.sells24 * 3) pressure = '🟢 <b>Heavy Buy Pressure</b>\n';
    else if (f.sells24 > f.buys24 * 3) pressure = '🔴 <b>Heavy Sell Pressure</b>\n';
    else if (f.buy_sell_ratio > 1.5) pressure = '🟢 <b>Buy Pressure</b>\n';
    const histLine = f.hist_avg
      ? `📊 <b>vs Hist Avg:</b> ${fmtPct(f.vol_vs_avg_pct)}\n`
      : '';
    lines.push(
      `${i + 1}️⃣ ${riskIcon} <b>${esc(a.name)}</b>\n${momentumLine}${newPoolLine}${computeBurstLabel(f)}${pressure}${insightLine}${tagsLine}${predictionLine}` +
        `💵 <b>Vol:</b> ${fmtUsd(f.vol24_now)} | 💧 <b>LQ:</b> ${fmtUsd(f.liq_usd)}\n` +
        `🏦 <b>FDV:</b> ${fmtUsd(f.fdv_usd)} | 🤖 <b>Score:</b> ${ai.score?.toFixed(1) || 'N/A'}/100 ${icon}\n` +
        `📈 <b>24h Chg:</b> ${fmtPct(Number(a.price_change_percentage?.h24 || 0))} | 👥 Buyers: ${f.buyers24}\n` +
        `${histLine}${trendLine}<a href="${esc(f.link)}">📊 GeckoTerminal</a>\n` +
        `─────────────────`
    );
  }

  if (summary) lines.push(`\n📊 <b>🤖 AI Market Insight:</b> <i>${esc(summary)}</i>`);

  lines.push(`\n<i>Powered by Multi-AI Consensus | DYOR 🚨</i>`);

  return lines.join('\n');
}

// ---------- MAIN ----------
async function postTrending() {
  try {
    errorCount = 0;
    const raw = await safeFetch(fetchAllPools);
    const candidates = raw.filter(isGoodPool);
    await checkNewPools(candidates);
    const feats = candidates.map(buildFeatures);
    for (const f of feats) updateHistory(f.address, f.vol24_now);

    const aiMap = await getAIScores(feats);
    const scored = feats
      .map((f) => {
        const aiScore = aiMap[f.address]?.score || 0;
        return {
          feat: f,
          pool: candidates.find((p) => p.attributes.address === f.address),
          final: baseHotness(f) + aiScore * Number(AI_WEIGHT),
        };
      })
      .sort((a, b) => b.final - a.final);

    const top = scored.slice(0, Number(TRENDING_SIZE));
    const summary = await getMarketSummary(top.map((t) => t.feat));

    const msg = await bot.sendMessage(
      TELEGRAM_CHAT_ID,
      formatTrending(top, aiMap, summary),
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );

    if (lastPinnedId) {
      await bot.unpinAllChatMessages(TELEGRAM_CHAT_ID).catch(() => {});
      await bot.deleteMessage(TELEGRAM_CHAT_ID, lastPinnedId).catch(() => {});
    }
    await bot.pinChatMessage(TELEGRAM_CHAT_ID, msg.message_id, {
      disable_notification: true,
    });
    lastPinnedId = msg.message_id;

    for (const c of candidates)
      lastVolumes.set(c.attributes.address, Number(c.attributes.volume_usd?.h24 || 0));

    console.log(`✅ Posted ${top.length} trending pools`);
  } catch (e) {
    errorCount++;
    console.error('[TrendingBot] Fail:', e.message);
    if (errorCount < 3) {
      await bot
        .sendMessage(
          TELEGRAM_CHAT_ID,
          `⚠️ <b>Bot Alert:</b> Fetch error, retrying... (${errorCount}/3)`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    } else {
      await bot
        .sendMessage(
          TELEGRAM_CHAT_ID,
          `🚨 <b>Critical:</b> Multiple errors. Check logs. Using last pinned.`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    }
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  fs.writeFileSync(RISK_FILE, JSON.stringify(riskCache, null, 2));
  process.exit(0);
});

console.log('✅ Elite AI-Powered BESC Trending Bot v9 — Unrivaled Alpha Engine running...');
setInterval(postTrending, Number(POLL_INTERVAL_MINUTES) * 60 * 1000);
postTrending();
