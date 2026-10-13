'use strict';
/**
 * autoSign 云函数 - Trae + WorkBuddy 自动签到
 *
 * 2026-09-17 修复:
 *   1. Trae 请求 URL 加 version/packageType/platform/storeCountryCode 查询参数
 *      (官方客户端所有请求都带这些参数,缺失时 claim 接口风控返回 9074)
 *   2. 日志去掉重复前缀和反引号,提升可读性
 *   3. host 支持从配置读取,自动去掉反引号
 *
 * 2026-09-28 资源优化与修复(与 v2 对齐):
 *   1. 入口"当日幂等":先查 sign_log,今日已成功的平台直接跳过(抵御定时 at-least-once 重复投递)
 *   2. 三平台由串行改为 Promise.allSettled 并行,端到端耗时 = 最慢的单个平台
 *   3. 超时收紧:查询类 8s / claim 类 10s;Trae 9074 重试收紧为 2 次(sleep 1s/3s)
 *   4. date 字段改用北京时间(UTC+8),修复凌晨写库日期错一天
 *   5. Qoder:修复 claimable 判定先于 campaigns 检查的时序坑;已签/已领取出口统一回写 sign_log
 *
 * 2026-10-12 修复(假成功,与 v2 ff93070 对齐):
 *   1. Qoder 401/TOKEN_EXPIRE 被误判为"今日已领取或无可领取活动"并写入 sign_log(success=true)
 *      → 新增"响应校验先于语义判定":HTTP 401/403、非 200、业务错误码一律判失败,不写日志
 *   2. Qoder claim 阶段的硬错误(401/网络)不再被粉饰成"今日已领取(无新增)"
 *   3. Trae/WorkBuddy:401/超时不再输出 code=undefined,统一提示"凭证已失效,请更新凭证"
 *
 * 2026-10-12 日志可读性(并行日志分不清归属):
 *   1. postRequest/getRequest 新增 tag 参数,所有请求/响应日志带 `[平台] ` 前缀
 *      —— 三平台 Promise.allSettled 并行,原日志只有 2 空格缩进,无法归属
 *   2. 响应体改打"紧凑单行 JSON"(完整且量小),解析失败才回落压缩后的原文
 *      —— 原样打 pretty JSON 会让一条响应横跨多行,与别家日志交错后彻底糊掉
 *   3. 删除调用点 7 处重复的响应打印(helper 已打,调用点又打一遍)
 */

const https = require('https');

// ---------- 日志函数 ----------
// uniCloud 会自动加 [autoSign][USER][INFO] 前缀,这里不再重复加
function log(msg) {
  console.log(typeof msg === 'object' ? JSON.stringify(msg) : msg);
}

// 超时收紧:查询类 8s / claim 类 10s(接口正常 1~2s 内响应,原 15s 纯属浪费 GBs)
const TIMEOUT_QUERY = 8000;
const TIMEOUT_CLAIM = 10000;

// 今日日期(北京时间 UTC+8):云函数容器为 UTC,直接 toISOString 在 00:00~08:00 会得到"昨天"
const todayCN = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

// 日志用:把响应体压成单行,避免后端格式化 JSON 的换行把一条日志撑成多行
// (三平台并行时,多行响应体与别家日志交错,会彻底看不出归属)
function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s*\n\s*/g, ' ').slice(0, 1000);
}

// ---------- HTTP POST ----------
// tag:平台名(如 'Qoder'),用于给并发日志打标识 —— 三平台 Promise.allSettled 并行,
//      不加 tag 时 "[GET] .../  响应:" 交给谁全靠猜
function postRequest(url, headers, body, timeout = TIMEOUT_QUERY, tag = '') {
  const p = tag ? `[${tag}] ` : '';
  return new Promise((resolve) => {
    const u = new URL(url);
    const payload = Buffer.from(JSON.stringify(body || {}));
    log(`${p}[POST] ${url}`);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': payload.length
      }, headers)
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        log(`${p}  HTTP ${res.statusCode}`);
        // 响应体:能解析就打"紧凑单行 JSON"(量小且完整),否则回落压缩后的原文。
        // 调用点原先各自再打印一遍响应(重复),已删除 —— 故此处必须打全,不能只靠截断原文。
        let json;
        try { json = JSON.parse(raw); } catch { json = undefined; }
        log(`${p}  响应: ${json !== undefined ? JSON.stringify(json).slice(0, 1000) : oneLine(raw)}`);
        resolve(json !== undefined ? { ok: true, http: res.statusCode, json, raw } : { ok: true, http: res.statusCode, raw });
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.write(payload);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- HTTP GET ----------
function getRequest(url, headers, timeout = TIMEOUT_QUERY, tag = '') {
  const p = tag ? `[${tag}] ` : '';
  return new Promise((resolve) => {
    const u = new URL(url);
    log(`${p}[GET] ${url}`);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        log(`${p}  HTTP ${res.statusCode}`);
        // 响应体:能解析就打"紧凑单行 JSON"(量小且完整),否则回落压缩后的原文。
        // 调用点原先各自再打印一遍响应(重复),已删除 —— 故此处必须打全,不能只靠截断原文。
        let json;
        try { json = JSON.parse(raw); } catch { json = undefined; }
        log(`${p}  响应: ${json !== undefined ? JSON.stringify(json).slice(0, 1000) : oneLine(raw)}`);
        resolve(json !== undefined ? { ok: true, http: res.statusCode, json, raw } : { ok: true, http: res.statusCode, raw });
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// ---------- 响应校验(核心:避免把 401/业务错误码误判成"今日已签") ----------
// 传输层/HTTP 层错误。成功响应必然是 HTTP 200,故 4xx/5xx 一律判错。
function httpErr(res, label) {
  if (!res) return { message: `${label} 无响应`, credentialInvalid: false };
  if (res.ok === false) return { message: `${label} 请求失败: ${res.error || '网络错误/超时'}`, credentialInvalid: false };
  if (res.http === 401 || res.http === 403) {
    const j = res.json || {};
    return {
      message: `${label} 凭证已失效(${j.code || j.message || ('HTTP ' + res.http)}),请更新凭证`,
      credentialInvalid: true
    };
  }
  if (res.http !== 200) return { message: `${label} 接口异常: HTTP ${res.http}`, credentialInvalid: false };
  return null;
}

const AUTH_CODE_RE = /TOKEN|AUTH|UNAUTHORIZED|EXPIRE|LOGIN/i;

// 传输层错误 + 业务错误码(code 存在且非 0)。
// 用于结构未知的接口(如 Qoder campaigns):校验必须先于语义判定 ——
// 否则 401 响应里根本没有 campaigns 字段,会被读成"无可领取活动" => 假成功。
function respErr(res, label) {
  const e = httpErr(res, label);
  if (e) return e;
  const j = res.json;
  if (!j || typeof j !== 'object') return { message: `${label} 响应无法解析: ${String(res.raw || '').slice(0, 200)}`, credentialInvalid: false };
  const code = j.code;
  if (code === undefined || code === null || code === 0 || code === '0') return null;
  const detail = j.message || j.msg || '';
  const authish = AUTH_CODE_RE.test(String(code) + ' ' + String(detail));
  return {
    message: `${label} ${authish ? '凭证已失效' : '接口返回错误'}[${code}${detail ? ': ' + detail : ''}]${authish ? ',请更新凭证' : ''}`,
    credentialInvalid: authish
  };
}

function mkErr(message, credentialInvalid) {
  const e = new Error(message);
  e.credentialInvalid = !!credentialInvalid;
  return e;
}

// ---------- 主入口 ----------
exports.main = async function (event, context) {
  const db = uniCloud.database();
  const configCol = db.collection('auto_sign_config');

  let platforms = event && event.platform ? [event.platform] : ['trae', 'workbuddy', 'qoder'];
  const results = {};
  const today = todayCN();

  // 当日幂等:先查 sign_log,今日已有成功记录的平台直接跳过
  // (抵御 uniCloud 定时触发 at-least-once 重复投递,不再重复跑 claim/烧 GBs)
  try {
    const cmd = db.command;
    const doneRes = await db.collection('sign_log')
      .where({ platform: cmd.in(platforms), date: today, success: true })
      .field({ platform: true })
      .get();
    const doneSet = new Set((doneRes.data || []).map(d => d.platform));
    for (const p of platforms) {
      if (doneSet.has(p)) {
        results[p] = { success: true, message: '今日已签到(当日幂等跳过)', alreadyCheckedIn: true };
        log(`[幂等] ${p}: 今日已有成功记录,跳过`);
      }
    }
    platforms = platforms.filter(p => !doneSet.has(p));
  } catch (e) {
    log(`[幂等检查失败,继续正常签到] ${e.message}`);
  }

  // 三平台并行执行(互不依赖);Promise.allSettled 兜底单平台异常,不影响其他平台
  const settled = await Promise.allSettled(platforms.map(platform => runPlatform(platform, configCol, db)));
  platforms.forEach((platform, i) => {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      results[platform] = s.value;
      log(`[结果] ${platform}: ${s.value && s.value.message}`);
    } else {
      const msg = (s.reason && s.reason.message) || String(s.reason);
      results[platform] = { success: false, message: msg, credentialInvalid: !!(s.reason && s.reason.credentialInvalid) };
      log(`[异常] ${platform}: ${msg}`);
    }
  });

  return { code: 0, data: results };
};

// ---------- 单平台执行(配置读取 + 分发) ----------
async function runPlatform(platform, configCol, db) {
  log(`========== ${platform} 开始签到 ==========`);
  const cfgDoc = await configCol.doc(platform).get();
  const cfg = cfgDoc.data && cfgDoc.data[0];
  if (!cfg) {
    log(`[结果] ${platform}: 配置不存在`);
    return { success: false, message: `配置 ${platform} 不存在` };
  }
  if (cfg.enable === false) {
    log(`[结果] ${platform}: 已禁用`);
    return { success: false, message: `${platform} 已禁用` };
  }

  if (platform === 'trae') return await checkinTrae(cfg, db);
  if (platform === 'workbuddy') return await checkinWorkBuddy(cfg, db);
  if (platform === 'qoder') return await checkinQoder(cfg, db);
  return { success: false, message: `未知平台: ${platform}` };
}

// ---------- Qoder CN 签到 ----------
// 领取接口:GET /sash/api/v1/me/campaigns 拿活动列表(每天 campaignId 会变),
//          然后 POST /sash/api/v1/me/campaigns/{campaignId}/claim 领取。
// 仅需要 Bearer token + Cosy-ClientType:10,无设备签名头。
async function checkinQoder(cfg, db) {
  if (!cfg.accessToken) throw new Error('缺少 accessToken');

  const base = 'https://openapi.qoder.com.cn';
  const ctHeaders = {
    'Authorization': `Bearer ${cfg.accessToken}`,
    'Accept': 'application/json',
    'Cosy-ClientType': '10'   // Qoder 桌面端固定值
  };

  // 1. 查活动,找可领取的 CLAIM_BENEFIT campaign
  log('[Qoder] 查询活动列表...');
  const list = await getRequest(
    `${base}/sash/api/v1/me/campaigns`,
    ctHeaders,
    TIMEOUT_QUERY,
    'Qoder'
  );

  // ★先校验响应本身:401/TOKEN_EXPIRE 等错误响应里没有 campaigns 字段,
  //   若直接进语义判定会被读成"无可领取活动" => 误报"今日已领取"并污染 sign_log
  //   (被污染后:当日幂等跳过该平台,当日无法恢复)
  const qErr = respErr(list, 'Qoder campaigns');
  if (qErr) {
    log(`[结果] qoder: ${qErr.message}`);
    return { success: false, credentialInvalid: qErr.credentialInvalid, message: qErr.message };
  }

  // 找 CLAIM_BENEFIT campaign(每天 campaignId 会变),区分"可领取"与"已领取"
  const allClaim = ((list.json && list.json.campaigns) || []).filter(c =>
    c && c.actionType === 'CLAIM_BENEFIT'
  );
  const campaigns = allClaim.filter(c => c.claimStatus === 'CLAIMABLE');
  const claimedCamps = allClaim.filter(c => c.claimStatus === 'CLAIMED');

  // 以 campaigns 实际状态为准:CLAIMED => 今日已领取(签到成功,幂等);
  // 既无 CLAIMABLE 也无 CLAIMED 才判"活动未开启",避免把已领取误报成未开启
  if (campaigns.length === 0) {
    if (claimedCamps.length > 0) {
      const msg = '今日已领取(签到成功,幂等)';
      await writeSignLog(db, 'qoder', true, msg); // 回写,保证入口当日幂等能命中
      return { success: true, message: msg, alreadyCheckedIn: true };
    }
    return { success: false, message: '今日无待领取活动或活动未开启' };
  }

  // 2. 逐个领取 CLAIMABLE 的活动
  let claimed = 0, totalCredit = 0, claimFail = null;
  for (const camp of campaigns) {
    const cid = camp.campaignId;
    const amount = camp.benefit?.amount || 0;
    log(`[Qoder] 领取活动 ${cid} (+${amount} Credits)...`);
    const claim = await postRequest(
      `${base}/sash/api/v1/me/campaigns/${cid}/claim`,
      Object.assign({}, ctHeaders, { 'Content-Type': 'application/json' }),
      {},
      TIMEOUT_CLAIM,
      'Qoder'
    );

    // 硬错误(401/网络/5xx)不计入"已领取",否则又会退化成假成功
    const cErr = httpErr(claim, `Qoder claim(${cid})`);
    if (cErr) {
      claimFail = cErr;
      log(`[Qoder] 活动 ${cid} 领取失败: ${cErr.message}`);
      continue;
    }

    if (claim.json && claim.json.status === 'CLAIMED') {
      claimed++;
      totalCredit += amount;
    } else if (claim.json && claim.json.replayed === true) {
      log(`[Qoder] 活动 ${cid} 已领取过(replayed),跳过`); // 已领取,跳过
    } else {
      claimFail = { message: `活动 ${cid} 领取失败: ${(claim.json && (claim.json.message || claim.json.code)) || claim.raw || '未知响应'}`, credentialInvalid: false };
      log(`[Qoder] 活动 ${cid} 领取失败: ${JSON.stringify(claim.json || claim.raw)}`);
    }
  }

  if (claimed === 0) {
    // 有真实失败原因时如实上报,不再统一粉饰成"已领取"
    if (claimFail) {
      return { success: false, credentialInvalid: claimFail.credentialInvalid, message: `Qoder 领取失败: ${claimFail.message}` };
    }
    await writeSignLog(db, 'qoder', true, '今日已领取(无新增)'); // 回写,保证入口当日幂等能命中
    return { success: true, message: '今日已领取(无新增)', alreadyCheckedIn: true };
  }

  await writeSignLog(db, 'qoder', true, `签到成功 +${totalCredit} Credits,共${claimed}项`, { credit: totalCredit, count: claimed });
  return { success: true, message: `签到成功 +${totalCredit} Credits,共${claimed}项`, credit: totalCredit };
}

// ---------- Trae 签到 ----------
async function checkinTrae(cfg, db) {
  if (!cfg.accessToken) throw new Error('缺少 accessToken');
  if (!cfg.deviceId) throw new Error('缺少 deviceId');

  const base = (cfg.host || 'https://api.trae.cn').replace(/`/g, '').trim();

  // ★按官方客户端成功脚本的最小请求头集合
  // 关键:X-User-Region 头(从 envelope userRegion.region 读取),缺失时 claim 返回 9074
  const headers = {
    'Authorization': `Cloud-IDE-JWT ${cfg.accessToken}`,
    'Content-Type': 'application/json',
    'x-device-id': cfg.deviceId
  };
  if (cfg.userRegion) headers['X-User-Region'] = cfg.userRegion;

  // POST body = { req_source: 1 }(从成功脚本确认,不是 2)
  const postBody = { req_source: 1 };

  // 1. 查询签到状态
  log('[Trae] 查询签到状态...');
  const status = await postRequest(
    `${base}/trae/api/v2/ug/checkin_credits/status`,
    headers, postBody, TIMEOUT_QUERY, 'Trae'
  );

  // ★先校验响应本身(401/非 200/网络错误),再进语义判定
  const traeHttpErr = httpErr(status, 'Trae status');
  if (traeHttpErr) throw mkErr(traeHttpErr.message, traeHttpErr.credentialInvalid);

  if (!status.json || status.json.code !== 0) {
    const detail = (status.json && (status.json.message || status.json.msg)) || status.raw;
    const authish = !!status.json && (status.json.enable === false || AUTH_CODE_RE.test(String(status.json.code) + ' ' + String(detail)));
    throw mkErr(`status 异常: code=${status.json && status.json.code}, msg=${detail}` + (authish ? ' (凭证已失效,请更新凭证)' : ''), authish);
  }

  if (status.json.enable === false) {
    return { success: false, message: '签到活动未开启' };
  }

  // Trae 已签到:顶层 checked_in / did_checked_in
  if (status.json.checked_in === true || status.json.did_checked_in === true) {
    await writeSignLog(db, 'trae', true, '今日已签到(实时状态确认)'); // 回写,保证入口当日幂等能命中
    return { success: true, message: '今日已签到,跳过', alreadyCheckedIn: true };
  }

  // 2. 调 claim 接口签到(带重试;收紧为 2 次,sleep 1s/3s,原 2s/5s/10s 烧 GBs)
  const maxRetry = 2;
  const retryDelays = [1000, 3000];

  for (let i = 0; i < maxRetry; i++) {
    log(`[Trae] 调用 claim 接口(第${i + 1}次)...`);
    const claim = await postRequest(
      `${base}/trae/api/v2/ug/checkin_credits/claim`,
      headers, postBody, TIMEOUT_CLAIM, 'Trae'
    );

    if (claim.json && claim.json.code === 0) {
      const points = claim.json.data?.points || claim.json.points || status.json.credits || 200;
      await writeSignLog(db, 'trae', true, `签到成功 +${points} 积分`, { points, claim: claim.json });
      return { success: true, message: `签到成功 +${points} 积分`, points };
    }

    if (claim.json && claim.json.code === 1001) {
      await writeSignLog(db, 'trae', true, '今日已签到(claim 返回 1001)');
      return { success: true, message: '今日已签到', alreadyCheckedIn: true };
    }

    if (claim.json && claim.json.code === 9074) {
      if (i < maxRetry - 1) {
        const delay = retryDelays[i];
        log(`[Trae] 9074 限流,${delay}ms 后重试`);
        await sleep(delay);
        continue;
      }
      // 重试用完,回查 status
      log('[Trae] 重试用尽,回查 status...');
      const reCheck = await postRequest(
        `${base}/trae/api/v2/ug/checkin_credits/status`,
        headers, postBody, TIMEOUT_QUERY, 'Trae'
      );
      if (reCheck.json && (reCheck.json.checked_in === true || reCheck.json.did_checked_in === true)) {
        await writeSignLog(db, 'trae', true, '今日已签到(claim 限流但回查已到账)');
        return { success: true, message: '今日已签到(claim 限流但回查已到账)', alreadyCheckedIn: true };
      }
      return { success: false, message: `签到失败: 9074 限流,重试${maxRetry}次仍未成功` };
    }

    const msg = claim.json?.message || claim.raw || '未知错误';
    return { success: false, message: `签到失败: ${msg}` };
  }

  return { success: false, message: '签到失败: 重试用尽' };
}

// ---------- WorkBuddy 签到 ----------
async function checkinWorkBuddy(cfg, db) {
  if (!cfg.accessToken) throw new Error('缺少 accessToken');
  if (!cfg.uid) throw new Error('缺少 uid');

  const base = 'https://www.codebuddy.cn';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cfg.accessToken}`,
    'X-User-Id': String(cfg.uid)
  };

  // 1. 查询签到状态
  log('[WorkBuddy] 查询签到状态...');
  const status = await postRequest(
    `${base}/v2/billing/meter/checkin-activity-status`,
    headers, {}, TIMEOUT_QUERY, 'WorkBuddy'
  );

  // ★先校验响应本身(401/非 200/网络错误),再进语义判定
  const wbHttpErr = httpErr(status, 'WorkBuddy status');
  if (wbHttpErr) throw mkErr(wbHttpErr.message, wbHttpErr.credentialInvalid);

  if (!status.json || status.json.code !== 0) {
    const detail = (status.json && (status.json.msg || status.json.message)) || status.raw;
    const authish = !!status.json && AUTH_CODE_RE.test(String(status.json.code) + ' ' + String(detail));
    throw mkErr(`status 异常: code=${status.json && status.json.code}, msg=${detail}` + (authish ? ' (凭证已失效,请更新凭证)' : ''), authish);
  }

  if (status.json.data?.active === false) {
    return { success: false, message: '签到活动未开启' };
  }

  // WorkBuddy 已签到:data.today_checked_in
  if (status.json.data?.today_checked_in === true) {
    await writeSignLog(db, 'workbuddy', true, '今日已签到(实时状态确认)'); // 回写,保证入口当日幂等能命中
    return { success: true, message: '今日已签到,跳过', alreadyCheckedIn: true };
  }

  // 2. 调 claim 接口签到
  log('[WorkBuddy] 调用 claim 接口...');
  const claim = await postRequest(
    `${base}/v2/billing/meter/daily-checkin`,
    headers, {}, TIMEOUT_CLAIM, 'WorkBuddy'
  );

  if (claim.json && claim.json.code === 0) {
    const credit = claim.json.data?.credit || 0;
    const streak = claim.json.data?.streak_days || 0;
    await writeSignLog(db, 'workbuddy', true, `签到成功 +${credit} 积分,连签${streak}天`, { credit, streak, claim: claim.json });
    return { success: true, message: `签到成功 +${credit} 积分,连签${streak}天`, credit, streak };
  }

  // WorkBuddy 幂等码:10001 = 今日已签到
  if (claim.json && claim.json.code === 10001) {
    await writeSignLog(db, 'workbuddy', true, '今日已签到(claim 返回 10001)');
    return { success: true, message: '今日已签到', alreadyCheckedIn: true };
  }

  const msg = claim.json?.msg || claim.raw || '未知错误';
  return { success: false, message: `签到失败: ${msg}` };
}

// ---------- 写签到日志 ----------
async function writeSignLog(db, platform, success, message, extra = {}) {
  try {
    await db.collection('sign_log').add({
      platform,
      success,
      message,
      created_at: Date.now(),
      date: todayCN(),
      ...extra
    });
  } catch (e) {
    log(`[写日志失败] ${platform}: ${e.message}`);
  }
}
