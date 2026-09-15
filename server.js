import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { ChzzkClient } from 'chzzk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const CHANNEL_IDS = String(process.env.CHZZK_CHANNEL_IDS || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);
const SHEET_WEBAPP_URL = String(process.env.SHEET_WEBAPP_URL || '').trim();
const SHEET_POLL_MS = Math.max(1000, Number(process.env.SHEET_POLL_MS || 1800));
const PARTY_DEBUG_LOG = String(process.env.PARTY_DEBUG_LOG || 'true').toLowerCase() === 'true';

const TYPECAST_API_KEY = String(process.env.TYPECAST_API_KEY || '').trim();
const TYPECAST_VOICE_ID = String(process.env.TYPECAST_VOICE_ID || '').trim();
const TYPECAST_MODEL = String(process.env.TYPECAST_MODEL || 'ssfm-v30');
const TYPECAST_LANGUAGE = String(process.env.TYPECAST_LANGUAGE || 'kor');
const TYPECAST_TEMPO = clamp(Number(process.env.TYPECAST_TEMPO || 1), 0.5, 2);
const TYPECAST_TARGET_LUFS = clamp(Number(process.env.TYPECAST_TARGET_LUFS || -14), -70, 0);
const TYPECAST_MAX_CHARS = Math.max(1, Math.min(2000, Number(process.env.TYPECAST_MAX_CHARS || 300)));
const TTS_READ_DONOR = String(process.env.TTS_READ_DONOR || 'false').toLowerCase() === 'true';
const TTS_READ_AMOUNT = String(process.env.TTS_READ_AMOUNT || 'false').toLowerCase() === 'true';

// Typecast attribution: user supplied the integration prompt from the API page.
// Keep these stable in generated code / persistent configuration.
const TYPECAST_INTEGRATION_SOURCE = 'api-page';
const TYPECAST_GENERATED_BY = 'chatgpt';
const TYPECAST_USER_AGENT = `typecast-direct/1 undici typecast-integration/1 (source=${TYPECAST_INTEGRATION_SOURCE}; generated_by=${TYPECAST_GENERATED_BY})`;

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, { transports: ['websocket', 'polling'] });
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const state = {
  startedAt: Date.now(),
  chzzk: new Map(),
  sheet: null,
  sheetError: null,
  lastParty: null,
  lastTtsError: null,
  ttsQueueLength: 0,
  overlayClients: 0,
};

// ---------- Public pages ----------
app.get('/', (_req, res) => res.redirect('/control'));
app.get('/overlay', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/control', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'control.html')));
app.get('/health', (_req, res) => res.json({ ok: true, uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000) }));

app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    publicBaseUrl: PUBLIC_BASE_URL,
    overlayUrl: `${PUBLIC_BASE_URL || ''}/overlay`,
    configuredChannels: CHANNEL_IDS.length,
    channels: [...state.chzzk.entries()].map(([id, v]) => ({ id, ...v })),
    typecast: {
      configured: Boolean(TYPECAST_API_KEY && TYPECAST_VOICE_ID),
      voiceId: TYPECAST_VOICE_ID || null,
      model: TYPECAST_MODEL,
      language: TYPECAST_LANGUAGE,
      attribution: { source: TYPECAST_INTEGRATION_SOURCE, generated_by: TYPECAST_GENERATED_BY },
    },
    sheet: { configured: Boolean(SHEET_WEBAPP_URL), error: state.sheetError },
    overlayClients: state.overlayClients,
    lastParty: state.lastParty,
    lastTtsError: state.lastTtsError,
    ttsQueueLength: state.ttsQueueLength,
  });
});

// ---------- Fine counter proxy ----------
app.get('/api/fine', (_req, res) => {
  if (!SHEET_WEBAPP_URL) return res.status(503).json({ ok: false, error: 'SHEET_WEBAPP_URL이 설정되지 않았습니다.' });
  if (!state.sheet) return res.status(503).json({ ok: false, error: state.sheetError || '시트를 아직 불러오는 중입니다.' });
  res.json({ ok: true, data: state.sheet });
});

for (const [route, action] of [
  ['/api/fine/adjust', 'adjust'],
  ['/api/fine/set', 'set'],
  ['/api/fine/reset', 'reset'],
  ['/api/fine/config', 'config'],
]) {
  app.post(route, async (req, res) => {
    try {
      const data = await postSheet({ action, ...req.body });
      updateSheetState(data, true);
      res.json({ ok: true, data });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });
}

// ---------- TTS test ----------
app.post('/api/tts/test', async (req, res) => {
  try {
    const text = normalizeTtsText(String(req.body?.text || '파티 후원 TTS 테스트입니다.'));
    if (!text) throw new Error('읽을 텍스트가 없습니다.');
    const event = {
      id: `test-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      source: 'test',
      streamerChannelId: 'test',
      nickname: '테스트',
      amount: 0,
      message: text,
      receivedAt: Date.now(),
    };
    await enqueueTts(event, true);
    res.json({ ok: true, played: event.id });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message || String(err) });
  }
});

// ---------- Shared streaming audio fan-out ----------
const audioStreams = new Map();

app.get('/audio/live/:id.mp3', (req, res) => {
  const item = audioStreams.get(req.params.id);
  if (!item) return res.status(404).end('not found');

  res.status(200);
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders?.();

  for (const chunk of item.chunks) res.write(chunk);
  if (item.done) return res.end();

  item.subscribers.add(res);
  req.on('close', () => item.subscribers.delete(res));
});

// ---------- Socket clients ----------
io.on('connection', socket => {
  state.overlayClients += 1;
  socket.emit('fine_update', state.sheet);
  socket.emit('server_status', buildSocketStatus());

  socket.on('disconnect', () => {
    state.overlayClients = Math.max(0, state.overlayClients - 1);
  });
});

function buildSocketStatus() {
  return {
    typecastConfigured: Boolean(TYPECAST_API_KEY && TYPECAST_VOICE_ID),
    configuredChannels: CHANNEL_IDS.length,
    sheetConfigured: Boolean(SHEET_WEBAPP_URL),
  };
}

// ---------- Google Sheet polling ----------
async function parseSheetJsonResponse(response) {
  const text = await response.text();
  if (!response.ok) throw new Error(`Sheets HTTP ${response.status}`);
  try {
    return JSON.parse(text);
  } catch {
    const ct = String(response.headers.get('content-type') || '');
    const preview = text.trim().slice(0, 80).replace(/\s+/g, ' ');
    if (/<!doctype|<html/i.test(text) || ct.includes('text/html')) {
      throw new Error('Apps Script가 JSON 대신 HTML을 반환했습니다. Code.gs를 v5.1용으로 교체한 뒤 setup() 실행 → 배포 관리에서 새 버전으로 재배포하고, 웹 앱 접근 권한을 "모든 사용자"로 설정하세요.');
    }
    throw new Error(`Apps Script JSON 해석 실패: ${preview || '빈 응답'}`);
  }
}

async function fetchSheet() {
  if (!SHEET_WEBAPP_URL) return;
  try {
    const response = await fetch(`${SHEET_WEBAPP_URL}${SHEET_WEBAPP_URL.includes('?') ? '&' : '?'}_=${Date.now()}`, {
      headers: { 'User-Agent': 'chzzk-party-tts/5.1 sheet-poller' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    const body = await parseSheetJsonResponse(response);
    if (!body?.ok) throw new Error(body?.error || 'Apps Script 응답 오류');
    state.sheetError = null;
    updateSheetState(body.data, false);
  } catch (err) {
    state.sheetError = err.message || String(err);
  }
}

async function postSheet(payload) {
  if (!SHEET_WEBAPP_URL) throw new Error('SHEET_WEBAPP_URL이 설정되지 않았습니다.');
  const response = await fetch(SHEET_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'chzzk-party-tts/5.1 sheet-control' },
    body: JSON.stringify(payload),
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
  });
  const body = await parseSheetJsonResponse(response);
  if (!body?.ok) throw new Error(body?.error || 'Apps Script 응답 오류');
  return body.data;
}

function updateSheetState(data, force) {
  if (!data) return;
  const old = state.sheet;
  const changed = force || JSON.stringify(old) !== JSON.stringify(data);
  state.sheet = data;
  if (changed) io.emit('fine_update', data);
}

if (SHEET_WEBAPP_URL) {
  fetchSheet();
  setInterval(fetchSheet, SHEET_POLL_MS).unref();
}

// ---------- CHZZK PARTY detector ----------
const seenParty = new Map();
const chzzkClient = new ChzzkClient();

for (const channelId of CHANNEL_IDS) startChannel(channelId);

async function startChannel(channelId) {
  state.chzzk.set(channelId, { status: 'connecting', lastEventAt: null, error: null });
  const chat = chzzkClient.chat({ channelId, pollInterval: 30_000 });

  chat.on('connect', chatChannelId => {
    state.chzzk.set(channelId, { status: 'connected', chatChannelId, lastEventAt: Date.now(), error: null });
    console.log(`[CHZZK] connected ${channelId} -> ${chatChannelId}`);
  });

  chat.on('reconnect', chatChannelId => {
    state.chzzk.set(channelId, { status: 'reconnected', chatChannelId, lastEventAt: Date.now(), error: null });
    console.log(`[CHZZK] reconnected ${channelId} -> ${chatChannelId}`);
  });

  chat.on('raw', raw => {
    try {
      const parties = findPartyCandidates(raw);
      for (const candidate of parties) handlePartyCandidate(channelId, candidate, raw);
    } catch (err) {
      console.error('[CHZZK] raw parse error', channelId, err);
    }
  });

  // 미래 라이브러리 버전에서 PARTY가 donation 이벤트로 매핑될 가능성도 대비합니다.
  chat.on('donation', donation => {
    try {
      const extras = parseObject(donation?.extras) || donation?.extras || {};
      const donationType = String(extras?.donationType || '').toUpperCase();
      const type = Number(donation?.type ?? donation?.msgTypeCode ?? extras?.type);
      if (donationType === 'PARTY' || type === 13) handlePartyCandidate(channelId, donation, donation);
    } catch {}
  });

  try {
    await chat.connect();
  } catch (err) {
    const message = err?.message || String(err);
    state.chzzk.set(channelId, { status: 'error', lastEventAt: Date.now(), error: message });
    console.error(`[CHZZK] connect failed ${channelId}: ${message}`);
    setTimeout(() => startChannel(channelId), 15_000).unref();
  }
}

function findPartyCandidates(raw) {
  const found = [];
  const visited = new Set();

  const walk = (value, depth = 0) => {
    if (depth > 12 || value == null) return;
    if (typeof value === 'string') {
      const parsed = parseObject(value);
      if (parsed) walk(parsed, depth + 1);
      return;
    }
    if (typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }

    const rawType = value.msgTypeCode ?? value.messageTypeCode ?? value.chatTypeCode ?? value.type;
    const numericType = Number(rawType);
    const textType = String(rawType ?? '').toUpperCase();
    if (numericType === 13 || textType === 'PARTY') found.push(value);

    for (const v of Object.values(value)) walk(v, depth + 1);
  };

  walk(raw);
  return found;
}

function handlePartyCandidate(streamerChannelId, candidate, rawPacket) {
  const event = parsePartyEvent(streamerChannelId, candidate);
  if (!event) {
    if (PARTY_DEBUG_LOG) logPartyRaw(streamerChannelId, rawPacket, 'unparsed-type-13');
    return;
  }

  if (PARTY_DEBUG_LOG) logPartyRaw(streamerChannelId, rawPacket, 'party');

  const key = partyDedupeKey(event);
  cleanupSeen();
  if (seenParty.has(key)) return;
  seenParty.set(key, Date.now());

  state.lastParty = event;
  const channelState = state.chzzk.get(streamerChannelId) || {};
  state.chzzk.set(streamerChannelId, { ...channelState, lastEventAt: Date.now() });
  console.log(`[PARTY] ${event.nickname || '-'} ${event.amount || 0}: ${event.message}`);

  if (event.message) enqueueTts(event);
}

function parsePartyEvent(streamerChannelId, node) {
  const extras = parseObject(node?.extras) || (typeof node?.extras === 'object' ? node.extras : {}) || {};
  const profile = parseObject(node?.profile) || (typeof node?.profile === 'object' ? node.profile : {}) || {};

  const message = firstString([
    node?.msg,
    node?.message,
    node?.content,
    node?.text,
    node?.donationText,
    extras?.message,
    extras?.msg,
    extras?.content,
    extras?.text,
    extras?.donationText,
  ]);

  const nickname = firstString([
    profile?.nickname,
    extras?.nickname,
    extras?.donatorNickname,
    extras?.userNickname,
    node?.nickname,
    node?.donatorNickname,
  ]) || '익명의 후원자';

  const amountRaw = extras?.payAmount ?? extras?.amount ?? node?.payAmount ?? node?.amount ?? 0;
  const amount = Number(String(amountRaw).replace(/[^0-9.-]/g, '')) || 0;
  const timeRaw = node?.msgTime ?? node?.messageTime ?? node?.createdAt ?? node?.ctime ?? extras?.msgTime ?? extras?.messageTime ?? Date.now();
  const receivedAt = normalizeTime(timeRaw);
  const explicitId = firstString([
    node?.messageId,
    node?.msgId,
    node?.id,
    extras?.messageId,
    extras?.msgId,
    extras?.transactionId,
    extras?.donationId,
  ]);

  if (!message) return null;
  return {
    id: explicitId || `party-${receivedAt}-${crypto.randomBytes(2).toString('hex')}`,
    source: 'chzzk-party',
    streamerChannelId,
    nickname,
    amount,
    message: String(message).trim(),
    receivedAt,
    explicitId: explicitId || null,
  };
}

function partyDedupeKey(event) {
  if (event.explicitId) return `id:${event.explicitId}`;
  // 동일 파티 알림이 8개 채널에 거의 동시에 전달되는 것을 하나로 합칩니다.
  // 2초 버킷은 채널별 전달 지연 차이를 흡수합니다.
  const timeBucket = Math.floor((event.receivedAt || Date.now()) / 2000);
  const base = `${event.nickname}|${event.amount}|${event.message}|${timeBucket}`;
  return crypto.createHash('sha1').update(base).digest('hex');
}

function cleanupSeen() {
  const cutoff = Date.now() - 30_000;
  for (const [key, at] of seenParty) if (at < cutoff) seenParty.delete(key);
}

function logPartyRaw(channelId, raw, kind) {
  try {
    fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
    fs.appendFileSync(
      path.join(__dirname, 'logs', 'party-raw.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), kind, channelId, raw }) + '\n',
      'utf8'
    );
  } catch {}
}

// ---------- TTS queue + Typecast streaming ----------
const ttsQueue = [];
let ttsBusy = false;

function enqueueTts(event, wait = false) {
  const text = buildTtsText(event);
  if (!text) return wait ? Promise.reject(new Error('읽을 텍스트가 없습니다.')) : Promise.resolve();
  let resolveJob, rejectJob;
  const promise = new Promise((resolve, reject) => { resolveJob = resolve; rejectJob = reject; });
  ttsQueue.push({ event: { ...event, ttsText: text }, resolveJob, rejectJob });
  state.ttsQueueLength = ttsQueue.length;
  pumpTtsQueue();
  if (wait) return promise;
  promise.catch(() => {});
  return promise;
}

async function pumpTtsQueue() {
  if (ttsBusy) return;
  ttsBusy = true;
  try {
    while (ttsQueue.length) {
      const job = ttsQueue.shift();
      const event = job.event;
      state.ttsQueueLength = ttsQueue.length;
      try {
        await createAndBroadcastTts(event);
        state.lastTtsError = null;
        job.resolveJob({ ok: true });
      } catch (err) {
        state.lastTtsError = err?.message || String(err);
        console.error('[TTS]', state.lastTtsError);
        io.emit('tts_error', { message: state.lastTtsError, eventId: event.id });
        job.rejectJob(err);
      }
    }
  } finally {
    ttsBusy = false;
  }
}

async function createAndBroadcastTts(event) {
  if (!TYPECAST_API_KEY) throw new Error('TYPECAST_API_KEY가 설정되지 않았습니다.');
  if (!TYPECAST_VOICE_ID) throw new Error('TYPECAST_VOICE_ID가 설정되지 않았습니다.');

  const audioId = `tts-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const streamItem = { chunks: [], subscribers: new Set(), done: false, createdAt: Date.now() };
  audioStreams.set(audioId, streamItem);

  const payload = {
    model: TYPECAST_MODEL,
    voice_id: TYPECAST_VOICE_ID,
    text: event.ttsText,
    language: TYPECAST_LANGUAGE,
    output: {
      audio_format: 'mp3',
      audio_tempo: TYPECAST_TEMPO,
      target_lufs: TYPECAST_TARGET_LUFS,
    },
  };

  const upstream = await fetch('https://api.typecast.ai/v1/text-to-speech/stream', {
    method: 'POST',
    headers: {
      'X-API-KEY': TYPECAST_API_KEY,
      'Content-Type': 'application/json',
      'User-Agent': TYPECAST_USER_AGENT,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });

  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 500);
    audioStreams.delete(audioId);
    throw new Error(`Typecast ${upstream.status}: ${detail}`);
  }
  if (!upstream.body) {
    audioStreams.delete(audioId);
    throw new Error('Typecast 스트리밍 응답 body가 없습니다.');
  }

  // URL을 먼저 방송해서 OBS가 스트림에 붙도록 합니다.
  io.emit('party_tts', {
    id: event.id,
    audioId,
    audioUrl: `/audio/live/${audioId}.mp3`,
    nickname: event.nickname,
    amount: event.amount,
    message: event.message,
    streamerChannelId: event.streamerChannelId,
    receivedAt: event.receivedAt,
    text: event.ttsText,
  });

  try {
    for await (const chunkLike of upstream.body) {
      const chunk = Buffer.from(chunkLike);
      streamItem.chunks.push(chunk);
      for (const sub of [...streamItem.subscribers]) {
        try { sub.write(chunk); }
        catch { streamItem.subscribers.delete(sub); }
      }
    }
  } finally {
    streamItem.done = true;
    for (const sub of [...streamItem.subscribers]) {
      try { sub.end(); } catch {}
    }
    streamItem.subscribers.clear();
    setTimeout(() => audioStreams.delete(audioId), 5 * 60_000).unref();
  }
}

function buildTtsText(event) {
  const parts = [];
  if (TTS_READ_DONOR && event.nickname) parts.push(`${event.nickname}님`);
  if (TTS_READ_AMOUNT && event.amount > 0) parts.push(`${event.amount.toLocaleString('ko-KR')}원`);
  parts.push(event.message || '');
  return normalizeTtsText(parts.join(', '));
}

function normalizeTtsText(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, ' 링크 ')
    .replace(/www\.\S+/gi, ' 링크 ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TYPECAST_MAX_CHARS);
}

function parseObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || (!s.startsWith('{') && !s.startsWith('['))) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function normalizeTime(value) {
  const n = Number(value);
  if (Number.isFinite(n)) {
    if (n > 1e12) return Math.floor(n);
    if (n > 1e9) return Math.floor(n * 1000);
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function clamp(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

httpServer.listen(PORT, () => {
  console.log(`\nCHZZK Party TTS + Fineboard v5.1`);
  console.log(`Control : http://localhost:${PORT}/control`);
  console.log(`Overlay : http://localhost:${PORT}/overlay`);
  console.log(`Channels: ${CHANNEL_IDS.length}`);
  console.log(`Typecast: ${TYPECAST_API_KEY && TYPECAST_VOICE_ID ? 'configured' : 'NOT configured'}`);
  console.log(`Sheets  : ${SHEET_WEBAPP_URL ? 'configured' : 'NOT configured'}\n`);
});
