const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const KINTONE_BASE_URL = process.env.KINTONE_BASE_URL;
const KINTONE_API_TOKEN_80 = process.env.KINTONE_API_TOKEN_80;
const KINTONE_API_TOKEN_325 = process.env.KINTONE_API_TOKEN_325;

async function fetchKintoneData(appId, token) {
  let allRecords = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const url = `${KINTONE_BASE_URL}/k/v1/records.json?app=${appId}&limit=${limit}&offset=${offset}`;
    const response = await fetch(url, { method: 'GET', headers: { 'X-Cybozu-API-Token': token } });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to fetch app ${appId}: ${response.status} - ${err}`);
    }
    const data = await response.json();
    const records = data.records || [];
    allRecords = allRecords.concat(records);
    if (records.length < limit) break;
    offset += limit;
  }
  console.log(`App ${appId}: ${allRecords.length}件取得`);
  return allRecords;
}

function getSelectName(record, fieldName) {
  if (record[fieldName] && record[fieldName].value && record[fieldName].value.length > 0) {
    return record[fieldName].value[0].name;
  }
  return null;
}

function getFieldValue(record, fieldName) {
  if (record[fieldName] && record[fieldName].value !== undefined && record[fieldName].value !== '') {
    return record[fieldName].value;
  }
  return null;
}

function determineGrade(subtable) {
  if (!subtable || !Array.isArray(subtable)) return 'D';
  for (let item of subtable) {
    const row = item.value;
    if (getFieldValue(row, 'final_interview_actual_date')) return 'A';
  }
  for (let item of subtable) {
    const row = item.value;
    if (getFieldValue(row, 'second_interview_actual_date')) return 'B';
  }
  for (let item of subtable) {
    const row = item.value;
    const first = getFieldValue(row, 'first_interview_actual_date');
    const s2 = getFieldValue(row, 'second_interview_scheduled_date');
    const sf = getFieldValue(row, 'final_interview_scheduled_date');
    if (first && (s2 || sf)) return 'C';
  }
  for (let item of subtable) {
    const row = item.value;
    if (getFieldValue(row, 'first_interview_actual_date')) return 'D+';
  }
  return 'D';
}

async function main() {
  try {
    console.log('kintoneデータ取得開始...');
    const app325Records = await fetchKintoneData(325, KINTONE_API_TOKEN_325);
    const app80Records = await fetchKintoneData(80, KINTONE_API_TOKEN_80);

    const caMap = {};
    for (let record of app325Records) {
      const caName = getSelectName(record, 'Tanto');
      const division = getSelectName(record, 'tantou_soshiki');
      if (!caName) continue;
      if (!caMap[caName]) {
        caMap[caName] = { name: caName, division: division || '部門不明', summary: { projects_created: 0 } };
      }
      caMap[caName].summary.projects_created += 1;
    }

    const raMap = {};
    for (let record of app80Records) {
      const raName = getSelectName(record, 'tanto');
      const team = getSelectName(record, 'tanto_organization');
      const subtable = getFieldValue(record, 'deal_status_1');
      if (!raName) continue;
      if (!raMap[raName]) {
        raMap[raName] = { name: raName, team: team || 'チーム不明', grades: { D: 0, 'D+': 0, C: 0, B: 0, A: 0 }, total_deals: 0 };
      }
      const grade = determineGrade(subtable);
      raMap[raName].grades[grade] += 1;
      raMap[raName].total_deals += 1;
    }

    const raList = Object.values(raMap).map(ra => {
      const weights = { A: 1.0, B: 0.75, C: 0.5, 'D+': 0.25, D: 0.1 };
      let totalWeight = 0;
      for (let g in ra.grades) totalWeight += ra.grades[g] * weights[g];
      ra.grade_score = ra.total_deals > 0 ? (totalWeight / ra.total_deals).toFixed(2) : 0;
      ra.points = ra.total_deals * 10;
      return ra;
    }).sort((a, b) => parseFloat(b.grade_score) - parseFloat(a.grade_score));

    const output = {
      lastUpdate: new Date().toISOString(),
      ca_list: Object.values(caMap).sort((a, b) => b.summary.projects_created - a.summary.projects_created),
      ra_list: raList,
      summary: {
        total_interviews: app80Records.length,
        total_projects: app325Records.length,
        total_points: raList.reduce((sum, ra) => sum + ra.points, 0)
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
