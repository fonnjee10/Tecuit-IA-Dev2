'use strict';
require('dotenv').config();

const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const { execFile } = require('child_process');
const fetch      = require('node-fetch');
const cheerio    = require('cheerio');

const app = express();

// ── CONFIG ────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT || '3000', 10);
const HERMES_URL  = (process.env.HERMES_URL || '').replace(/\/$/, '');
const KIWIX_URL   = (process.env.KIWIX_URL  || 'http://localhost:8080').replace(/\/$/, '');
const KIWIX_BOOK  = process.env.KIWIX_BOOK_ID || '';
const PIPER_BIN   = process.env.PIPER_BIN   || '';
const PIPER_VOICE = process.env.PIPER_VOICE || './voices/fr_FR-upmc-pierre-medium.onnx';

const TMP_DIR = path.join(os.tmpdir(), 'tecuit_tts');
fs.mkdirSync(TMP_DIR, { recursive: true });

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── UTILITY ──────────────────────────────────────────────────
function withTimeout(promise, ms = 6000) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout after ${ms}ms`)), ms))
  ]);
}

function sseWrite(res, obj) {
  if (!res.headersSent) return;
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// ── WEB SEARCH — DuckDuckGo ───────────────────────────────────
async function webSearch(query, maxResults = 5) {
  const results = [];

  // — Instant Answer API
  try {
    const url  = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&kl=fr-fr`;
    const data = await withTimeout(
      fetch(url, { headers: { 'User-Agent': 'TecuitIA/2.0' } }).then(r => r.json()),
      5000
    );
    if (data.AbstractText) {
      results.push({
        title:   data.Heading || 'Résumé',
        snippet: data.AbstractText.slice(0, 450),
        url:     data.AbstractURL || data.AbstractSource || ''
      });
    }
    for (const topic of (data.RelatedTopics || []).slice(0, 6)) {
      if (results.length >= maxResults) break;
      if (topic.Text && topic.FirstURL) {
        results.push({
          title:   topic.Text.split(' - ')[0].slice(0, 100),
          snippet: topic.Text.slice(0, 360),
          url:     topic.FirstURL
        });
      }
    }
  } catch (e) {
    console.warn('[DDG-IA]', e.message);
  }

  // — HTML scrape fallback
  if (results.length < 3) {
    try {
      const html = await withTimeout(
        fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=fr-fr`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120' }
        }).then(r => r.text()),
        7000
      );
      const $ = cheerio.load(html);
      $('.result').each((_, el) => {
        if (results.length >= maxResults) return false;
        const title   = $(el).find('.result__a').text().trim();
        const snippet = $(el).find('.result__snippet').text().trim();
        const href    = $(el).find('.result__a').attr('href') || '';
        if (title && snippet) results.push({ title, snippet, url: href });
      });
    } catch (e) {
      console.warn('[DDG-HTML]', e.message);
    }
  }

  return results.slice(0, maxResults);
}

// ── KIWIX / WIKIPEDIA ─────────────────────────────────────────
let _kiwixBookCache = '';

async function detectKiwixBook() {
  if (KIWIX_BOOK)       return KIWIX_BOOK;
  if (_kiwixBookCache)  return _kiwixBookCache;
  try {
    const text = await withTimeout(fetch(`${KIWIX_URL}/catalog/entries?count=50`).then(r => r.text()), 3000);
    const m    = text.match(/path="([^"]*wikipedia[^"]*)"/i) || text.match(/id="([^"]*wikipedia[^"]*)"/i);
    if (m) { _kiwixBookCache = m[1].split('/')[0]; return _kiwixBookCache; }
  } catch {}
  return '';
}

async function wikiSearch(query, maxResults = 3) {
  const book = await detectKiwixBook();
  const sugUrl = book
    ? `${KIWIX_URL}/suggest?pattern=${encodeURIComponent(query)}&books=${encodeURIComponent(book)}&count=${maxResults + 3}`
    : `${KIWIX_URL}/suggest?pattern=${encodeURIComponent(query)}&count=${maxResults + 3}`;

  let suggestions = [];
  try {
    const raw = await withTimeout(fetch(sugUrl, { headers: { Accept: 'application/json' } }).then(r => r.json()), 4000);
    if (Array.isArray(raw)) suggestions = raw.map(s => (typeof s === 'string' ? { value: s, label: s } : s));
  } catch (e) {
    console.warn('[Kiwix-suggest]', e.message);
    return [];
  }

  const articles = [];
  for (const sug of suggestions.slice(0, maxResults)) {
    try {
      const articlePath = sug.value || sug.path || '';
      const articleUrl  = articlePath.startsWith('http') ? articlePath : `${KIWIX_URL}/${articlePath}`;
      const html = await withTimeout(fetch(articleUrl).then(r => r.text()), 5000);
      const $ = cheerio.load(html);

      $('table, .reflist, .references, .navbox, #toc, .thumb, .gallery, [role="navigation"], .mw-editsection, .noprint').remove();

      let content = '';
      $('p').each((_, el) => {
        if (content.length > 1800) return false;
        const txt = $(el).text().replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim();
        if (txt.length > 50) content += txt + '\n\n';
      });

      const title = sug.label || $('h1').first().text().trim() || sug.value;
      if (content.trim()) articles.push({ title, content: content.trim().slice(0, 1800), url: articleUrl });
    } catch (e) {
      console.warn('[Kiwix-article]', e.message);
    }
  }
  return articles;
}

// ── TTS — Piper ───────────────────────────────────────────────
function hasPiper() {
  return PIPER_BIN && fs.existsSync(PIPER_BIN) && fs.existsSync(PIPER_VOICE);
}

async function piperTTS(text) {
  if (!hasPiper()) throw new Error('Piper non configuré');
  const outFile = path.join(TMP_DIR, `tts_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
  await new Promise((resolve, reject) => {
    const proc = execFile(PIPER_BIN, ['--model', PIPER_VOICE, '--output_file', outFile], { timeout: 15000 });
    proc.stdin.on('error', () => {});
    proc.stdin.write(text);
    proc.stdin.end();
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(outFile)) resolve();
      else reject(new Error(`Piper exit ${code}`));
    });
    proc.on('error', reject);
  });
  return outFile;
}

// ── ROUTES ────────────────────────────────────────────────────

// Status
app.get('/api/status', async (req, res) => {
  const s = { hermes: false, kiwix: false, kiwixBook: '', piper: hasPiper() };
  try {
    const r = await withTimeout(fetch(`${HERMES_URL}/health`), 3000);
    s.hermes = r.ok || r.status < 500;
  } catch {}
  try {
    const r = await withTimeout(fetch(KIWIX_URL), 2500);
    s.kiwix = r.ok;
    if (s.kiwix) s.kiwixBook = (await detectKiwixBook()) || '';
  } catch {}
  res.json(s);
});

// Web search
app.get('/api/search', async (req, res) => {
  if (!req.query.q) return res.status(400).json({ error: 'Missing ?q' });
  try { res.json(await webSearch(req.query.q)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Wiki search
app.get('/api/wiki', async (req, res) => {
  if (!req.query.q) return res.status(400).json({ error: 'Missing ?q' });
  try { res.json(await wikiSearch(req.query.q)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// TTS
app.post('/api/tts', async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Missing text' });
  if (!hasPiper()) return res.status(503).json({ error: 'Piper non disponible — utiliser TTS navigateur' });

  // Nettoyage du texte pour la synthèse
  const clean = text
    .replace(/```[\s\S]*?```/g, 'bloc de code.')
    .replace(/`[^`]+`/g, '')
    .replace(/#{1,6}\s/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*+]\s/gm, '')
    .replace(/^\s*\d+\.\s/gm, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);

  let outFile;
  try {
    outFile = await piperTTS(clean);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on('close', () => fs.unlink(outFile, () => {}));
  } catch (e) {
    console.error('[TTS]', e.message);
    if (outFile) fs.unlink(outFile, () => {});
    res.status(500).json({ error: e.message });
  }
});

// Chat — SSE streaming
app.post('/api/chat', async (req, res) => {
  const { messages = [], model = 'Hermes 7B', useWeb = false, useWiki = false } = req.body || {};

  if (!HERMES_URL) {
    return res.status(500).json({ error: 'HERMES_URL manquant dans .env' });
  }

  // SSE setup
  res.setHeader('Content-Type',       'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control',      'no-cache');
  res.setHeader('Connection',         'keep-alive');
  res.setHeader('X-Accel-Buffering',  'no');
  res.setHeader('Transfer-Encoding',  'chunked');
  res.flushHeaders();

  const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const today    = new Date().toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  let systemPrompt = `Tu es Tecuit IA, un assistant intelligent développé par Zenkari Labs. Tu réponds principalement en français, sauf si l'utilisateur écrit dans une autre langue, auquel cas tu t'adaptes. Tu es précis, synthétique, et tu utilises le markdown pour structurer tes réponses (titres, listes, blocs de code). Date du jour : ${today}.`;

  const allSources = [];

  // Web search
  if (useWeb && lastUser) {
    sseWrite(res, { type: 'status', message: '🔍 Recherche web en cours…' });
    try {
      const results = await webSearch(lastUser);
      if (results.length) {
        allSources.push(...results.map(r => ({ kind: 'web', ...r })));
        systemPrompt += '\n\n## Résultats web actuels\nUtilise ces informations récentes et cite-les [1], [2]…\n';
        results.forEach((r, i) => {
          systemPrompt += `\n[${i + 1}] **${r.title}**\n${r.snippet}\nURL: ${r.url}\n`;
        });
      } else {
        sseWrite(res, { type: 'status', message: '⚠️ Aucun résultat web' });
      }
    } catch (e) {
      sseWrite(res, { type: 'status', message: '⚠️ Recherche web échouée' });
    }
  }

  // Wikipedia
  if (useWiki && lastUser) {
    sseWrite(res, { type: 'status', message: '📚 Consultation Wikipedia (Kiwix)…' });
    try {
      const articles = await wikiSearch(lastUser);
      if (articles.length) {
        allSources.push(...articles.map(a => ({ kind: 'wiki', ...a })));
        systemPrompt += '\n\n## Articles Wikipedia (base locale)\nUtilise ces données encyclopédiques vérifiées.\n';
        articles.forEach(a => {
          systemPrompt += `\n### ${a.title}\n${a.content}\nSource: ${a.url}\n`;
        });
      } else {
        sseWrite(res, { type: 'status', message: '⚠️ Kiwix indisponible ou aucun article trouvé' });
      }
    } catch (e) {
      sseWrite(res, { type: 'status', message: '⚠️ Kiwix indisponible' });
    }
  }

  // Send sources to client
  if (allSources.length) sseWrite(res, { type: 'sources', sources: allSources });

  // Build messages for Hermes
  const hermesMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({
      role:    m.role === 'user' ? 'user' : 'assistant',
      content: typeof m.content === 'string' ? m.content : ''
    }))
  ];

  let hermesRes;
  try {
    hermesRes = await fetch(`${HERMES_URL}/v1/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body:    JSON.stringify({
        model:       'nousresearch/nous-hermes-2-mistral-7b-dpo',
        messages:    hermesMessages,
        stream:      true,
        temperature: 0.7,
        max_tokens:  8192
      })
    });
  } catch (e) {
    sseWrite(res, { type: 'error', message: `Connexion Hermes échouée: ${e.message}` });
    return res.end();
  }

  if (!hermesRes.ok) {
    const errText = await hermesRes.text().catch(() => '');
    sseWrite(res, { type: 'error', message: `Hermes ${hermesRes.status}: ${errText.slice(0, 200)}` });
    return res.end();
  }

  // Pipe Hermes SSE → client
  hermesRes.body.on('error', () => res.end());
  hermesRes.body.pipe(res, { end: true });
  req.on('close', () => hermesRes.body.destroy());
});

// SPA fallback
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  const line = (label, val, ok) =>
    `║  ${label.padEnd(10)} ${(ok === undefined ? val : (ok ? '✓ ' : '✗ ') + val).padEnd(36)}║`;

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║       🚀  Tecuit IA v2 — Backend             ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(line('Port',    PORT));
  console.log(line('Hermes',  HERMES_URL || '⚠  NON CONFIGURÉ', !!HERMES_URL));
  console.log(line('Kiwix',   KIWIX_URL));
  console.log(line('Piper',   hasPiper() ? PIPER_BIN : 'non configuré — TTS navigateur', hasPiper()));
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`\n  → http://localhost:${PORT}\n`);
  if (!HERMES_URL) console.warn('  ⚠️  HERMES_URL manquant dans .env !\n');
});
