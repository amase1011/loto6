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

function parseInteger(value) {
  const normalized = String(value ?? '').replace(/[^0-9-]/g, '');
  if (!normalized || normalized === '-') return null;
  const number = Number(normalized);
  return Number.isSafeInteger(number) ? number : null;
}

function splitCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(value.trim());
      value = '';
    } else {
      value += character;
    }
  }
  values.push(value.trim());
  return values;
}

function normalizeHeader(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/[\s　]/g, '')
    .replace(/BONUS/i, 'BONUS')
    .toUpperCase();
}

function findHeaderIndex(headers, candidates) {
  const normalizedCandidates = candidates.map(normalizeHeader);
  return headers.findIndex(header => normalizedCandidates.includes(normalizeHeader(header)));
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) throw new Error('取得したCSVに十分なデータがありません。');

  const headers = splitCsvLine(lines[0]);
  const indexes = {
    round: findHeaderIndex(headers, ['開催回', '抽選回']),
    date: findHeaderIndex(headers, ['日付', '抽選日']),
    bonus: findHeaderIndex(headers, ['BONUS数字', 'ボーナス数字']),
    firstPrizeWinners: findHeaderIndex(headers, ['1等口数', '１等口数']),
    firstPrizeAmount: findHeaderIndex(headers, ['1等賞金', '１等賞金']),
    carryover: findHeaderIndex(headers, ['キャリーオーバー', 'キャリーオーバー額'])
  };
  indexes.nums = [1, 2, 3, 4, 5, 6].map(number =>
    findHeaderIndex(headers, [`第${number}数字`, `本数字${number}`, `本数字${String(number).padStart(2, '0')}`])
  );

  const missing = [];
  if (indexes.round < 0) missing.push('開催回');
  if (indexes.date < 0) missing.push('日付');
  if (indexes.nums.some(index => index < 0)) missing.push('本数字1〜6');
  if (indexes.bonus < 0) missing.push('BONUS数字');
  if (indexes.firstPrizeWinners < 0) missing.push('1等口数');
  if (indexes.firstPrizeAmount < 0) missing.push('1等賞金');
  if (indexes.carryover < 0) missing.push('キャリーオーバー');
  if (missing.length) throw new Error(`CSVの列を確認できませんでした：${missing.join('、')}`);

  const rows = [];
  for (const line of lines.slice(1)) {
    const columns = splitCsvLine(line);
    const round = parseInteger(columns[indexes.round]);
    const nums = indexes.nums.map(index => parseInteger(columns[index]));
    const bonus = parseInteger(columns[indexes.bonus]);
    const firstPrizeWinners = parseInteger(columns[indexes.firstPrizeWinners]);
    const firstPrizeAmount = parseInteger(columns[indexes.firstPrizeAmount]);
    const carryover = parseInteger(columns[indexes.carryover]);

    const valid = Number.isInteger(round)
      && nums.length === 6
      && new Set(nums).size === 6
      && nums.every(number => Number.isInteger(number) && number >= 1 && number <= 43)
      && Number.isInteger(bonus)
      && bonus >= 1
      && bonus <= 43
      && Number.isInteger(firstPrizeWinners)
      && Number.isInteger(firstPrizeAmount)
      && Number.isInteger(carryover);

    if (!valid) continue;
    rows.push({
      round,
      date: columns[indexes.date],
      nums: nums.sort((a, b) => a - b),
      bonus,
      firstPrizeWinners,
      firstPrizeAmount,
      carryover
    });
  }

  rows.sort((a, b) => a.round - b.round);
  const uniqueRows = [...new Map(rows.map(row => [row.round, row])).values()];
  if (uniqueRows.length < 1000) throw new Error(`取得件数が不足しています（${uniqueRows.length}件）。`);

  const latest = uniqueRows.at(-1);
  if (!Number.isInteger(latest.carryover) || !Number.isInteger(latest.firstPrizeWinners)) {
    throw new Error('最新回のキャリーオーバー・1等口数を読み取れませんでした。');
  }
  return uniqueRows;
}

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('取得元でリダイレクトが繰り返されました。'));

    const request = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 Loto6Analyzer/2.4',
        'Accept': 'text/csv,text/plain,*/*'
      }
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve(download(new URL(response.headers.location, url).toString(), redirects + 1));
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
      return send(res, 200, JSON.stringify({ ok: true, version: '2.4.0' }));
    }

    if (requestUrl.pathname === '/api/draws') {
      const force = requestUrl.searchParams.get('refresh') === '1';
      const rows = await getDraws(force);
      const latest = rows.at(-1);
      return send(res, 200, JSON.stringify({
        count: rows.length,
        source: "KYO's LOTO6 公開CSV（個人利用向け）",
        fetchedAt: new Date(cache.fetchedAt).toISOString(),
        latestFinancials: {
          round: latest.round,
          carryover: latest.carryover,
          firstPrizeWinners: latest.firstPrizeWinners,
          firstPrizeAmount: latest.firstPrizeAmount
        },
        rows
      }));
    }

    const filePath = staticFilePath(requestUrl.pathname);
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    }

    const noCache = ['sw.js', 'index.html', 'app.js', 'style.css'].includes(path.basename(filePath));
    return send(res, 200, fs.readFileSync(filePath), mimeType(filePath), noCache ? 'no-cache' : 'public, max-age=86400');
  } catch (error) {
    return send(res, 500, JSON.stringify({ error: error.message || String(error) }));
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Loto6 Analyzer v2.4 running on ${HOST}:${PORT}`);
  });
}

module.exports = { parseCsv };
