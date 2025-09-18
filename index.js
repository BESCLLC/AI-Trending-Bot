import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import fs from 'fs';

// ---------- ENV ----------
const {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MINUTES = '5',
  TRENDING_SIZE = '5',

  MIN_LIQ_USD = '5000',
  MIN_VOL24_USD = '1000',
  MIN_BUYS_24H = '3',

  BURST_MIN_ABS_USD = '1000',
  BURST_MIN_PCT = '1',

  NEW_POOL_MAX_MIN = '15',
  NEW_POOL_MIN_LIQ_USD = '5000',
  NEW_POOL_MIN_VOL24_USD = '1000',
  NEW_POOL_MIN_BUYERS = '5',
  NEW_ALERT_COOLDOWN_MIN = '60',

  OPENAI_API_KEY,
  AI_MODEL = 'gpt-4o-mini',
  AI_WEIGHT = '1500',
  AI_TIMEOUT_MS = '15000',

  CLAUDE_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-4-20250514',
  GROQ_API_KEY,
  GROQ_MODEL = 'llama-3.1-70b-versatile',

  HISTORY_FILE = './history.json',
  HISTORY_MAX_POINTS = '2016',
} = process.env;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID)
  throw new Error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');

const bot = new TelegramBot(TELEGRAM_TOKEN);
const GT_BASE = 'https://api.geckoterminal.com/api/v2';
const lastVolumes = new Map();
let lastPinnedId = null;

// ---------- HISTORY ----------
const history = fs.existsSync(HISTORY_FILE)
  ? JSON.parse(fs.readFileSync(HISTORY_FILE))
  : {};

function updateHistory(address, vol24) {
  if (!history[address]) history[address] = [];
  history[address].push({ t: Date.now(), v: vol24 });
  if (history[address].length > Number(HISTORY_MAX_POINTS))
    history[address].shift();
}

function getHistoryStats(address) {
  const arr = history[address] || [];
  if (!arr.length) return { avg: 0, min: 0, max: 0 };
  const avg = arr.reduce((a, b) => a + b.v, 0) / arr.length;
  const min = Math.min(...arr.map(x => x.v));
  const max = Math.max(...arr.map(x => x.v));
  return { avg, min, max };
}

// ---------- UTILS ----------
const fmtUsd = (n) => {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
};

const esc = (s = '') =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const nowMs = () => Date.now();

async function safeFetch(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      console.error(`[Retry] Attempt ${i + 1} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw new Error('All retries failed');
}

// ---------- FETCH POOLS ----------
async function fetchPoolsPage(page = 1) {
  const url = `${GT_BASE}/networks/besc-hyperchain/pools`;
  const { data } = await axios.get(url, {
    params: { sort: 'h24_volume_usd_desc', page },
    timeout: 15000,
  });
  return data?.data ?? [];
}

async function fetchAllPools() {
  const [p1, p2] = await Promise.allSettled([
    fetchPoolsPage(1),
    fetchPoolsPage(2),
  ]);
  const arr = [];
  if (p1.status === 'fulfilled') arr.push(...p1.value);
  if (p2.status === 'fulfilled') arr.push(...p2.value);
  return arr;
}

function isGoodPool(p) {
  const a = p.attributes || {};
  const liq = Number(a.reserve_in_usd || 0);
  const vol = Number(a.volume_usd?.h24 || 0);
  const buys = Number(a.transactions?.h24?.buys || 0);
  const ageMin = (nowMs() - new Date(a.pool_created_at).getTime()) / 60000;
  return liq >= MIN_LIQ_USD && vol >= MIN_VOL24_USD && buys >= MIN_BUYS_24H && ageMin >= 3;
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
    hist_min: histStats.min,
    hist_max: histStats.max,
    vol_vs_avg_pct: histStats.avg
      ? ((volNow - histStats.avg) / histStats.avg) * 100
      : 0,
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
    const payload = isClaude
      ? {
          model,
          max_tokens: isSummary ? 300 : 1024,
          messages: [
            {
              role: 'user',
              content: isSummary
                ? `Give me a 1-2 sentence market summary with risk level and trade outlook for these pools: ${JSON.stringify(items)}`
                : `Return ONLY valid JSON. For each pool return {"score":0-100,"risk":"low|med|high","tags":["..."],"reason":"short insight <15 words","prediction":"bullish|bearish|sideways","stop_loss":"recommended stop","take_profit":"recommended TP"}. Pools: ${JSON.stringify(items)}`,
            },
          ],
        }
      : {
          model,
          temperature: 0.2,
          response_format: isSummary ? undefined : { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: isSummary
                ? 'You are a crypto market analyst. Give actionable summary + risk sentiment.'
                : 'Return JSON {score,risk,tags,reason,prediction,stop_loss,take_profit}.',
            },
            { role: 'user', content: JSON.stringify(items) },
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
    merged[addr] = {
      score: avg,
      risk: openai.value?.[addr]?.risk || claude.value?.[addr]?.risk || 'med',
      tags: openai.value?.[addr]?.tags || claude.value?.[addr]?.tags || [],
      reason: openai.value?.[addr]?.reason || claude.value?.[addr]?.reason || '',
      prediction: openai.value?.[addr]?.prediction || claude.value?.[addr]?.prediction || '',
      stop_loss: openai.value?.[addr]?.stop_loss || claude.value?.[addr]?.stop_loss || '',
      take_profit: openai.value?.[addr]?.take_profit || claude.value?.[addr]?.take_profit || '',
      disagree: Math.max(...scores) - Math.min(...scores) > 30,
    };
  }
  return merged;
}

async function getMarketSummary(items) {
  if (!OPENAI_API_KEY) return '';
  return await aiScores(AI_MODEL, 'https://api.openai.com/v1/chat/completions', OPENAI_API_KEY, items, true);
}

// ---------- RANKING ----------
function baseHotness(f) {
  const burstBoost = Math.max(0, f.vol24_delta_5m) * 2;
  const buyerBoost = (f.buyers24 || 0) * 50;
  const recencyBonus = f.age_min < 360 ? 500 : 0;
  const sellPenalty = f.buy_sell_ratio < 0.5 ? f.vol24_now * 0.1 : 0;
  return f.vol24_now + burstBoost + buyerBoost + recencyBonus - sellPenalty;
}

function computeBurstLabel(f) {
  if (f.vol24_delta_5m >= Number(BURST_MIN_ABS_USD) && f.vol24_delta_rate * 100 >= Number(BURST_MIN_PCT))
    return `⚡ <b>Vol Burst:</b> +${fmtUsd(f.vol24_delta_5m)} (${(f.vol24_delta_rate * 100).toFixed(1)}%)\n`;
  return '';
}

// ---------- TG OUTPUT ----------
function formatTrending(rows, aiMap, summary) {
  if (!rows.length)
    return `😴 <b>No trending pools right now</b>\n🕒 Chain is quiet — check back later.`;

  const lines = [
    `🔥 <b>BESC HyperChain — AI Alpha Top ${rows.length}</b>`,
    `🕒 Last ${POLL_INTERVAL_MINUTES} min | 🚀 Movers First | 🤖 AI-Scored\n`,
  ];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const a = r.pool.attributes;
    const f = r.feat;
    const ai = aiMap[f.address] || {};
    const icon = ai.prediction === 'bullish' ? '🟢' : ai.prediction === 'bearish' ? '🔻' : ai.prediction === 'sideways' ? '⚪' : '';
    const riskIcon = ai.risk === 'low' ? '🟩' : ai.risk === 'high' ? '🟥' : '🟨';
    const stopLine = ai.stop_loss ? `🛑 Stop: <code>${esc(ai.stop_loss)}</code>\n` : '';
    const tpLine = ai.take_profit ? `🎯 TP: <code>${esc(ai.take_profit)}</code>\n` : '';
    const histLine = f.hist_avg ? `📊 <b>vs 7d Avg:</b> ${(f.vol_vs_avg_pct >= 0 ? '+' : '')}${f.vol_vs_avg_pct.toFixed(1)}%\n` : '';

    lines.push(
      `${i + 1}️⃣ <b>${esc(a.name)}</b> | ${riskIcon} Risk | AI: ${ai.score?.toFixed(1) || '0'}/100\n` +
      `${computeBurstLabel(f)}${icon} <b>${ai.prediction?.toUpperCase() || 'NEUTRAL'}</b> ${ai.reason ? `| 💡 ${esc(ai.reason)}` : ''}\n` +
      `💵 Vol: ${fmtUsd(f.vol24_now)} | 💧 LQ: ${fmtUsd(f.liq_usd)} | 🛒 Buys: ${f.buys24} / Sells: ${f.sells24}\n` +
      `🏦 FDV: ${fmtUsd(f.fdv_usd)} | 📈 24h: ${Number(a.price_change_percentage?.h24 || 0).toFixed(2)}%\n` +
      `${stopLine}${tpLine}${histLine}<a href="${esc(f.link)}">📊 View Pool</a>\n`
    );
  }

  if (summary) lines.push(`\n📊 <b>AI Market Take:</b> <i>${esc(summary)}</i>`);

  return lines.join('\n');
}

// ---------- MAIN ----------
async function postTrending() {
  try {
    const raw = await safeFetch(fetchAllPools);
    const candidates = raw.filter(isGoodPool);
    const feats = candidates.map(buildFeatures);
    for (const f of feats) updateHistory(f.address, f.vol24_now);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

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
  } catch (e) {
    console.error('[TrendingBot] Fail:', e.message);
    await bot
      .sendMessage(
        TELEGRAM_CHAT_ID,
        `⚠️ <b>Trending Bot Alert:</b> API unavailable. Using last pinned snapshot.`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  }
}

console.log('✅ AI-Powered BESC Trending Bot v8 running...');
setInterval(postTrending, Number(POLL_INTERVAL_MINUTES) * 60 * 1000);
postTrending();
