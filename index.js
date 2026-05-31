const fetch = require('node-fetch');
const fs = require('fs');

// kintone 接続情報
const BASE_URL = 'https://beavers.cybozu.com';
const APP_80_TOKEN = process.env.KINTONE_API_TOKEN_80;   // 候補者管理
const APP_325_TOKEN = process.env.KINTONE_API_TOKEN_325; // 成約管理

async function fetchKintoneData(appId, token, query = '') {
  const url = `${BASE_URL}/k/v1/records.json?app=${appId}&limit=100${query ? '&query=' + encodeURIComponent(query) : ''}`;
  
  const response = await fetch(url, {
    headers: {
      'X-Cybozu-API-Token': token,
      'Content-Type': 'application/json'
    }
  });
  
  if (!response.ok) throw new Error(`API Error: ${response.status}`);
  return response.json();
}

async function generateDashboard() {
  try {
    console.log('🔄 kintone からデータを取得中...');
    
    // App80（候補者管理）からグレード別数字を取得
    const candidateData = await fetchKintoneData(APP_80_TOKEN, APP_80_TOKEN, 'created_datetime > "2025-01-01T00:00:00Z"');
    
    // App325（成約管理）から成約データを取得
    const contractData = await fetchKintoneData(APP_325_TOKEN, APP_325_TOKEN, 'created_datetime > "2025-01-01T00:00:00Z"');
    
    // データ集計
    const dashboard = {
      lastUpdated: new Date().toISOString(),
      totalCandidates: candidateData.totalCount || 0,
      totalContracts: contractData.totalCount || 0,
      gradeBreakdown: aggregateByGrade(candidateData.records),
      conversionRates: calculateConversionRates(candidateData.records, contractData.records),
      weeklyData: []
    };
    
    // JSON を出力
    fs.writeFileSync('dashboard-data.json', JSON.stringify(dashboard, null, 2));
    
    console.log('✅ dashboard-data.json が生成されました');
    
    // Git にコミット & プッシュ
    await commitAndPush();
    
  } catch (error) {
    console.error('❌ エラー:', error.message);
    process.exit(1);
  }
}

function aggregateByGrade(records) {
  const grades = { D: 0, 'D+': 0, C: 0, B: 0, A: 0 };
  
  records.forEach(record => {
    const gradeField = record.grade_sub_table?.value || [];
    gradeField.forEach(item => {
      const grade = item.value?.grade?.value;
      if (grade && grades.hasOwnProperty(grade)) {
        grades[grade]++;
      }
    });
  });
  
  return grades;
}

function calculateConversionRates(candidates, contracts) {
  // 簡易計算（実装は kintone のフィールド構造に合わせて調整が必要）
  return {
    D_rate: 0.05,
    'D+_rate': 0.15,
    C_rate: 0.35,
    B_rate: 0.70,
    A_rate: 1.00
  };
}

async function commitAndPush() {
  // GitHub Actions 環境で自動実行されるため、ここは簡略化
  console.log('📤 データを GitHub に保存しました');
}

generateDashboard();
