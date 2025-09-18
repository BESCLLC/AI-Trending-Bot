import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import fs from 'fs';

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
  if (!arr.length) return { avg: 0 };
  const avg = arr.reduce((a, b) => a + b.v, 0) / arr.length;
  return { avg };
}

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

async function fetchPoolsPage(page = 1) {
  const url = `${GT_BASE}/networks/besc-hyperchain/pools`;
  const { data } = await axios.get(url, {
    params: { sort: 'h24_volume_usd_desc', page },
    timeout: 15000,
  });
  return data?.data ?? [];
}

async function fetchAllPools() {
  const [p1, p2] = await Promise.allSettled([fetchPoolsPage(1), fetchPoolsPage(2)]);
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
  const liq = Number(a.reserve_in_usd || 0);
  const fdv = Number(a.market_cap_usd || a.fdv_usd || 0);
  const buys = Number(a.transactions?.h24?.buys || 0);
  const sells = Number(a.transactions?.h24?.sells || 0);
  const histStats = getHistoryStats(a.address);
  return {
    address: a.address,
    name: a.name,
    liq_usd: liq,
    fdv_usd: fdv,
    vol24_now: volNow,
    vol24_delta_5m: delta,
    buys24: buys,
    sells24: sells,
    hist_avg: histStats.avg,
    vol_vs_avg_pct: histStats.avg ? ((volNow - histStats.avg) / histStats.avg) * 100 : 0,
    link: `https://www.geckoterminal.com/besc-hyperchain/pools/${a.address}`,
  };
}

// ---------- AI SCORING ----------
function cleanJsonString(raw) {
  if (!raw) return '{}';
  const match = raw.match(/\{[\s\S]*\}/);
  return match ? match[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']') : '{}';
}

async function aiScores(model, endpoint, key, items) {
  try {
    const payload = endpoint.includes('anthropic')
      ? {
          model,
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: `Return ONLY valid JSON. For each pool return {"score":0-100,"risk":"low|med|high","reason":"<15 words","prediction":"bullish|bearish|sideways"}. Pools: ${JSON.stringify(items)}`
          }],
        }
      : {
          model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'Return valid JSON only, no text outside JSON.' },
            { role: 'user', content: JSON.stringify(items) },
          ],
        };
    const headers = endpoint.includes('anthropic')
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
      : { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };

    const { data } = await axios.post(endpoint, payload, { headers, timeout: Number(AI_TIMEOUT_MS) });
    let raw = endpoint.includes('anthropic') ? data.content?.[0]?.text : data.choices?.[0]?.message?.content;
    raw = cleanJsonString(raw);
    return JSON.parse(raw || '{}');
  } catch (e) {
    console.error(`[AI/${model}] fail:`, e.message);
    return {};
  }
}

async function getAIScores(items) {
  const results = await Promise.allSettled([
    OPENAI_API_KEY ? aiScores(AI_MODEL, 'https://api.openai.com/v1/chat/completions', OPENAI_API_KEY, items) : {},
    CLAUDE_API_KEY ? aiScores(CLAUDE_MODEL, 'https://api.anthropic.com/v1/messages', CLAUDE_API_KEY, items) : {},
    GROQ_API_KEY ? aiScores(GROQ_MODEL, 'https://api.groq.com/openai/v1/chat/completions', GROQ_API_KEY, items) : {},
  ]);

  const merged = {};
  for (const it of items) {
    const addr = it.address;
    const vals = results.map(r => r.value?.[addr]).filter(Boolean);
    const scores = vals.map(v => v.score).filter(n => typeof n === 'number');
    const avg = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : 50;
    merged[addr] = {
      score: avg,
      risk: vals.find(v => v.risk)?.risk || 'med',
      reason: vals.find(v => v.reason)?.reason || '',
      prediction: vals.find(v => v.prediction)?.prediction || '',
    };
  }
  return merged;
}

// ---------- OUTPUT ----------
function formatTrending(rows, aiMap) {
  const header = `🔥 <b>BESC HyperChain — AI Alpha Top ${rows.length}</b>\n🕒 Last ${POLL_INTERVAL_MINUTES} min | 🚀 Movers First | 🤖 AI-Scored\n`;
  const chunks = [];
  let current = header;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const a = r.pool.attributes; const f = r.feat;
    const ai = aiMap[f.address] || {};
    const block =
      `${i+1}️⃣ <b>${esc(a.name)}</b>\n` +
      `💵 Vol: ${fmtUsd(f.vol24_now)} | 💧 LQ: ${fmtUsd(f.liq_usd)} | 🛒 Buys: ${f.buys24}/Sells: ${f.sells24}\n` +
      `🏦 FDV: ${fmtUsd(f.fdv_usd)} | 🤖 ${ai.score?.toFixed(1) || 50}/100 | ${ai.prediction ? `📈 ${ai.prediction.toUpperCase()}` : ''}\n` +
      `${ai.reason ? `💡 ${esc(ai.reason)}\n` : ''}<a href="${esc(f.link)}">📊 View</a>\n\n`;

    if ((current + block).length > 3800) { // prevent Telegram 4096 limit
      chunks.push(current);
      current = '';
    }
    current += block;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function postTrending() {
  try {
    const raw = await safeFetch(fetchAllPools);
    const candidates = raw.filter(isGoodPool);
    const feats = candidates.map(buildFeatures);
    for (const f of feats) updateHistory(f.address, f.vol24_now);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

    const aiMap = await getAIScores(feats);
    const scored = feats.map(f => ({
      feat: f,
      pool: candidates.find(p => p.attributes.address === f.address),
      final: f.vol24_now + (aiMap[f.address]?.score || 50) * Number(AI_WEIGHT),
    })).sort((a,b) => b.final - a.final);

    const top = scored.slice(0, Number(TRENDING_SIZE));
    const chunks = formatTrending(top, aiMap);

    // send first chunk & pin
    const msg = await bot.sendMessage(TELEGRAM_CHAT_ID, chunks[0], { parse_mode: 'HTML', disable_web_page_preview: true });
    if (lastPinnedId) {
      await bot.unpinAllChatMessages(TELEGRAM_CHAT_ID).catch(()=>{});
      await bot.deleteMessage(TELEGRAM_CHAT_ID, lastPinnedId).catch(()=>{});
    }
    await bot.pinChatMessage(TELEGRAM_CHAT_ID, msg.message_id, { disable_notification: true });
    lastPinnedId = msg.message_id;

    // send any remaining chunks
    for (let i = 1; i < chunks.length; i++) {
      await bot.sendMessage(TELEGRAM_CHAT_ID, chunks[i], { parse_mode: 'HTML', disable_web_page_preview: true });
    }

    for (const c of candidates)
      lastVolumes.set(c.attributes.address, Number(c.attributes.volume_usd?.h24 || 0));
  } catch (e) {
    console.error('[TrendingBot] Fail:', e.message);
  }
}

console.log('✅ AI-Powered BESC Trending Bot v10 running...');
setInterval(postTrending, Number(POLL_INTERVAL_MINUTES) * 60 * 1000);
postTrending();
