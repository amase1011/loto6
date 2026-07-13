'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const https = require('https');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CSV_URL = 'https://loto6.thekyo.jp/data/loto6.csv';
let cache = { at: 0, rows: null };

function send(res, status, body, type='application/json; charset=utf-8') {
  res.writeHead(status, {'Content-Type': type, 'Cache-Control': 'no-store'});
  res.end(body);
}
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error('CSVに十分なデータがありません');
  const out = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',').map(v => v.trim());
    if (c.length < 9) continue;
    const round = Number(c[0]);
    const nums = c.slice(2, 8).map(Number);
    const bonus = Number(c[8]);
    if (!Number.isInteger(round) || nums.length !== 6 || nums.some(n => !Number.isInteger(n) || n < 1 || n > 43)) continue;
    out.push({ round, date: c[1], nums, bonus });
  }
  out.sort((a,b) => a.round - b.round);
  if (out.length < 1000) throw new Error(`取得件数が不足しています（${out.length}件）`);
  return out;
}
function download(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: {'User-Agent': 'Mozilla/5.0 Loto6Analyzer/1.0'} }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve(download(new URL(response.headers.location, url).toString()));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`取得元エラー: HTTP ${response.statusCode}`));
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.setTimeout(30000, () => request.destroy(new Error('取得元への接続がタイムアウトしました')));
    request.on('error', reject);
  });
}
async function getDraws() {
  const now = Date.now();
  if (cache.rows && now - cache.at < 6 * 60 * 60 * 1000) return cache.rows;
  const buf = await download(CSV_URL);
  const text = new TextDecoder('shift_jis').decode(buf);
  const rows = parseCsv(text);
  cache = { at: now, rows };
  return rows;
}
function mime(file) {
  const ext = path.extname(file).toLowerCase();
  return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.ico':'image/x-icon'}[ext] || 'application/octet-stream');
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/draws') {
      const rows = await getDraws();
      return send(res, 200, JSON.stringify({ count: rows.length, source: "KYO's LOTO6 公開CSV（個人利用向け）", rows }));
    }
    let rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    send(res, 200, fs.readFileSync(file), mime(file));
  } catch (err) {
    send(res, 500, JSON.stringify({ error: err.message || String(err) }));
  }
});
server.listen(PORT, HOST, () => console.log(`Loto6 Analyzer running on ${HOST}:${PORT}`));
