const fetch = require('node-fetch');
const fs = require('fs');

const KINTONE_BASE_URL = process.env.KINTONE_BASE_URL;
const KINTONE_API_TOKEN_80 = process.env.KINTONE_API_TOKEN_80;
const KINTONE_API_TOKEN_325 = process.env.KINTONE_API_TOKEN_325;

async function fetchKintoneData(appId, token) {
  const url = `${KINTONE_BASE_URL}/k/v1/records.json?app=${appId}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Cybozu-API-Token': token,
      'Content-Type': 'application/json'
    }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch app ${appId}: ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.records || [];
}

function getFieldValue(record, fieldNames) {
  for (let fieldName of fieldNames) {
    if (record[fieldName] && record[fieldName].value !== undefined) {
      return record[fieldName].value;
    }
  }
  return null;
}

function determineGrade(subtable) {
  if (!subtable || !Array.isArray(subtable)) return 'D';
  
  for (let item of subtable) {
    const row = item.value;
    
    // A読み: 最終面接実施日あり
    if (getFieldValue(row, ['final_interview_date', 'finalinterviewdate'])) {
      return 'A';
    }
  }
  
  for (let item of subtable) {
    const row = item.value;
    
    // B読み: 2次面接実施日あり
    if (getFieldValue(row, ['second_interview_date', 'secondinterviewdate'])) {
      return 'B';
    }
  }
  
  for (let item of subtable) {
    const row = item.value;
    const firstInterview = getFieldValue(row, ['first_interview_date', 'firstinterviewdate']);
    const secondScheduled = getFieldValue(row, ['second_interview_scheduled_date']);
    const finalScheduled = getFieldValue(row, ['final_interview_scheduled_date']);
    
    // C読み: 初回面接実施日 + 2次面接予定日または最終面接予定日
    if (firstInterview && (secondScheduled || finalScheduled)) {
      return 'C';
    }
  }
  
  for (let item of subtable) {
    const row = item.value;
    
    // D+読み: 初回面接実施日あり
    if (getFieldValue(row, ['first_interview_date', 'firstinterviewdate'])) {
      return 'D+';
    }
  }
  
  // D読み: 面接予定日あり
  for (let item of subtable) {
    const row = item.value;
    if (getFieldValue(row, ['second_interview_scheduled_date']) || 
        getFieldValue(row, ['final_interview_scheduled_date'])) {
      return 'D';
    }
  }
  
  return 'D';
}

async function main() {
  try {
    console.log('Fetching kintone data...');
    
    // Fetch CA data from App 325 (成約管理)
    const app325Records = await fetchKintoneData(325, KINTONE_API_TOKEN_325);
    console.log(`Fetched ${app325Records.length} records from App 325`);
    
    // Fetch RA data from App 80 (候補者管理)
    const app80Records = await fetchKintoneData(80, KINTONE_API_TOKEN_80);
    console.log(`Fetched ${app80Records.length} records from App 80`);
    
    // Process CA data
    const caMap = {};
    for (let record of app325Records) {
      const caName = getFieldValue(record, ['CA_name', 'ca_name']);
      const division = getFieldValue(record, ['division', 'Department']);
      
      if (!caName) continue;
      
      if (!caMap[caName]) {
        caMap[caName] = {
          name: caName,
          division: division || '部門不明',
          summary: {
            interview_conducted: 0,
            projects_created: 0,
            conversion_rate: 0,
            recommendations: 0
          }
        };
      }
      
      caMap[caName].summary.projects_created += 1;
    }
    
    const caList = Object.values(caMap).sort((a, b) => 
      b.summary.projects_created - a.summary.projects_created
    );
    
    // Process RA data
    const raMap = {};
    for (let record of app80Records) {
      const raName = getFieldValue(record, ['recommend_by', 'recommended_by', 'recommender']);
      const team = getFieldValue(record, ['team']);
      const subtable = getFieldValue(record, ['deal_status_1']);
      
      if (!raName) continue;
      
      if (!raMap[raName]) {
        raMap[raName] = {
          name: raName,
          team: team || 'チーム不明',
          grades: { D: 0, 'D+': 0, C: 0, B: 0, A: 0 },
          grade_score: 0,
          points: 0,
          total_deals: 0
        };
      }
      
      const grade = determineGrade(subtable);
      raMap[raName].grades[grade] += 1;
      raMap[raName].total_deals += 1;
    }
    
    // Calculate grade scores and points
    const raList = Object.values(raMap).map(ra => {
      const weights = { A: 1.0, B: 0.75, C: 0.5, 'D+': 0.25, D: 0.1 };
      let totalWeight = 0;
      for (let grade in ra.grades) {
        totalWeight += ra.grades[grade] * weights[grade];
      }
      ra.grade_score = ra.total_deals > 0 ? (totalWeight / ra.total_deals).toFixed(2) : 0;
      ra.points = ra.total_deals * 10;
      return ra;
    }).sort((a, b) => parseFloat(b.grade_score) - parseFloat(a.grade_score));
    
    // Create output
    const output = {
      lastUpdate: new Date().toISOString(),
      ca_list: caList,
      ra_list: raList,
      summary: {
        total_interviews: app80Records.length,
        total_projects: app325Records.length,
        total_points: raList.reduce((sum, ra) => sum + ra.points, 0)
      }
    };
    
    // Write to file
    fs.writeFileSync('output/data.json', JSON.stringify(output, null, 2), 'utf-8');
    console.log('Data saved to output/data.json');
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
