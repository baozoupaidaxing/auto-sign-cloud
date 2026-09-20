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
 *
 * 安全:
 *   - 除 login 外均需 Authorization: Bearer <会话token>
 *   - 回传凭证一律脱敏(绝不回显明文)
 *   - 凭证 AES-256-GCM 加密后入库
 */
const cc = require('crypto-util');
const auth = require('auth-util');

const URL_BASE = 'http://api.uniCloud.aliyun.com/v3/index.html'; // 占位,实际由前端 SDK 调用
const PLATFORMS = ['trae', 'workbuddy', 'qoder'];

// ---------- 响应封装 ----------
function ok(data, message = 'ok') { return { code: 0, message, data }; }
function fail(code, message, data) { return { code, message, data }; }

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

// GET /status
async function doStatus(db) {
  const configCol = db.collection('auto_sign_config');
  const logCol = db.collection('sign_log');
  const list = [];
  for (const platform of PLATFORMS) {
    const item = { platform };
    try {
      const doc = await configCol.doc(platform).get();
      const cfg = doc.data && doc.data[0];
      if (!cfg) { item.configured = false; item.masked = '(未配置)'; }
      else {
        item.configured = true;
        item.enable = cfg.enable !== false;
        // 取明文 token 用于脱敏展示:加密则解密,否则兼容旧明文
        let raw = cfg.accessToken;
        if (cfg.enc) { const d = cc.decryptText(cfg.enc); if (d) raw = d; }
        item.masked = raw ? cc.maskToken(raw) : '(未配置)';
        item.meta = { deviceId: cfg.deviceId, host: cfg.host, uid: cfg.uid, userRegion: cfg.userRegion };
      }
      // 最近签到日志
      const logRes = await logCol
        .where({ platform })
        .orderBy('created_at', 'desc')
        .limit(1)
        .get();
      const last = logRes.data && logRes.data[0];
      item.lastSign = last
        ? { success: last.success, message: last.message, date: last.date, created_at: last.created_at }
        : null;
    } catch (e) {
      item.configured = false;
      item.error = e.message;
    }
    list.push(item);
  }
  return ok(list, 'ok');
}

// POST /checkin  body:{platform?}
async function doCheckin(body) {
  const plat = (body && body.platform) || null;
  const req = plat
    ? uniCloud.callFunction({ name: 'auto-sign', data: { platform: plat } })
    : uniCloud.callFunction({ name: 'auto-sign' });
  const res = await req;
  const r = res.result;
  if (r && r.code === 0) return ok(r.data, '签到完成');
  return ok(r || { message: 'auto-sign 无响应' }, '签到完成');
}

// POST /credential  body:{platform, accessToken, deviceId?, host?, userRegion?, uid?}
async function doCredential(db, body) {
  const platform = body && body.platform;
  if (!platform || PLATFORMS.indexOf(platform) < 0) return fail(400, 'platform 非法');
  const token = body.accessToken;
  if (!token || String(token).length < 20) return fail(400, 'accessToken 缺失或过短(疑似无效)');

  const alias = { trae: 'Trae', workbuddy: 'WorkBuddy', qoder: 'Qoder' }[platform];
  const enc = cc.encryptText(String(token).trim());

  const cfgRow = { enable: true, enc, updated_at: Date.now() };
  if (body.deviceId) cfgRow.deviceId = String(body.deviceId);
  if (body.host) cfgRow.host = String(body.host).replace(/`/g, '');
  if (body.userRegion) cfgRow.userRegion = String(body.userRegion);
  if (body.uid) cfgRow.uid = String(body.uid);

  await db.collection('auto_sign_config').doc(platform).set(cfgRow);
  return ok({ platform, masked: cc.maskToken(token), enc: true }, `${alias} 凭证已加密更新`);
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
      case 'logout':       await auth.logout(); return ok(null, '已退出');
      default:             return fail(404, `未知动作:${action || '(空)'}`);
    }
  } catch (err) {
    return fail(500, '服务器内部错误: ' + err.message);
  }
};