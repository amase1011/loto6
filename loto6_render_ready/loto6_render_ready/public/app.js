'use strict';

let draws = [];
let deferredInstallPrompt = null;
const CACHE_KEY = 'loto6_draws_v2_4';
const CACHE_META_KEY = 'loto6_draws_meta_v2_4';
let historyPage = 1;

const $ = id => document.getElementById(id);
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const escapeXml = value => String(value).replace(/[<>&'\"]/g, character => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','\"':'&quot;'}[character]));
const formatYen = value => `${Math.max(0, Number(value) || 0).toLocaleString('ja-JP')}円`;

function selectedDraws() {
  const value = $('period').value;
  return value === 'all' ? draws : draws.slice(-Number(value));
}

function countAllDraws() {
  const counts = Array(44).fill(0);
  draws.forEach(draw => draw.nums.forEach(number => counts[number]++));
  return counts;
}

function analyze(rows) {
  const counts = Array(44).fill(0);
  const overdue = Array(44).fill(rows.length);
  const gaps = Array.from({ length: 44 }, () => []);
  const lastSeen = Array(44).fill(null);
  const sums = [];
  const oddDistribution = Array(7).fill(0);

  rows.forEach((draw, index) => {
    draw.nums.forEach(number => {
      counts[number]++;
      if (lastSeen[number] !== null) gaps[number].push(index - lastSeen[number]);
      lastSeen[number] = index;
    });
    const sum = draw.nums.reduce((total, number) => total + number, 0);
    sums.push(sum);
    oddDistribution[draw.nums.filter(number => number % 2 === 1).length]++;
  });

  for (let number = 1; number <= 43; number++) {
    if (lastSeen[number] !== null) overdue[number] = rows.length - 1 - lastSeen[number];
  }

  return { counts, overdue, gaps, sums, oddDistribution };
}

function render() {
  if (!draws.length) return;

  const rows = selectedDraws();
  const analysis = analyze(rows);
  const allCounts = countAllDraws();
  const latest = draws.at(-1);

  const hasCarryoverData = Number.isFinite(Number(latest.carryover));
  const currentCarryover = hasCarryoverData ? Math.max(0, Number(latest.carryover)) : null;
  $('currentCarryover').textContent = hasCarryoverData ? formatYen(currentCarryover) : '取得できません';
  $('carryoverMeta').textContent = !hasCarryoverData
    ? '最新データを更新してください'
    : currentCarryover > 0
      ? `第${latest.round}回の抽選結果時点`
      : `第${latest.round}回の抽選結果時点・キャリーオーバーなし`;

  $('summary').innerHTML = `
    <div class="item"><span>取得件数</span><strong>${draws.length}</strong></div>
    <div class="item"><span>最新回</span><strong>第${latest.round}回</strong></div>
    <div class="item"><span>最新抽選日</span><strong>${latest.date}</strong></div>
    <div class="item"><span>対象の平均合計値</span><strong>${average(analysis.sums).toFixed(1)}</strong></div>`;

  const numberList = Array.from({ length: 43 }, (_, index) => index + 1);
  const sort = $('sort').value;
  numberList.sort((left, right) => {
    if (sort === 'rateDesc') return analysis.counts[right] - analysis.counts[left] || left - right;
    if (sort === 'rateAsc') return analysis.counts[left] - analysis.counts[right] || left - right;
    if (sort === 'overdueDesc') return analysis.overdue[right] - analysis.overdue[left] || left - right;
    if (sort === 'allDesc') return allCounts[right] - allCounts[left] || left - right;
    return left - right;
  });

  $('statsBody').innerHTML = numberList.map(number => `
    <tr>
      <td><span class="ball">${number}</span></td>
      <td>${analysis.counts[number]}</td>
      <td>${(analysis.counts[number] / rows.length * 100).toFixed(1)}%</td>
      <td>${analysis.overdue[number]}回</td>
      <td>${analysis.gaps[number].length ? average(analysis.gaps[number]).toFixed(1) : '-'}</td>
    </tr>`).join('');

  const hot = Array.from({ length: 43 }, (_, index) => index + 1)
    .sort((left, right) => analysis.counts[right] - analysis.counts[left] || left - right)
    .slice(0, 8);
  const cold = Array.from({ length: 43 }, (_, index) => index + 1)
    .sort((left, right) => analysis.overdue[right] - analysis.overdue[left] || left - right)
    .slice(0, 8);

  $('hot').innerHTML = hot.map(number => `<span class="ball hotBall" title="${analysis.counts[number]}回">${number}</span>`).join('');
  $('cold').innerHTML = cold.map(number => `<span class="ball coldBall" title="未出現${analysis.overdue[number]}回">${number}</span>`).join('');

  renderDistribution('oddDist', analysis.oddDistribution.map((value, index) => [`${index}個`, value]));
  const sumBins = [[21,69],[70,99],[100,129],[130,159],[160,189],[190,243]]
    .map(([low, high]) => [`${low}〜${high}`, analysis.sums.filter(sum => sum >= low && sum <= high).length]);
  renderDistribution('sumDist', sumBins);
  renderFrequencyChart(rows, analysis);
  renderSumTrend(rows);

  $('recent').innerHTML = draws.slice(-10).reverse().map(draw => `
    <div class="draw">
      <strong>第${draw.round}回</strong> ${draw.date}
      <div>${draw.nums.map(number => `<span class="ball">${number}</span>`).join('')} <small>BO ${draw.bonus}</small></div>
    </div>`).join('');

  renderHistory();
}

function renderDistribution(id, data) {
  const maximum = Math.max(...data.map(item => item[1]), 1);
  $(id).innerHTML = data.map(([label, value]) => `
    <div class="barRow"><span>${label}</span><div class="bar"><span style="width:${value / maximum * 100}%"></span></div><b>${value}</b></div>`).join('');
}

function historyNumberFilters() {
  return [...new Set(($('historyNumbers').value.match(/\d+/g) || [])
    .map(Number)
    .filter(number => Number.isInteger(number) && number >= 1 && number <= 43))];
}

function filteredHistoryRows() {
  const query = $('historyQuery').value.trim().toLowerCase();
  const requiredNumbers = historyNumberFilters();
  const order = $('historyOrder').value;

  const filtered = draws.filter(draw => {
    const matchesQuery = !query
      || String(draw.round).includes(query.replace(/^第|回$/g, ''))
      || String(draw.date).toLowerCase().includes(query);
    const matchesNumbers = requiredNumbers.every(number => draw.nums.includes(number));
    return matchesQuery && matchesNumbers;
  });

  filtered.sort((left, right) => order === 'oldest' ? left.round - right.round : right.round - left.round);
  return filtered;
}

function renderHistory() {
  if (!$('historyList')) return;

  if (!draws.length) {
    $('historySummary').textContent = 'データを取得すると表示されます。';
    $('historyList').innerHTML = '';
    return;
  }

  const filtered = filteredHistoryRows();
  const pageSize = Number($('historyPageSize').value) || 20;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  historyPage = clamp(historyPage, 1, totalPages);
  const start = (historyPage - 1) * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);
  const requiredNumbers = historyNumberFilters();

  const filterText = requiredNumbers.length ? `・本数字 ${requiredNumbers.join('・')} をすべて含む` : '';
  $('historySummary').textContent = `${filtered.length}件中 ${filtered.length ? start + 1 : 0}〜${Math.min(start + pageSize, filtered.length)}件を表示${filterText}`;
  $('historyPageInfo').textContent = `${historyPage} / ${totalPages}`;

  $('historyList').innerHTML = pageRows.length ? pageRows.map(draw => {
    const firstPrizeWinners = Math.max(0, Number(draw.firstPrizeWinners) || 0);
    return `
    <article class="historyItem${firstPrizeWinners > 0 ? ' hasFirstPrizeWinner' : ''}">
      <div class="historyMeta">
        <strong>第${draw.round}回</strong>
        <time>${draw.date}</time>
        ${firstPrizeWinners > 0
          ? `<span class="firstPrizeWin">一等当選 ${firstPrizeWinners.toLocaleString('ja-JP')}口</span>`
          : '<span class="firstPrizeNone">一等当選なし</span>'}
      </div>
      <div class="historyNumbers">
        ${draw.nums.map(number => `<span class="ball${requiredNumbers.includes(number) ? ' historyMatchBall' : ''}">${number}</span>`).join('')}
        <span class="bonusBall">BO ${draw.bonus}</span>
      </div>
    </article>`;
  }).join('') : '<div class="historyEmpty">条件に一致する抽選結果はありません。</div>';

  $('historyFirstBtn').disabled = historyPage <= 1;
  $('historyPrevBtn').disabled = historyPage <= 1;
  $('historyNextBtn').disabled = historyPage >= totalPages;
  $('historyLastBtn').disabled = historyPage >= totalPages;
}

function updateHistoryFilters() {
  historyPage = 1;
  renderHistory();
}

function renderFrequencyChart(rows, analysis) {
  const top = Array.from({ length: 43 }, (_, index) => index + 1)
    .sort((left, right) => analysis.counts[right] - analysis.counts[left] || left - right)
    .slice(0, 10);
  const maximum = Math.max(...top.map(number => analysis.counts[number]), 1);

  $('frequencyChart').innerHTML = `
    <div class="barChart">
      ${top.map(number => {
        const height = Math.max(3, analysis.counts[number] / maximum * 210);
        return `<div class="barCol"><div class="chartBar" style="height:${height}px"><span>${analysis.counts[number]}</span></div><div class="barLabel">${number}</div></div>`;
      }).join('')}
    </div>
    <p class="muted">対象 ${rows.length}回</p>`;
}

function renderSumTrend(rows) {
  const recent = rows.slice(-Math.min(50, rows.length));
  if (recent.length < 2) {
    $('sumTrendChart').innerHTML = '<div class="chartEmpty">データが足りません</div>';
    return;
  }

  const values = recent.map(draw => draw.nums.reduce((sum, number) => sum + number, 0));
  const minimum = Math.min(...values) - 5;
  const maximum = Math.max(...values) + 5;
  const width = 600;
  const height = 260;
  const padding = 34;
  const points = values.map((value, index) => {
    const x = padding + index * (width - padding * 2) / (values.length - 1);
    const y = height - padding - (value - minimum) * (height - padding * 2) / (maximum - minimum || 1);
    return [x, y];
  });

  const grid = [0, .25, .5, .75, 1].map(position => {
    const y = padding + position * (height - padding * 2);
    const value = Math.round(maximum - position * (maximum - minimum));
    return `<line x1="${padding}" y1="${y}" x2="${width-padding}" y2="${y}" class="gridLine"/><text x="4" y="${y+4}" class="axisText">${value}</text>`;
  }).join('');
  const labelIndexes = [...new Set([0, Math.floor((recent.length - 1) / 2), recent.length - 1])];
  const labels = labelIndexes.map(index => `<text x="${points[index][0]}" y="${height-5}" text-anchor="middle" class="axisText">${recent[index].round}</text>`).join('');

  $('sumTrendChart').innerHTML = `
    <svg class="lineSvg" viewBox="0 0 ${width} ${height}" role="img" aria-label="本数字6個の合計値推移">
      ${grid}<polyline points="${points.map(point => point.join(',')).join(' ')}" class="trendLine"/>
      ${points.filter((_, index) => index === 0 || index === points.length - 1 || index % 10 === 0).map(([x,y]) => `<circle cx="${x}" cy="${y}" r="3" class="trendDot"/>`).join('')}
      ${labels}
    </svg>`;
}

function saveCache(rows, meta) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(rows));
    localStorage.setItem(CACHE_META_KEY, JSON.stringify(meta));
  } catch (error) {
    console.warn('ブラウザキャッシュへ保存できませんでした', error);
  }
}

function restoreCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    const meta = JSON.parse(localStorage.getItem(CACHE_META_KEY) || 'null');
    if (Array.isArray(cached) && cached.length > 1000) {
      draws = cached;
      $('status').textContent = `${cached.length}件の保存データを表示中です。最新データを確認しています…`;
      render();
      return meta;
    }
  } catch (error) {
    console.warn('保存データを読み込めませんでした', error);
  }
  return null;
}

async function load(force = false) {
  const status = $('status');
  const button = $('loadBtn');
  status.textContent = force ? '最新データを取得中…' : 'データを取得中…';
  button.disabled = true;

  try {
    const response = await fetch(`/api/draws${force ? '?refresh=1' : ''}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '取得に失敗しました。');
    draws = result.rows;
    saveCache(draws, { source: result.source, fetchedAt: result.fetchedAt });
    const latestFinancials = result.latestFinancials;
    status.textContent = latestFinancials
      ? `${result.count}件を取得しました。最新CO：${formatYen(latestFinancials.carryover)}／取得元：${result.source}`
      : `${result.count}件を取得しました。金額データなしの旧サーバーです。server.jsを更新してください。`;
    render();
  } catch (error) {
    status.textContent = draws.length
      ? `更新できなかったため、保存済みの${draws.length}件を表示しています。エラー：${error.message}`
      : `エラー：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function randomNumbers() {
  const pool = Array.from({ length: 43 }, (_, index) => index + 1);
  for (let index = pool.length - 1; index > 0; index--) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[randomIndex]] = [pool[randomIndex], pool[index]];
  }
  return pool.slice(0, 6).sort((left, right) => left - right);
}

function overlap(left, right) {
  return left.filter(number => right.includes(number)).length;
}

function candidateMetrics(numbers) {
  return {
    sum: numbers.reduce((total, number) => total + number, 0),
    odd: numbers.filter(number => number % 2 === 1).length,
    high: numbers.filter(number => number >= 32).length,
    consecutive: numbers.slice(1).filter((number, index) => number === numbers[index] + 1).length
  };
}

function generate() {
  const count = Math.min(20, Math.max(1, Number($('ticketCount').value) || 5));
  const minimum = Number($('minSum').value);
  const maximum = Number($('maxSum').value);
  const maximumOverlap = Number($('overlap').value);

  if (minimum > maximum) {
    $('candidates').textContent = '合計最小は合計最大以下にしてください。';
    return;
  }

  const output = [];
  let tries = 0;
  while (output.length < count && tries++ < 100000) {
    const numbers = randomNumbers();
    const metrics = candidateMetrics(numbers);
    if (metrics.sum < minimum || metrics.sum > maximum || metrics.odd < 2 || metrics.odd > 4) continue;
    if (output.some(existing => overlap(existing, numbers) > maximumOverlap)) continue;
    output.push(numbers);
  }

  $('candidates').innerHTML = output.length ? output.map((numbers, index) => {
    const metrics = candidateMetrics(numbers);
    return `<div class="candidate"><strong>${index+1}口目</strong><div>${numbers.map(number => `<span class="ball">${number}</span>`).join('')}</div><div class="scoreMeta">合計${metrics.sum}・奇数${metrics.odd}個</div></div>`;
  }).join('') : '条件を緩めてください。';
}

function scoreCombination(numbers) {
  const analysis30 = analyze(draws.slice(-30));
  const analysis100 = analyze(draws.slice(-100));
  const analysisAll = analyze(draws);
  const maximum30 = Math.max(...analysis30.counts.slice(1), 1);
  const maximum100 = Math.max(...analysis100.counts.slice(1), 1);
  const maximumOverdue = Math.max(...analysisAll.overdue.slice(1), 1);

  const recent30 = average(numbers.map(number => analysis30.counts[number] / maximum30));
  const recent100 = average(numbers.map(number => analysis100.counts[number] / maximum100));
  const overdue = average(numbers.map(number => analysisAll.overdue[number] / maximumOverdue));
  const metrics = candidateMetrics(numbers);
  const sumScore = 1 - clamp(Math.abs(metrics.sum - 132) / 95, 0, 1);
  const oddScore = 1 - Math.abs(metrics.odd - 3) / 3;
  const highScore = metrics.high >= 1 && metrics.high <= 3 ? 1 : .55;
  const consecutiveScore = metrics.consecutive <= 1 ? 1 : .65;

  const score = recent30 * .24 + recent100 * .20 + overdue * .18 + sumScore * .18 + oddScore * .10 + highScore * .06 + consecutiveScore * .04;
  return Math.round(score * 100);
}

function generateWeekly() {
  if (!draws.length) {
    alert('先にデータを取得してください。');
    return;
  }

  const button = $('weeklyBtn');
  button.disabled = true;
  button.textContent = '作成中…';

  setTimeout(() => {
    const pool = [];
    const seen = new Set();
    let tries = 0;

    while (pool.length < 2500 && tries++ < 30000) {
      const numbers = randomNumbers();
      const key = numbers.join('-');
      const metrics = candidateMetrics(numbers);
      if (seen.has(key) || metrics.sum < 85 || metrics.sum > 180 || metrics.odd < 2 || metrics.odd > 4 || metrics.high < 1 || metrics.consecutive > 2) continue;
      seen.add(key);
      pool.push({ numbers, score: scoreCombination(numbers), metrics });
    }

    pool.sort((left, right) => right.score - left.score);
    const selected = [];
    for (const candidate of pool) {
      if (selected.every(existing => overlap(existing.numbers, candidate.numbers) <= 3)) {
        selected.push(candidate);
        if (selected.length === 5) break;
      }
    }

    $('weeklyCandidates').innerHTML = selected.map((candidate, index) => `
      <div class="candidate">
        <div class="candidateTop"><strong>${index+1}候補</strong><span class="scoreBadge">参考スコア ${candidate.score}</span></div>
        <div>${candidate.numbers.map(number => `<span class="ball">${number}</span>`).join('')}</div>
        <div class="scoreMeta">合計${candidate.metrics.sum}・奇数${candidate.metrics.odd}個・32以上${candidate.metrics.high}個・連番${candidate.metrics.consecutive}組</div>
      </div>`).join('');

    button.disabled = false;
    button.textContent = '参考候補を作り直す';
  }, 30);
}

function inlineComputedStyles(source, target) {
  const computed = getComputedStyle(source);
  for (const property of computed) {
    target.style.setProperty(property, computed.getPropertyValue(property), computed.getPropertyPriority(property));
  }
  const sourceChildren = [...source.children];
  const targetChildren = [...target.children];
  sourceChildren.forEach((child, index) => inlineComputedStyles(child, targetChildren[index]));
}

async function captureScreen() {
  if (!draws.length) {
    alert('先にデータを取得してください。');
    return;
  }

  const button = $('pngBtn');
  const captureArea = $('captureArea');
  button.disabled = true;
  button.textContent = '画像を作成中…';
  document.body.classList.add('captureMode');

  try {
    const clone = captureArea.cloneNode(true);
    inlineComputedStyles(captureArea, clone);
    clone.style.width = `${captureArea.scrollWidth}px`;
    clone.style.height = `${captureArea.scrollHeight}px`;
    clone.style.margin = '0';
    clone.style.maxWidth = 'none';
    clone.querySelectorAll('button').forEach(element => element.remove());

    const serialized = new XMLSerializer().serializeToString(clone);
    const width = captureArea.scrollWidth;
    const height = captureArea.scrollHeight;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">${serialized}</div></foreignObject></svg>`;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();

    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = objectUrl;
    });

    const scale = Math.min(2, 2200 / Math.max(width, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(width * scale));
    canvas.height = Math.max(1, Math.floor(height * scale));
    const context = canvas.getContext('2d');
    context.scale(scale, scale);
    context.fillStyle = '#f3f4f6';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0);
    URL.revokeObjectURL(objectUrl);

    const fileName = `loto6-screen-${new Date().toISOString().slice(0,10)}.png`;
    const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', .95));
    if (!pngBlob) throw new Error('PNGを作成できませんでした。');

    const file = new File([pngBlob], fileName, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'ロト6分析画面' });
    } else {
      const link = document.createElement('a');
      link.download = fileName;
      link.href = URL.createObjectURL(pngBlob);
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
  } catch (error) {
    console.error(error);
    createFallbackReport();
    alert('画面全体の保存に対応していないブラウザだったため、簡易分析レポートを保存しました。');
  } finally {
    document.body.classList.remove('captureMode');
    button.disabled = false;
    button.textContent = '画面をPNG保存';
  }
}

function createFallbackReport() {
  const rows = selectedDraws();
  const analysis = analyze(rows);
  const top = Array.from({ length: 43 }, (_, index) => index + 1)
    .sort((left, right) => analysis.counts[right] - analysis.counts[left])
    .slice(0, 10);
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1500;
  const context = canvas.getContext('2d');
  context.fillStyle = '#f3f4f6';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#111827';
  context.font = 'bold 54px sans-serif';
  context.fillText('ロト6 分析結果', 60, 90);
  context.font = '30px sans-serif';
  context.fillText(`対象: ${$('period').selectedOptions[0].textContent} / ${rows.length}回`, 60, 145);
  context.fillText(`最新: 第${draws.at(-1).round}回 ${draws.at(-1).date}`, 60, 190);
  context.font = 'bold 36px sans-serif';
  context.fillText('出現率 上位10数字', 60, 270);

  top.forEach((number, index) => {
    const y = 340 + index * 92;
    context.fillStyle = '#dbeafe';
    context.beginPath();
    context.arc(95, y, 32, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#111827';
    context.font = 'bold 28px sans-serif';
    context.textAlign = 'center';
    context.fillText(String(number), 95, y + 10);
    context.textAlign = 'left';
    context.font = '28px sans-serif';
    context.fillText(`${analysis.counts[number]}回  ${(analysis.counts[number]/rows.length*100).toFixed(1)}%  未出現${analysis.overdue[number]}回`, 155, y + 10);
  });

  context.font = '24px sans-serif';
  context.fillStyle = '#6b7280';
  context.fillText('※過去データの統計であり、当選を保証しません。', 60, 1430);
  const link = document.createElement('a');
  link.download = `loto6-analysis-${new Date().toISOString().slice(0,10)}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  $('installBtn').hidden = false;
});

$('installBtn').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $('installBtn').hidden = true;
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(error => console.warn(error)));
}

$('loadBtn').addEventListener('click', () => load(true));
$('period').addEventListener('change', render);
$('sort').addEventListener('change', render);
$('generateBtn').addEventListener('click', generate);
$('weeklyBtn').addEventListener('click', generateWeekly);
$('pngBtn').addEventListener('click', captureScreen);
$('historyJumpBtn').addEventListener('click', () => $('historySection').scrollIntoView({ behavior: 'smooth', block: 'start' }));
$('historyQuery').addEventListener('input', updateHistoryFilters);
$('historyNumbers').addEventListener('input', updateHistoryFilters);
$('historyOrder').addEventListener('change', updateHistoryFilters);
$('historyPageSize').addEventListener('change', updateHistoryFilters);
$('historyResetBtn').addEventListener('click', () => {
  $('historyQuery').value = '';
  $('historyNumbers').value = '';
  $('historyOrder').value = 'newest';
  $('historyPageSize').value = '20';
  updateHistoryFilters();
});
$('historyFirstBtn').addEventListener('click', () => { historyPage = 1; renderHistory(); $('historySection').scrollIntoView({ block: 'start' }); });
$('historyPrevBtn').addEventListener('click', () => { historyPage--; renderHistory(); $('historySection').scrollIntoView({ block: 'start' }); });
$('historyNextBtn').addEventListener('click', () => { historyPage++; renderHistory(); $('historySection').scrollIntoView({ block: 'start' }); });
$('historyLastBtn').addEventListener('click', () => {
  const pageSize = Number($('historyPageSize').value) || 20;
  historyPage = Math.max(1, Math.ceil(filteredHistoryRows().length / pageSize));
  renderHistory();
  $('historySection').scrollIntoView({ block: 'start' });
});

restoreCache();
load(false);
