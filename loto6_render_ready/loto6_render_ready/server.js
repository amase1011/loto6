'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CSV_URL = 'https://loto6.thekyo.jp/data/loto6.csv';
const SIX_HOURS = 6 * 60 * 60 * 1000;

let cache = { fetchedAt: 0, rows: null };

function send(res, status, body, type = 'application/json; charset=utf-8', cacheControl = 'no-store') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) throw new Error('取得したCSVに十分なデータがありません。');

  const rows = [];
  for (const line of lines.slice(1)) {
    const columns = line.split(',').map(value => value.trim().replace(/^"|"$/g, ''));
    if (columns.length < 9) continue;

    const round = Number(columns[0]);
    const nums = columns.slice(2, 8).map(Number);
    const bonus = Number(columns[8]);

    const valid = Number.isInteger(round)
      && nums.length === 6
      && new Set(nums).size === 6
      && nums.every(number => Number.isInteger(number) && number >= 1 && number <= 43)
      && Number.isInteger(bonus)
      && bonus >= 1
      && bonus <= 43;

    if (!valid) continue;
    rows.push({ round, date: columns[1], nums: nums.sort((a, b) => a - b), bonus });
  }

  rows.sort((a, b) => a.round - b.round);
  const uniqueRows = [...new Map(rows.map(row => [row.round, row])).values()];
  if (uniqueRows.length < 1000) {
    throw new Error(`取得件数が不足しています（${uniqueRows.length}件）。`);
  }
  return uniqueRows;
}

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('取得元でリダイレクトが繰り返されました。'));

    const request = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 Loto6Analyzer/2.1',
        'Accept': 'text/csv,text/plain,*/*'
      }
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const redirectUrl = new URL(response.headers.location, url).toString();
        resolve(download(redirectUrl, redirects + 1));
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`取得元エラー: HTTP ${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });

    request.setTimeout(30000, () => request.destroy(new Error('取得元への接続がタイムアウトしました。')));
    request.on('error', reject);
  });
}

async function getDraws(force = false) {
  const now = Date.now();
  if (!force && cache.rows && now - cache.fetchedAt < SIX_HOURS) return cache.rows;

  const buffer = await download(CSV_URL);
  const text = new TextDecoder('shift_jis').decode(buffer);
  const rows = parseCsv(text);
  cache = { fetchedAt: now, rows };
  return rows;
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  })[extension] || 'application/octet-stream';
}

function staticFilePath(urlPath) {
  const requested = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  const relative = path.normalize(requested).replace(/^([/\\]*\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR) + path.sep) && filePath !== path.resolve(PUBLIC_DIR)) return null;
  return filePath;
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (requestUrl.pathname === '/api/health') {
      return send(res, 200, JSON.stringify({ ok: true, version: '2.1.0' }));
    }

    if (requestUrl.pathname === '/api/draws') {
      const force = requestUrl.searchParams.get('refresh') === '1';
      const rows = await getDraws(force);
      return send(res, 200, JSON.stringify({
        count: rows.length,
        source: "KYO's LOTO6 公開CSV（個人利用向け）",
        fetchedAt: new Date(cache.fetchedAt).toISOString(),
        rows
      }));
    }

    const filePath = staticFilePath(requestUrl.pathname);
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    }

    const noCache = path.basename(filePath) === 'sw.js' || path.basename(filePath) === 'index.html';
    return send(
      res,
      200,
      fs.readFileSync(filePath),
      mimeType(filePath),
      noCache ? 'no-cache' : 'public, max-age=86400'
    );
  } catch (error) {
    return send(res, 500, JSON.stringify({ error: error.message || String(error) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Loto6 Analyzer v2.1 running on ${HOST}:${PORT}`);
});
