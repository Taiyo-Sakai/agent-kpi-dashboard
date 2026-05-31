const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const KINTONE_BASE_URL = process.env.KINTONE_BASE_URL;
const KINTONE_API_TOKEN_80 = process.env.KINTONE_API_TOKEN_80;
const KINTONE_API_TOKEN_325 = process.env.KINTONE_API_TOKEN_325;
const FULL_FETCH = process.env.FULL_FETCH === 'true';

function getFromDate() {
  if (FULL_FETCH) return '2025-01-01';
  // 今年度の4月1日（日本の会計年度）
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-04-01`;
}

function getSelectName(record, fieldName) {
  const f = record[fieldName];
  if (f && f.value && f.value.length > 0) return f.value[0].name;
  return null;
}

function getFieldValue(record, fieldName) {
  const f = record[fieldName];
  if (f && f.value !== undefined && f.value !== '') return f.value;
  return null;
}

function determineGrade(subtable) {
  if (!subtable || !Array.isArray(subtable)) return 'D';
  for (let item of subtable) if (getFieldValue(item.value, 'final_interview_actual_date')) return 'A';
  for (let item of subtable) if (getFieldValue(item.value, 'second_interview_actual_date')) return 'B';
  for (let item of subtable) {
    const first = getFieldValue(item.value, 'first_interview_actual_date');
    const s2 = getFieldValue(item.value, 'second_interview_scheduled_date');
    const sf = getFieldValue(item.value, 'final_interview_scheduled_date');
    if (first && (s2 || sf)) return 'C';
  }
  for (let item of subtable) if (getFieldValue(item.value, 'first_interview_actual_date')) return 'D+';
  return 'D';
}

async function fetchAndAggregate(appId, token, query, processRecord) {
  let offset = 0;
  let total = 0;
  const limit = 100;
  while (true) {
    const url = `${KINTONE_BASE_URL}/k/v1/records.json?app=${appId}&limit=${limit}&offset=${offset}&query=${encodeURIComponent(query)}`;
    const response = await fetch(url, { method: 'GET', headers: { 'X-Cybozu-API-Token': token } });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`App ${appId} エラー: ${response.status} - ${err}`);
    }
    const data = await response.json();
    const records = data.records || [];
    for (const record of records) processRecord(record);
    total += records.length;
    if (records.length < limit) break;
    offset += limit;
    if (offset % 1000 === 0) console.log(`  App ${appId}: ${offset}件処理中...`);
  }
  console.log(`App ${appId}: ${total}件完了`);
  return total;
}

async function main() {
  try {
    const fromDate = getFromDate();
    console.log(`取得期間: ${fromDate} 以降 (${FULL_FETCH ? '全件モード' : '今年度モード'})`);

    const caMap = {};
    const total325 = await fetchAndAggregate(
      325, KINTONE_API_TOKEN_325,
      `sakusei_Nichiji >= "${fromDate}T00:00:00+0900" order by $id desc`,
      (record) => {
        const caName = getSelectName(record, 'Tanto');
        const division = getSelectName(record, 'tantou_soshiki');
        if (!caName) return;
        if (!caMap[caName]) caMap[caName] = { name: caName, division: division || '部門不明', summary: { projects_created: 0 } };
        caMap[caName].summary.projects_created += 1;
      }
    );

    const raMap = {};
    const total80 = await fetchAndAggregate(
      80, KINTONE_API_TOKEN_80,
      `registration_date >= "${fromDate}" order by $id desc`,
      (record) => {
        const raName = getSelectName(record, 'tanto');
        const team = getSelectName(record, 'tanto_organization');
        const subtable = getFieldValue(record, 'deal_status_1');
        if (!raName) return;
        if (!raMap[raName]) raMap[raName] = { name: raName, team: team || 'チーム不明', grades: { D: 0, 'D+': 0, C: 0, B: 0, A: 0 }, total_deals: 0 };
        const grade = determineGrade(subtable);
        raMap[raName].grades[grade] += 1;
        raMap[raName].total_deals += 1;
      }
    );

    const raList = Object.values(raMap).map(ra => {
      const weights = { A: 1.0, B: 0.75, C: 0.5, 'D+': 0.25, D: 0.1 };
      let w = 0;
      for (let g in ra.grades) w += ra.grades[g] * weights[g];
      ra.grade_score = ra.total_deals > 0 ? (w / ra.total_deals).toFixed(2) : 0;
      ra.points = ra.total_deals * 10;
      return ra;
    }).sort((a, b) => parseFloat(b.grade_score) - parseFloat(a.grade_score));

    const output = {
      lastUpdate: new Date().toISOString(),
      dataFrom: fromDate,
      fullFetch: FULL_FETCH,
      ca_list: Object.values(caMap).sort((a, b) => b.summary.projects_created - a.summary.projects_created),
      ra_list: raList,
      summary: {
        total_interviews: total80,
        total_projects: total325,
        total_points: raList.reduce((s, r) => s + r.points, 0)
      }
    };

    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'data.json'), JSON.stringify(output, null, 2), 'utf-8');
    console.log(`✅ 完了！CA: ${output.ca_list.length}名, RA: ${output.ra_list.length}名`);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
