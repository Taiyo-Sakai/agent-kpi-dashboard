const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const KINTONE_BASE_URL = process.env.KINTONE_BASE_URL;
const KINTONE_API_TOKEN_80 = process.env.KINTONE_API_TOKEN_80;
const KINTONE_API_TOKEN_325 = process.env.KINTONE_API_TOKEN_325;
const FULL_FETCH = process.env.FULL_FETCH === 'true';

const OUTPUT_DIR = path.join(__dirname, 'output');
const CACHE_FILE = path.join(OUTPUT_DIR, 'ra_cache.json');
const DATA_FILE = path.join(OUTPUT_DIR, 'data.json');

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

function getTeamName(record) {
  const orgs = (record['tanto_organization'] && record['tanto_organization'].value) || [];
  const skip = ['エージェント', '建設Ⅰ部', '建設Ⅱ部', '不動産部', '電気主任・製造部',
                '士業部', 'Dについてが分かる', 'Xについてが分かる', '掘り起こし希望者'];
  const team = orgs.find(org => !skip.includes(org.name));
  return team ? team.name : null;
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

async function fetchAndProcess(appId, token, query, fields, processRecord) {
  let offset = 0;
  let total = 0;
  const limit = 500;
  const fieldParams = fields.map((f, i) => `&fields[${i}]=${encodeURIComponent(f)}`).join('');

  // カーソルAPIで取得
  const createRes = await fetch(`${KINTONE_BASE_URL}/k/v1/records/cursor.json`, {
    method: 'POST',
    headers: { 'X-Cybozu-API-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: appId, query, fields, size: 500 })
  });
  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`カーソル作成失敗 App${appId}: ${createRes.status} - ${err}`);
  }
  const { id: cursorId } = await createRes.json();

  let next = true;
  while (next) {
    const res = await fetch(`${KINTONE_BASE_URL}/k/v1/records/cursor.json?id=${cursorId}`, {
      method: 'GET',
      headers: { 'X-Cybozu-API-Token': token }
    });
    if (!res.ok) throw new Error(`カーソル取得失敗: ${res.status}`);
    const data = await res.json();
    for (const record of data.records) processRecord(record);
    total += data.records.length;
    next = data.next;
    if (total % 5000 === 0) console.log(`  App${appId}: ${total}件処理中...`);
  }
  console.log(`App${appId}: ${total}件完了`);
  return total;
}

function buildRaMap(raCache) {
  const raMap = {};
  for (const [id, rec] of Object.entries(raCache.records || {})) {
    const { raName, team, grade } = rec;
    if (!raName) continue;
    if (!raMap[raName]) {
      raMap[raName] = { name: raName, team: team || 'チーム不明', grades: { D: 0, 'D+': 0, C: 0, B: 0, A: 0 }, total_deals: 0 };
    }
    raMap[raName].grades[grade] = (raMap[raName].grades[grade] || 0) + 1;
    raMap[raName].total_deals += 1;
  }
  return raMap;
}


// ===== 部署判定（App325のtantou_soshikiから）=====
const DEPT_MAP = {
  '建設Ⅰ部': '建設Ⅰ部',
  '建設Ⅱ部': '建設Ⅱ部',
  '不動産部': '不動産部',
  '電気主任・製造部': '電気主任・製造部',
  '士業部': '士業部',
};
function getDepartment(record) {
  const orgs = (record['tantou_soshiki'] && record['tantou_soshiki'].value) || [];
  const orgNames = orgs.map(o => o.name);
  for (const [key] of Object.entries(DEPT_MAP)) {
    if (orgNames.includes(key)) return key;
  }
  return 'その他';
}

// ===== 月次集計（成約数・売上を月次・部署別）=====
async function fetchMonthly(token) {
  const monthly = {};
  // 即戦力人材（メイン）+ REAクエリ
  const QUERIES = [
    'sakusei_Nichiji >= "2025-01-01T00:00:00+0900" and seiyaku_Shuryui in ("即戦力人材") order by $id desc',
    'sakusei_Nichiji >= "2025-01-01T00:00:00+0900" and seiyaku_Shuryui in ("HH（着手金）","コンサルティング","フリーランス","リファラル") and soshiki_drop in ("エージェント") order by $id desc'
  ];
  const fields = ['seiyaku_date', 'seikyu_taxfree', 'uriage_henkin', 'tantou_soshiki', 'Tanto'];

  // 成約データ集計
  for (const query of QUERIES) {
    const createRes = await fetch(`${KINTONE_BASE_URL}/k/v1/records/cursor.json`, {
      method: 'POST',
      headers: { 'X-Cybozu-API-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 325, query, fields, size: 500 })
    });
    if (!createRes.ok) { console.log(`成約クエリスキップ: ${createRes.status}`); continue; }
    const { id: cursorId } = await createRes.json();
    let next = true;
    while (next) {
      const res = await fetch(`${KINTONE_BASE_URL}/k/v1/records/cursor.json?id=${cursorId}`, {
        method: 'GET', headers: { 'X-Cybozu-API-Token': token }
      });
      const data = await res.json();
      for (const record of data.records) {
        const seiyakuDate = record['seiyaku_date'] && record['seiyaku_date'].value;
        if (!seiyakuDate) continue;
        const month = seiyakuDate.substring(0, 7);
        const uriage = parseFloat(record['seikyu_taxfree']?.value || 0);
        const uriageAfter = parseFloat(record['uriage_henkin']?.value || 0);
        const dept = getDepartment(record);
        const emptyEntry = { count: 0, uriage: 0, uriage_after: 0, henkin_nyushamae: 0, henkin_nyushamae_cnt: 0, henkin_hayaki: 0, henkin_hayaki_cnt: 0 };
        if (!monthly[month]) monthly[month] = { 全体: {...emptyEntry} };
        if (!monthly[month][dept]) monthly[month][dept] = {...emptyEntry};
        ['全体', dept].forEach(key => {
          monthly[month][key].count += 1;
          monthly[month][key].uriage += uriage;
          monthly[month][key].uriage_after += uriageAfter;
        });
      }
      next = data.next;
    }
  }
  console.log('成約データ集計完了');

  // 返金データ集計（返金発生日基準）
  const REFUND_QUERIES = [
    'Henkin_Hasseibi >= "2025-01-01" and seiyaku_Shuryui in ("即戦力人材") order by $id desc',
    'Henkin_Hasseibi >= "2025-01-01" and seiyaku_Shuryui in ("HH（着手金）","コンサルティング","フリーランス","リファラル") and soshiki_drop in ("エージェント") order by $id desc'
  ];
  const refundFields = ['Henkin_Hasseibi', 'Henkin_Kingaku', '返金種類', 'tantou_soshiki'];

  for (const rq of REFUND_QUERIES) {
    const createRes = await fetch(`${KINTONE_BASE_URL}/k/v1/records/cursor.json`, {
      method: 'POST',
      headers: { 'X-Cybozu-API-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 325, query: rq, fields: refundFields, size: 500 })
    });
    if (!createRes.ok) { console.log(`返金クエリスキップ: ${createRes.status}`); continue; }
    const { id: cursorId } = await createRes.json();
    let next = true;
    while (next) {
      const res = await fetch(`${KINTONE_BASE_URL}/k/v1/records/cursor.json?id=${cursorId}`, {
        method: 'GET', headers: { 'X-Cybozu-API-Token': token }
      });
      const rdata = await res.json();
      for (const record of rdata.records) {
        const henkinDate = record['Henkin_Hasseibi'] && record['Henkin_Hasseibi'].value;
        if (!henkinDate) continue;
        const henkinMonth = henkinDate.substring(0, 7);
        const henkinAmt = parseFloat(record['Henkin_Kingaku']?.value || 0);
        if (henkinAmt <= 0) continue;
        const henkinType = record['返金種類']?.value || '';
        const isNyushaMae = henkinType === '入社前辞退' || henkinType === '内定取消';
        const isHayaki = henkinType === '早期離職';
        const emptyEntry = { count: 0, uriage: 0, uriage_after: 0, henkin_nyushamae: 0, henkin_nyushamae_cnt: 0, henkin_hayaki: 0, henkin_hayaki_cnt: 0 };
        if (!monthly[henkinMonth]) monthly[henkinMonth] = { 全体: {...emptyEntry} };
        if (!monthly[henkinMonth]['全体']) monthly[henkinMonth]['全体'] = {...emptyEntry};
        if (isNyushaMae) { monthly[henkinMonth]['全体'].henkin_nyushamae = (monthly[henkinMonth]['全体'].henkin_nyushamae || 0) + henkinAmt; monthly[henkinMonth]['全体'].henkin_nyushamae_cnt = (monthly[henkinMonth]['全体'].henkin_nyushamae_cnt || 0) + 1; }
        if (isHayaki) { monthly[henkinMonth]['全体'].henkin_hayaki = (monthly[henkinMonth]['全体'].henkin_hayaki || 0) + henkinAmt; monthly[henkinMonth]['全体'].henkin_hayaki_cnt = (monthly[henkinMonth]['全体'].henkin_hayaki_cnt || 0) + 1; }
      }
      next = rdata.next;
    }
  }

  // 万円変換
  for (const m of Object.values(monthly)) {
    for (const d of Object.values(m)) {
      d.uriage = Math.round(d.uriage / 10000);
      d.uriage_after = Math.round(d.uriage_after / 10000);
      d.henkin_nyushamae = Math.round((d.henkin_nyushamae || 0) / 10000);
      d.henkin_hayaki = Math.round((d.henkin_hayaki || 0) / 10000);
    }
  }
  console.log(`月次集計完了: ${Object.keys(monthly).sort().join(', ')}`);
  return monthly;
}


async function main() {
  try {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // --- RAキャッシュ読み込み ---
    let raCache = { lastSync: null, records: {} };
    if (!FULL_FETCH && fs.existsSync(CACHE_FILE)) {
      raCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      console.log(`キャッシュ読み込み: ${Object.keys(raCache.records).length}件 / 最終同期: ${raCache.lastSync}`);
    }

    // --- App80クエリ決定 ---
    let app80Query;
    if (FULL_FETCH || !raCache.lastSync) {
      app80Query = 'registration_date >= "2025-01-01" order by $id asc';
      console.log('モード: 全件取得（2025年1月以降）');
      if (FULL_FETCH) raCache.records = {}; // フル取得時はキャッシュをリセット
    } else {
      // 差分取得: 前回同期時刻以降に更新されたレコードのみ
      const lastSyncJST = new Date(raCache.lastSync).toISOString().replace('Z', '+0900').replace(/\+09:?00$/, '+0900');
      app80Query = `updated_datetime > "${raCache.lastSync.replace('Z', '+0000')}" order by $id asc`;
      console.log(`モード: 差分取得（${raCache.lastSync} 以降）`);
    }

    // --- App80差分/全件取得 ---
    const now = new Date().toISOString();
    console.log('月次集計開始...');
    const monthly = await fetchMonthly(KINTONE_API_TOKEN_325);
    let app80Count = 0;
    app80Count = await fetchAndProcess(
      80, KINTONE_API_TOKEN_80, app80Query,
      ['$id', 'tanto', 'tanto_organization', 'deal_status_1'],
      (record) => {
        const id = record['$id'] && record['$id'].value;
        if (!id) return;
        const raName = getSelectName(record, 'tanto');
        if (!raName) return;
        const team = getTeamName(record);
        const subtable = getFieldValue(record, 'deal_status_1');
        const grade = determineGrade(subtable);
        raCache.records[id] = { raName, team, grade };
      }
    );

    raCache.lastSync = now;
    fs.writeFileSync(CACHE_FILE, JSON.stringify(raCache));
    console.log(`キャッシュ保存: ${Object.keys(raCache.records).length}件`);

    // --- App325 CA取得（今年度分） ---
    const now2 = new Date();
    const fiscalYear = now2.getMonth() >= 3 ? now2.getFullYear() : now2.getFullYear() - 1;
    const fromDate = `${fiscalYear}-04-01`;

    const caMap = {};
    const total325 = await fetchAndProcess(
      325, KINTONE_API_TOKEN_325,
      `sakusei_Nichiji >= "${fromDate}T00:00:00+0900" order by $id desc`,
      ['Tanto', 'tantou_soshiki'],
      (record) => {
        const caOrgs = (record['tantou_soshiki'] && record['tantou_soshiki'].value) || [];
        const isAgent = caOrgs.some(org => org.name === 'エージェント');
        if (!isAgent) return;
        const caName = getSelectName(record, 'Tanto');
        if (!caName) return;
        const division = caOrgs.find(org => org.name !== 'エージェント')?.name || '部門不明';
        if (!caMap[caName]) caMap[caName] = { name: caName, division, summary: { projects_created: 0 } };
        caMap[caName].summary.projects_created += 1;
      }
    );

    // --- raMap 構築 ---
    const raMap = buildRaMap(raCache);
    const raList = Object.values(raMap).map(ra => {
      const weights = { A: 1.0, B: 0.75, C: 0.5, 'D+': 0.25, D: 0.1 };
      let w = 0;
      for (let g in ra.grades) w += (ra.grades[g] || 0) * (weights[g] || 0);
      ra.grade_score = ra.total_deals > 0 ? (w / ra.total_deals).toFixed(2) : '0.00';
      ra.points = ra.total_deals * 10;
      return ra;
    }).sort((a, b) => parseFloat(b.grade_score) - parseFloat(a.grade_score));

    const caList = Object.values(caMap).sort((a, b) => b.summary.projects_created - a.summary.projects_created);

    const output = {
      lastUpdate: now,
      monthly,
      dataFrom: fromDate,
      fullFetch: FULL_FETCH,
      ca_list: caList,
      ra_list: raList,
      summary: {
        total_interviews: Object.keys(raCache.records).length,
        total_projects: total325,
        total_points: raList.reduce((s, r) => s + r.points, 0)
      }
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`✅ 完了！CA: ${caList.length}名, RA: ${raList.length}名`);
    console.log(`   キャッシュ総レコード: ${Object.keys(raCache.records).length}件`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();


