'use strict';
/**
 * auto-sign-api 云函数 - 签到管理面板后端 API
 *
 * 支持两种调用模式(同一套动作契约):
 *   1. uniCloud.callFunction (小程序 / H5 网页托管):  event = { action, headers, body }
 *   2. 云函数 URL 化 (直接 HTTP 访问):                 event = { httpMethod, requestPath, headers, body }
 *
 * 动作:
 *   login       POST  body:{password}            登录,首次运行(无 settings)自动初始化管理口令
 *   status      GET   需鉴权                     返回三平台配置(脱敏) + 最近签到结果
 *   checkin     POST  body:{platform?}           手动触发签到(内部调用 auto-sign),需鉴权
 *   credential  POST  body:{platform,accessToken,...} 凭证加密写入 auto_sign_config 对应平台,需鉴权
 *   import      POST  body:{config:{platform:{accessToken,...}}} 批量加密写入多平台,需鉴权
 *
 * 安全:
 *   - 除 login 外均需 Authorization: Bearer <会话token>
 *   - 回传凭证一律脱敏(绝不回显明文)
 *   - 凭证 AES-256-GCM 加密后入库
 */
const cc = require('../common/crypto-util');
const auth = require('../common/auth-util');

const URL_BASE = 'http://api.uniCloud.aliyun.com/v3/index.html'; // 占位,实际由前端 SDK 调用
const PLATFORMS = ['trae', 'workbuddy', 'qoder'];

// ---------- 响应封装 ----------
function ok(data, message = 'ok') { return { code: 0, message, data }; }
function fail(code, message, data) { return { code, message, data }; }

// 解析 JWT 的 exp(payload 段 base64 解码),非 JWT 返回 null
function jwtExpiry(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = String(token).split('.');
  if (parts.length < 2) return null;
  let payload;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (e) { return null; }
  return (payload && typeof payload.exp === 'number') ? payload.exp * 1000 : null;
}
// ---------- 入参归一化(callFunction 与 URL化 双支持) ----------
function normalizeEvent(event) {
  event = event || {};
  if (event.requestPath || event.httpMethod) {
    // URL化模式:body 可能是 JSON 字符串
    let body = event.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    const path = (event.requestPath || '').split('?')[0];
    const seg = path.split('/').filter(Boolean);
    const action = seg.length ? seg[seg.length - 1].toLowerCase() : '';
    return { action, headers: event.headers || {}, body: body || {} };
  }
  return { action: String(event.action || '').toLowerCase(), headers: event.headers || {}, body: event.body || {} };
}

// 从 header 提取会话 token
function bearerToken(headers) {
  const a = headers['authorization'] || headers['Authorization'] || '';
  const m = /^bearer\s+(.+)$/i.exec(String(a).trim());
  return m ? m[1].trim() : '';
}

// ---------- 动作实现 ----------
// POST /login
async function doLogin(body) {
  const password = body && body.password;
  if (!password || password.length < 6) return fail(400, '口令至少 6 位');
  try {
    const sess = await auth.login(password);
    return ok({ token: sess.token, expires: sess.expiry }, '登录成功');
  } catch (err) {
    // 首次运行:settings 不存在 => 用当前口令初始化(自助管理员)
    if (/尚未初始化/.test(err.message)) {
      await auth.initPassword(password);
      const sess = await auth.login(password);
      return ok({ token: sess.token, expires: sess.expiry, initialized: true }, '已初始化并登录');
    }
    return fail(401, err.message);
  }
}

// GET /status  方案B:缓存优先(今日成功记录) + 兜底实时查(auto-sign mode:status),真签了回写今日记录
async function doStatus(db) {
  const configCol = db.collection('auto_sign_config');
  const logCol = db.collection('sign_log');
  const today = new Date().toISOString().slice(0, 10); // 今日日期 YYYY-MM-DD
  const list = [];
  const needLive = []; // 无今日成功记录、且已配置启用的平台 → 需实时查

  for (const platform of PLATFORMS) {
    const item = { platform, checkedIn: false };
    try {
      const doc = await configCol.doc(platform).get();
      const cfg = doc.data && doc.data[0];
      if (!cfg) { item.configured = false; item.masked = '(未配置)'; }
      else {
        item.configured = true;
        item.enable = cfg.enable !== false;
        let raw = cfg.accessToken;
        if (cfg.enc) { const d = cc.decryptText(cfg.enc); if (d) raw = d; }
        item.masked = raw ? cc.maskToken(raw) : '(未配置)';
        item.meta = { deviceId: cfg.deviceId, host: cfg.host, uid: cfg.uid, userRegion: cfg.userRegion };
        item.expires_at = cfg.expires_at || null;
      }

      // 1) 缓存优先:查今日 date 匹配记录
      const todayRes = await logCol.where({ platform, date: today }).orderBy('created_at', 'desc').limit(1).get();
      const t = todayRes.data && todayRes.data[0];
      if (t && t.success) {
        item.checkedIn = true;
        item.lastSign = { success: true, message: t.message, date: t.date, created_at: t.created_at };
      } else {
        if (t) item.lastSign = { success: t.success, message: t.message, date: t.date, created_at: t.created_at };
        // 2) 无今日成功记录且已配置启用 → 放入待实时查列表
        if (item.configured && item.enable !== false) needLive.push(platform);
      }
    } catch (e) {
      item.configured = false;
      item.error = e.message;
    }
    list.push(item);
  }

  // 3) 兜底:一次实时查(auto-sign mode:status,覆盖 needLive 全部),真签了回写今日记录供下次缓存
  if (needLive.length) {
    try {
      const res = await uniCloud.callFunction({ name: 'auto-sign', data: { mode: 'status' } });
      const st = (res.result && res.result.data) || {};
      for (const p of needLive) {
        const s = st[p];
        const item = list.find(x => x.platform === p);
        if (!item || !s) continue;
        if (s.todayCheckedIn) {
          item.checkedIn = true;
          item.lastSign = { success: true, message: s.message || '已签到', date: today, created_at: Date.now() };
          // upsert 今日记录:有则 update,无则 add
          try {
            const ex = await logCol.where({ platform: p, date: today }).limit(1).get();
            const msg = s.message || '已签到';
            if (ex.data && ex.data[0]) {
              await logCol.doc(ex.data[0]._id).update({ success: true, message: msg });
            } else {
              await logCol.add({ platform: p, success: true, message: msg, created_at: Date.now(), date: today });
            }
          } catch (e) {}
        } else {
          item.lastSign = item.lastSign || { success: false, message: s.message || '今日未签到', date: today };
        }
      }
    } catch (e) {}
  }

  return ok(list, 'ok');
}

// POST /checkin  body:{platform?}
async function doCheckin(body) {
  // 支持单平台 body.platform 或批量 body.platforms(仅签未签的,避免浪费)
  const plat = (body && body.platform) || null;
  const plats = (body && body.platforms) || null;
  const data = plats ? { platform: plats } : (plat ? { platform: plat } : {});
  const req = uniCloud.callFunction({ name: 'auto-sign', data });
  const res = await req;
  const r = res.result;
  if (!r) return fail(500, 'auto-sign 无响应');
  if (r.code === 0) {
    // 透传各平台真实结果,让前端能显示真实成功/失败原因
    const data = r.data || {};
    let okCount = 0, failCount = 0;
    const details = (Object.keys(data)||[]).map(p => {
      const it = data[p];
      if (it && it.success) okCount++; else failCount++;
      const name = { trae:'Trae', workbuddy:'WorkBuddy', qoder:'Qoder' }[p] || p;
      return `${name}:${it ? (it.alreadyCheckedIn ? '已签到' : (it.success ? '成功' : '失败')) : '无响应'}`;
    });
    const msg = details.length ? details.join('; ') : '签到完成';
    return ok(data, (okCount + failCount) ? `签到完成(${okCount}成功/${failCount}失败)` : '签到完成', );
  }
  return fail(500, (r.message || '签到失败') + ':' + JSON.stringify(r));
}

// POST /credential  body:{platform, accessToken, deviceId?, host?, userRegion?, uid?}
async function doCredential(db, body) {
  const platform = body && body.platform;
  if (!platform || PLATFORMS.indexOf(platform) < 0) return fail(400, 'platform 非法');
  const token = body.accessToken;
  if (!token || String(token).length < 20) return fail(400, 'accessToken 缺失或过短(疑似无效)');

  const alias = { trae: 'Trae', workbuddy: 'WorkBuddy', qoder: 'Qoder' }[platform];
  const enc = cc.encryptText(String(token).trim());

  // 有效期:优先用表单携带的 expires_at,否则从 token 解析
  let expMs = (typeof body.expires_at === 'number' ? body.expires_at : parseInt(body.expires_at, 10)) || null;
  if (!expMs) expMs = jwtExpiry(token);
  const cfgRow = { enable: true, enc, updated_at: Date.now() };
  if (expMs) cfgRow.expires_at = expMs;
  if (body.deviceId) cfgRow.deviceId = String(body.deviceId);
  if (body.host) cfgRow.host = String(body.host).replace(/`/g, '');
  if (body.userRegion) cfgRow.userRegion = String(body.userRegion);
  if (body.uid) cfgRow.uid = String(body.uid);

  await db.collection('auto_sign_config').doc(platform).set(cfgRow);
  return ok({ platform, masked: cc.maskToken(token), enc: true }, `${alias} 凭证已加密更新`);
}

// POST /import  body:{config:{trae:{...},workbuddy:{...},qoder:{...}}} 批量加密写入
// config 为 key=平台 的对象;仅写入含合法 accessToken 的平台,其余跳过
async function doImport(db, body) {
  const config = body && body.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return fail(400, 'config 缺失');
  const col = db.collection('auto_sign_config');
  const updated = [], skipped = [];
  for (const platform of PLATFORMS) {
    const c = config[platform];
    if (!c || typeof c !== 'object') continue;
    const token = c.accessToken;
    if (!token || String(token).length < 20) { skipped.push(platform); continue; }
    // 有效期:优先用 JSON 携带的 expires_at,否则从 token 解析
    let expMs = (typeof c.expires_at === 'number' ? c.expires_at : parseInt(c.expires_at, 10)) || null;
    if (!expMs) expMs = jwtExpiry(token);
    const row = { enable: true, enc: cc.encryptText(String(token).trim()), updated_at: Date.now() };
    if (expMs) row.expires_at = expMs;
    if (c.deviceId) row.deviceId = String(c.deviceId);
    if (c.host) row.host = String(c.host).replace(/`/g, '');
    if (c.userRegion) row.userRegion = String(c.userRegion);
    if (c.uid) row.uid = String(c.uid);
    if (c.userId) row.userId = String(c.userId);
    await col.doc(platform).set(row);
    updated.push(platform);
  }
  return ok({ updated, skipped },
    '批量更新 ' + updated.length + ' 项' + (skipped.length ? ',跳过无效:' + skipped.join(',') : ''));
}

// ---------- 主入口 ----------
exports.main = async function (event, context) {
  const { action, headers, body } = normalizeEvent(event);
  const db = uniCloud.database();
  try {
    // 公开动作:login
    if (action === 'login' || action === 'init') return await doLogin(body);

    // 其余动作需鉴权
    const token = bearerToken(headers);
    const authed = token ? await auth.verifyToken(token) : false;
    if (!authed) return fail(401, '未登录或会话已过期');

    switch (action) {
      case 'status':       return await doStatus(db);
      case 'checkin':      return await doCheckin(body);
      case 'credential':   return await doCredential(db, body);
      case 'import':       return await doImport(db, body);
      case 'logout':       await auth.logout(); return ok(null, '已退出');
      default:             return fail(404, `未知动作:${action || '(空)'}`);
    }
  } catch (err) {
    return fail(500, '服务器内部错误: ' + err.message);
  }
};