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
 * 2026-09-28 资源优化与修复:
 *   1. 入口"当日幂等":定时触发先查 sign_log,今日已成功的平台直接跳过(抵御 uniCloud 定时 at-least-once 重复投递)
 *   2. 三平台由串行改为 Promise.allSettled 并行,端到端耗时 = 最慢的单个平台
 *   3. 超时收紧:查询类 8s / claim 类 10s;Trae 9074 重试收紧为 2 次(sleep 1s/3s)
 *   4. date 字段改用北京时间(UTC+8),修复凌晨写库/查缓存日期错一天的问题
 *   5. Qoder:已签/已领取所有出口统一回写 sign_log;修复 claimable 判定先于 campaigns 检查的时序坑
 */

const https = require('https');
const cc = require('crypto-util'); // 凭证加解密(es5 公共模块)

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

// ---------- HTTP POST ----------
function postRequest(url, headers, body, timeout = TIMEOUT_QUERY) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const payload = Buffer.from(JSON.stringify(body || {}));
    log(`[POST] ${url}`);
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
        log(`  HTTP ${res.statusCode}`);
        log(`  响应: ${raw.slice(0, 1000)}`);
        try {
          resolve({ ok: true, http: res.statusCode, json: JSON.parse(raw), raw });
        } catch {
          resolve({ ok: true, http: res.statusCode, raw });
        }
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
function getRequest(url, headers, timeout = TIMEOUT_QUERY) {
  return new Promise((resolve) => {
    const u = new URL(url);
    log(`[GET] ${url}`);
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
        log(`  HTTP ${res.statusCode}`);
        log(`  响应: ${raw.slice(0, 1000)}`);
        try {
          resolve({ ok: true, http: res.statusCode, json: JSON.parse(raw), raw });
        } catch {
          resolve({ ok: true, http: res.statusCode, raw });
        }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// ---------- 主入口 ----------
exports.main = async function (event, context) {
  const db = uniCloud.database();
  const configCol = db.collection('auto_sign_config');

  const statusOnly = event && event.mode === 'status';
  const raw = event && event.platform;
  let platforms = Array.isArray(raw) ? raw : (raw ? [raw] : ['trae', 'workbuddy', 'qoder']);
  const results = {};
  const today = todayCN();

  // 当日幂等:签到模式下先查 sign_log,今日已有成功记录的平台直接跳过
  // (抵御 uniCloud 定时触发 at-least-once 重复投递,不再重复跑 claim/烧 GBs)
  if (!statusOnly) {
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
  }

  // 三平台并行执行(互不依赖);Promise.allSettled 兜底单平台异常,不影响其他平台
  const settled = await Promise.allSettled(platforms.map(platform => runPlatform(platform, configCol, db, statusOnly)));
  platforms.forEach((platform, i) => {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      results[platform] = s.value;
      log(`[结果] ${platform}: ${s.value && s.value.message}`);
    } else {
      const msg = (s.reason && s.reason.message) || String(s.reason);
      results[platform] = { success: false, message: msg };
      log(`[异常] ${platform}: ${msg}`);
    }
  });

  return { code: 0, data: results };
};

// ---------- 单平台执行(配置读取 + 凭证解密 + 分发) ----------
async function runPlatform(platform, configCol, db, statusOnly) {
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

  // 凭证加密兼容:若存在 enc 字段(加密存储),解密覆盖 accessToken;否则沿用旧明文
  if (cfg.enc) {
    const dec = cc.decryptText(cfg.enc);
    if (dec) cfg.accessToken = dec;
    else {
      log(`[结果] ${platform}: 凭证解密失败`);
      return { success: false, message: `${platform} 凭证解密失败(密钥不匹配或数据损坏)` };
    }
  }

  if (platform === 'trae') return await checkinTrae(cfg, db, statusOnly);
  if (platform === 'workbuddy') return await checkinWorkBuddy(cfg, db, statusOnly);
  if (platform === 'qoder') return await checkinQoder(cfg, db, statusOnly);
  return { success: false, message: `未知平台: ${platform}` };
}

// ---------- Qoder CN 签到 ----------
// 领取接口:GET /sash/api/v1/me/campaigns 拿活动列表(每天 campaignId 会变),
//          然后 POST /sash/api/v1/me/campaigns/{campaignId}/claim 领取。
// 仅需要 Bearer token + Cosy-ClientType:10,无设备签名头。
async function checkinQoder(cfg, db, statusOnly) {
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
    TIMEOUT_QUERY
  );
  log(`[Qoder campaigns] ${JSON.stringify(list.json || list.raw)}`);

  // 找可领取的 CLAIM_BENEFIT campaign(每天 campaignId 会变)
  const campaigns = ((list.json && list.json.campaigns) || []).filter(c =>
    c && c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE'
  );

  // statusOnly:判定只看 campaigns(claimable 字段有歧义,历史坑:claimable 判定先于 early-return)
  // 无 CLAIMABLE 活动 => 今日已领取/无可领 => 视为已签
  if (statusOnly) {
    const done = campaigns.length === 0;
    return { success: done, todayCheckedIn: done, message: done ? '今日已领取/无待领取' : '今日未签到' };
  }

  if (campaigns.length === 0) {
    // 时序修复:不再以 claimable!==true 直接判失败,以 campaigns 实际状态为准
    if (list.json && list.json.claimable === false) {
      return { success: false, message: '今日无待领取活动或活动未开启' };
    }
    const msg = '今日已领取或无可领取活动';
    // 已领取也回写日志,让面板"方案B"缓存能命中,不再反复实时查
    await writeSignLog(db, 'qoder', true, msg);
    return { success: true, message: msg, alreadyCheckedIn: true };
  }

  // 2. 逐个领取 CLAIMABLE 的活动
  let claimed = 0, totalCredit = 0;
  for (const camp of campaigns) {
    const cid = camp.campaignId;
    const amount = camp.benefit?.amount || 0;
    log(`[Qoder] 领取活动 ${cid} (+${amount} Credits)...`);
    const claim = await postRequest(
      `${base}/sash/api/v1/me/campaigns/${cid}/claim`,
      Object.assign({}, ctHeaders, { 'Content-Type': 'application/json' }),
      {},
      TIMEOUT_CLAIM
    );
    log(`[Qoder claim] ${JSON.stringify(claim.json || claim.raw)}`);

    if (claim.json && claim.json.status === 'CLAIMED') {
      claimed++;
      totalCredit += amount;
    } else if (claim.json && claim.json.replayed === true) {
      log(`[Qoder] 活动 ${cid} 已领取过(replayed),跳过`); // 已领取,跳过
    } else {
      log(`[Qoder] 活动 ${cid} 领取失败: ${JSON.stringify(claim.json || claim.raw)}`);
    }
  }

  if (claimed === 0) {
    // 已领取(无新增)也回写日志,供面板缓存命中
    await writeSignLog(db, 'qoder', true, '今日已领取(无新增)');
    return { success: true, message: '今日已领取(无新增)', alreadyCheckedIn: true };
  }

  await writeSignLog(db, 'qoder', true, `签到成功 +${totalCredit} Credits,共${claimed}项`, { credit: totalCredit, count: claimed });
  return { success: true, message: `签到成功 +${totalCredit} Credits,共${claimed}项`, credit: totalCredit };
}

// ---------- Trae 签到 ----------
async function checkinTrae(cfg, db, statusOnly) {
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
    headers, postBody, TIMEOUT_QUERY
  );
  log(`[Trae status] ${JSON.stringify(status.json || status.raw)}`);

  if (!status.json || status.json.code !== 0) {
    throw new Error(`status 异常: code=${status.json?.code}, msg=${status.json?.message || status.raw}`);
  }

  if (status.json.enable === false) {
    return { success: false, message: '签到活动未开启' };
  }

  const traeDone = status.json.checked_in === true || status.json.did_checked_in === true;
  if (statusOnly) {
    if (traeDone) return { success: true, todayCheckedIn: true, message: '今日已签到' };
    return { success: false, todayCheckedIn: false, message: '今日未签到' };
  }
  if (traeDone) {
    await writeSignLog(db, 'trae', true, '今日已签到(实时状态确认)');
    return { success: true, message: '今日已签到,跳过', alreadyCheckedIn: true };
  }

  // 2. 调 claim 接口签到(带重试;收紧为 2 次,sleep 1s/3s,原 2s/5s/10s 烧 GBs)
  const maxRetry = 2;
  const retryDelays = [1000, 3000];

  for (let i = 0; i < maxRetry; i++) {
    log(`[Trae] 调用 claim 接口(第${i + 1}次)...`);
    const claim = await postRequest(
      `${base}/trae/api/v2/ug/checkin_credits/claim`,
      headers, postBody, TIMEOUT_CLAIM
    );
    log(`[Trae claim 第${i + 1}次] ${JSON.stringify(claim.json || claim.raw)}`);

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
        headers, postBody, TIMEOUT_QUERY
      );
      log(`[Trae reCheck] ${JSON.stringify(reCheck.json || reCheck.raw)}`);
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
async function checkinWorkBuddy(cfg, db, statusOnly) {
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
    headers, {}, TIMEOUT_QUERY
  );
  log(`[WorkBuddy status] ${JSON.stringify(status.json || status.raw)}`);

  if (!status.json || status.json.code !== 0) {
    throw new Error(`status 异常: code=${status.json?.code}, msg=${status.json?.msg || status.raw}`);
  }

  if (status.json.data?.active === false) {
    return { success: false, message: '签到活动未开启' };
  }

  const wbDone = status.json.data?.today_checked_in === true;
  if (statusOnly) {
    if (wbDone) return { success: true, todayCheckedIn: true, message: '今日已签到' };
    return { success: false, todayCheckedIn: false, message: '今日未签到' };
  }
  if (wbDone) {
    await writeSignLog(db, 'workbuddy', true, '今日已签到(实时状态确认)');
    return { success: true, message: '今日已签到,跳过', alreadyCheckedIn: true };
  }

  // 2. 调 claim 接口签到
  log('[WorkBuddy] 调用 claim 接口...');
  const claim = await postRequest(
    `${base}/v2/billing/meter/daily-checkin`,
    headers, {}, TIMEOUT_CLAIM
  );
  log(`[WorkBuddy claim] ${JSON.stringify(claim.json || claim.raw)}`);

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
