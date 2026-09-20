'use strict';
/**
 * 一键读取 Trae / WorkBuddy(CodeBuddy CN) 本地签到凭证
 * 零依赖、零下载:仅使用 Node 内置模块 + Windows 自带 PowerShell(DPAPI 解密)
 *
 * 输出:
 *   1. 控制台打印打码预览 + 有效性校验 + token 过期时间
 *   2. 完整 uniCloud auto_sign_config 配置写入「签到凭证.txt」
 *   3. 同样内容自动复制到剪贴板,直接去数据库粘贴即可
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

const APPDATA = process.env.APPDATA;
const TRAE_STORAGE = path.join(APPDATA, 'TRAE SOLO CN', 'User', 'globalStorage', 'storage.json');
const CB_STORAGE = path.join(APPDATA, 'CodeBuddy CN', 'User', 'globalStorage', 'storage.json');
const CB_VSCDB = path.join(APPDATA, 'CodeBuddy CN', 'User', 'globalStorage', 'state.vscdb');
const CB_LOCAL_STATE = path.join(APPDATA, 'CodeBuddy CN', 'Local State');
const OUT_FILE = path.join(__dirname, '签到凭证.txt');

// ---------- 通用工具 ----------
function copyFileUnlocked(src) {
  const tmp = path.join(os.tmpdir(), `cred_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`);
  fs.copyFileSync(src, tmp);
  const buf = fs.readFileSync(tmp);
  try { fs.unlinkSync(tmp); } catch {}
  return buf;
}

function mask(s) {
  if (!s) return '(空)';
  s = String(s);
  return s.length <= 20 ? s : `${s.slice(0, 10)}...${s.slice(-6)} (长度${s.length})`;
}

function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    if (!payload.exp) return null;
    return { exp: payload.exp * 1000, text: new Date(payload.exp * 1000).toLocaleString('zh-CN') };
  } catch { return null; }
}

// ============================================================
// Trae:storage.json envelope 解密(AES-128-CBC + SHA512)
// ============================================================
const TRAE_HEADER = Buffer.from([116, 99, 5, 16, 0, 0]);
const TRAE_LEFT = Buffer.from([82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const TRAE_RIGHT = Buffer.from([31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);
const sha512 = b => crypto.createHash('sha512').update(b).digest();

function traeDecryptEnvelope(b64) {
  const env = Buffer.from(b64, 'base64');
  if (env.length <= 38 || !env.subarray(0, 6).equals(TRAE_HEADER)) throw new Error('凭证信封格式无效');
  const randomKey = env.subarray(6, 38);
  const secret = Buffer.from(TRAE_LEFT.map((b, i) => b ^ TRAE_RIGHT[i]));
  const derived = sha512(Buffer.concat([sha512(randomKey), secret]));
  const decipher = crypto.createDecipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32));
  const plain = Buffer.concat([decipher.update(env.subarray(38)), decipher.final()]);
  const payload = plain.subarray(64);
  if (!crypto.timingSafeEqual(plain.subarray(0, 64), sha512(payload))) throw new Error('凭证完整性校验失败');
  return JSON.parse(payload.toString('utf8'));
}

function readTrae() {
  const storage = JSON.parse(fs.readFileSync(TRAE_STORAGE, 'utf8'));
  const auth = traeDecryptEnvelope(storage['iCubeAuthInfo://icube.cloudide']);
  // 调试:打印 envelope payload 的所有字段名,帮助发现遗漏的字段(如 host)
  console.log('[Trae envelope 字段列表]:', Object.keys(auth).join(', '));
  // host 可能叫 host / apiHost / baseUrl / endpoint,逐个尝试
  // 注意:envelope 解密出的 host 值可能被反引号包裹(如 `https://api.trae.cn`),必须去掉
  const rawHost = auth.host || auth.apiHost || auth.baseUrl || auth.endpoint || '';
  const host = rawHost.replace(/`/g, '').trim();

  // userRegion:签到需要的 X-User-Region 头
  const userRegion = auth.userRegion?.region || '';

  // deviceId:从 local_env.json 读取(和官方客户端一致)
  const localEnvPath = path.join(process.env.APPDATA, 'TRAE SOLO CN', 'ModularData', 'ckg_server', 'local_env.json');
  let deviceId = storage['telemetry.devDeviceId'];
  try {
    const localEnv = JSON.parse(fs.readFileSync(localEnvPath, 'utf8'));
    if (localEnv.device_id) deviceId = localEnv.device_id;
  } catch (e) {
    console.log('[Trae] local_env.json 读取失败,回退 telemetry.devDeviceId:', e.message);
  }

  return {
    accessToken: auth.token,
    deviceId,
    userId: String(auth.userId || ''),
    host,
    userRegion
  };
}

// ============================================================
// WorkBuddy:解析 state.vscdb(SQLite) + Chromium OSCrypt(v10/AES-GCM)
// ============================================================
const CB_SECRET_KEY = 'secret://{"extensionId":"tencent-cloud.coding-copilot","key":"planning-genie.new.accessTokencn"}';

// ============================================================
// Qoder CN:state.vscdb + OSCrypt(同 WorkBuddy,不同 key)
// ============================================================
const QODER_VSCDB = path.join(process.env.APPDATA, 'QoderCN', 'User', 'globalStorage', 'state.vscdb');
const QODER_LOCAL_STATE = path.join(process.env.APPDATA, 'QoderCN', 'Local State');
// Qoder 的 aicoding 扩展存了多个 secret,userInfo 里可能含 token
const QODER_SECRET_KEYS = [
  'secret://aicoding.auth.userInfo',
  'secret://aicoding.auth.userPlan',
];

// ---- 最小 SQLite 读取器(支持 leaf table 页 + overflow 页链) ----
function readVarint(buf, off) {
  let result = 0;
  for (let i = 0; i < 9; i++) {
    const b = buf[off + i];
    if (i === 8) { result = result * 256 + b; return [result, off + 9]; }
    result = (result << 7) | (b & 0x7f);
    if (!(b & 0x80)) return [result, off + i + 1];
  }
}

/**
 * 遍历 state.vscdb 所有 leaf table 页,返回 ItemTable 的 [key, valueBuffer] 列表
 */
function readSqliteItemTable(fileBuf) {
  const pageSize = fileBuf.readUInt16BE(16);
  const reserved = fileBuf[20];
  const pageCount = Math.floor(fileBuf.length / pageSize);
  const U = pageSize - reserved;
  const X = U - 35;
  const M = Math.floor(((U - 12) * 32) / 255);

  const rows = [];

  for (let pgno = 1; pgno <= pageCount; pgno++) {
    const base = (pgno - 1) * pageSize;
    const pageType = fileBuf[base + (pgno === 1 ? 100 : 0)];
    if (pageType !== 0x0d) continue; // 只处理 leaf table b-tree

    const headerStart = base + (pgno === 1 ? 100 : 0);
    const cellCount = fileBuf.readUInt16BE(headerStart + 3);
    const contentStartRel = fileBuf.readUInt16BE(headerStart + 5);
    const contentStart = contentStartRel === 0 ? base + U : base + contentStartRel;

    for (let c = 0; c < cellCount; c++) {
      const cellPtrRel = fileBuf.readUInt16BE(headerStart + 8 + c * 2);
      if (cellPtrRel === 0 || cellPtrRel >= U) continue; // 边界保护
      let off = base + cellPtrRel;

      try {
        let payloadLen;
        [payloadLen, off] = readVarint(fileBuf, off);
        let rowid;
        [rowid, off] = readVarint(fileBuf, off);
        if (!Number.isFinite(payloadLen) || payloadLen <= 0 || payloadLen > fileBuf.length) continue;

        // 计算本页保留字节数 K(标准 SQLite 溢出公式)
        let K;
        if (payloadLen <= X) K = payloadLen;
        else {
          K = M + ((payloadLen - M) % (U - 4));
          if (K > X) K = M;
        }
        if (off + K > base + U) continue;

        // 拼完整 payload(含 overflow 页链)
        let payload = fileBuf.subarray(off, off + K);
        if (payloadLen > K) {
          let nextPage = fileBuf.readUInt32BE(off + K);
          const parts = [payload];
          let remaining = payloadLen - K;
          let guard = 0;
          while (nextPage !== 0 && remaining > 0 && guard++ < 10000) {
            if (nextPage < 1 || nextPage > pageCount) throw new Error('overflow 页号越界');
            const oBase = (nextPage - 1) * pageSize;
            // 溢出页布局:前4字节=下一页号,其后才是数据(U-4 字节)
            const next = fileBuf.readUInt32BE(oBase);
            const take = Math.min(U - 4, remaining);
            parts.push(fileBuf.subarray(oBase + 4, oBase + 4 + take));
            remaining -= take;
            nextPage = remaining > 0 ? next : 0;
          }
          payload = Buffer.concat(parts);
        }
        if (payload.length !== payloadLen) continue;

        // 解析 record
        const [headerLen, hEnd] = readVarint(payload, 0);
        let p = hEnd;
        const serials = [];
        while (p < headerLen) {
          const [s, np] = readVarint(payload, p);
          serials.push(s); p = np;
        }
        let body = headerLen;
        const cols = [];
        let bad = false;
        for (const s of serials) {
          if (s === 0) { cols.push(null); continue; }
          let len = 0;
          if (s >= 13 && s % 2 === 1) len = (s - 13) / 2;
          else if (s >= 12 && s % 2 === 0) len = (s - 12) / 2;
          else if (s === 1) len = 1;
          else if (s === 2) len = 2;
          else if (s === 3) len = 3;
          else if (s === 4) len = 4;
          else if (s === 5) len = 6;
          else if (s === 6) len = 8;
          else if (s >= 7 && s <= 9) { cols.push(null); continue; }
          else { bad = true; break; }
          if (body + len > payload.length) { bad = true; break; }
          cols.push(payload.subarray(body, body + len));
          body += len;
        }
        if (!bad && cols.length >= 2 && cols[0]) {
          rows.push({ key: cols[0].toString('utf8'), value: cols[1] });
        }
      } catch { /* 跳过坏 cell */ }
    }
  }
  return rows;
}

// ---- DPAPI:调系统自带 PowerShell + .NET,无需安装任何东西 ----
function dpapiDecrypt(blobBuf) {
  const bin = path.join(os.tmpdir(), `dpapi_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(bin, blobBuf);
  try {
    const ps = `Add-Type -AssemblyName System.Security;` +
      `$b=[IO.File]::ReadAllBytes('${bin}');` +
      `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`;
    const out = execSync(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, {
      timeout: 20000, encoding: 'utf8'
    }).trim();
    return Buffer.from(out, 'base64');
  } finally {
    try { fs.unlinkSync(bin); } catch {}
  }
}

/**
 * Chromium OSCrypt:密文 = "v10" + 12字节nonce + AES-256-GCM(ciphertext+16字节tag)
 * 密钥在 Local State:os_crypt.encrypted_key = base64("DPAPI" + DPAPI(AES key))
 */
function chromiumDecrypt(encryptedBuf, aesKey) {
  if (encryptedBuf.subarray(0, 3).toString('latin1') !== 'v10') {
    throw new Error('密文不是 v10 格式');
  }
  const nonce = encryptedBuf.subarray(3, 15);
  const tag = encryptedBuf.subarray(encryptedBuf.length - 16);
  const data = encryptedBuf.subarray(15, encryptedBuf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function pickToken(plain) {
  const t = String(plain).trim();
  try {
    const j = JSON.parse(t);
    return j.access_token || j.accessToken || j.token || j.Token || t;
  } catch { return t; }
}

function readWorkBuddy() {
  // 1) 从 state.vscdb 找到加密 value(扩展以 {"type":"Buffer","data":[...]} 文本存放)
  const dbBuf = copyFileUnlocked(CB_VSCDB);
  const rows = readSqliteItemTable(dbBuf);
  const hit = rows.find(r => r.key === CB_SECRET_KEY);
  if (!hit) throw new Error('state.vscdb 中未找到 accessToken(确认 CodeBuddy CN 已登录)');

  const wrapped = JSON.parse(hit.value.toString('utf8'));
  const encrypted = Buffer.from(wrapped.data);

  // 2) 从 Local State 解出 OSCrypt 主密钥
  const localState = JSON.parse(fs.readFileSync(CB_LOCAL_STATE, 'utf8'));
  const encKeyRaw = Buffer.from(localState.os_crypt.encrypted_key, 'base64');
  if (encKeyRaw.subarray(0, 5).toString('latin1') !== 'DPAPI') {
    throw new Error('Local State 密钥格式异常');
  }
  const aesKey = dpapiDecrypt(encKeyRaw.subarray(5));

  // 3) AES-GCM 解密,明文为账号 JSON:
  //    { auth: { accessToken: <JWT>, tokenType: 'Bearer' }, account: { uid }, ... }
  //    注意:顶层 $.accessToken 是 UUID 开头的复合串,不是 Bearer 凭证,不能用
  const plain = chromiumDecrypt(encrypted, aesKey);
  let accessToken = '';
  let authUid = '';
  try {
    const j = JSON.parse(plain);
    accessToken = j?.auth?.accessToken || j?.token || '';
    authUid = j?.account?.uid || j?.account?.id || '';
  } catch { /* 旧版本可能直接存裸 token */ }
  if (!accessToken) accessToken = pickToken(plain);

  // 4) uid:优先账号 JSON 的 account.uid,回退 storage.json 的 genie.userId
  let uid = authUid;
  if (!uid) {
    try {
      uid = JSON.parse(fs.readFileSync(CB_STORAGE, 'utf8'))['genie.userId'] || '';
    } catch {}
  }
  return { accessToken, uid };
}

function readQoder() {
  // 复用 WorkBuddy 的 SQLite 读取器 + OSCrypt 解密逻辑
  const dbBuf = copyFileUnlocked(QODER_VSCDB);
  const rows = readSqliteItemTable(dbBuf);

  // 解出 OSCrypt 主密钥
  const localState = JSON.parse(fs.readFileSync(QODER_LOCAL_STATE, 'utf8'));
  const encKeyRaw = Buffer.from(localState.os_crypt.encrypted_key, 'base64');
  if (encKeyRaw.subarray(0, 5).toString('latin1') !== 'DPAPI') {
    throw new Error('Qoder Local State 密钥格式异常');
  }
  const aesKey = dpapiDecrypt(encKeyRaw.subarray(5));

  // 遍历所有 secret key,解密并打印字段名
  let accessToken = '';
  let rawUserInfo = '';
  for (const secretKey of QODER_SECRET_KEYS) {
    const hit = rows.find(r => r.key === secretKey);
    if (!hit) {
      console.log(`[Qoder] ${secretKey.includes('userInfo') ? 'userInfo' : 'userPlan'}: 未找到此 key`);
      continue;
    }
    try {
      const wrapped = JSON.parse(hit.value.toString('utf8'));
      const encrypted = Buffer.from(wrapped.data);
      const plain = chromiumDecrypt(encrypted, aesKey);
      console.log(`[Qoder] ${secretKey.includes('userInfo') ? 'userInfo' : 'userPlan'} 完整内容:`, plain);
      rawUserInfo = plain;
      // 尝试从 JSON 里提取 token
      try {
        const j = JSON.parse(plain);
        console.log(`[Qoder] ${secretKey.includes('userInfo') ? 'userInfo' : 'userPlan'} 字段名:`, Object.keys(j).join(', '));
        // Qoder 的 token 在 userInfo.token,格式是 dt-xxx(短 token,不用 >50 过滤)
        // 直接取 token / accessToken / access_token / jwt / bearer 字段
        const direct = j.token || j.accessToken || j.access_token || j.access_token || j.jwt || j.bearer
          || (j.auth && (j.auth.accessToken || j.auth.token || j.auth.access_token)) || '';
        if (typeof direct === 'string' && direct) accessToken = direct;
        if (!accessToken) {
          // 兜底:深度搜索(不限制长度)
          function deepFindToken(obj, depth = 0) {
            if (!obj || typeof obj !== 'object' || depth > 5) return '';
            for (const [k, v] of Object.entries(obj)) {
              if (typeof v === 'string' && v && /token|auth|jwt|bearer/i.test(k)) return v;
              if (typeof v === 'object') {
                const found = deepFindToken(v, depth + 1);
                if (found) return found;
              }
            }
            return '';
          }
          const deepToken = deepFindToken(j);
          if (deepToken) accessToken = deepToken;
        }
      } catch {}
    } catch (e) {
      console.log(`[Qoder] 解密 ${secretKey} 失败:`, e.message);
    }
  }

  // 也搜索所有 secret key 里有没有 token 相关的
  console.log('[Qoder] 所有 secret key 列表:');
  for (const r of rows) {
    if (r.key.startsWith('secret://')) {
      console.log('  ', r.key.substring(0, 100));
    }
  }

  if (!accessToken) throw new Error('Qoder state.vscdb 中未找到 accessToken(查看上面的完整内容输出)');
  return { accessToken, rawUserInfo };
}

// ============================================================
// 凭证有效性校验(不影响结果输出)
// ============================================================
function postJson(url, headers, body, timeout = 10000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const payload = Buffer.from(JSON.stringify(body || {}));
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': payload.length }, headers)
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ http: res.statusCode, json: JSON.parse(raw), raw }); }
        catch { resolve({ http: res.statusCode, raw }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.write(payload);
    req.end();
  });
}

function getJson(url, headers, timeout = 10000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: headers
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ http: res.statusCode, json: JSON.parse(raw), raw }); }
        catch { resolve({ http: res.statusCode, raw }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function verifyTrae(c) {
  // 关键:host 用凭证里读到的,不再硬编码 https://api.trae.cn
  const host = c.host || 'https://api.trae.cn';
  const r = await postJson(`${host}/trae/api/v2/ug/checkin_credits/status`, {
    'Authorization': `Cloud-IDE-JWT ${c.accessToken}`,
    'x-device-id': c.deviceId
  }, {});
  if (r.error) return `校验失败(网络:${r.error})`;
  if (r.json?.code === 0) return `有效 ✓(host=${host}, 今日${r.json.checked_in ? '已签到' : '未签到'}, 当前积分${r.json.credits ?? '-'})`;
  return `无效/过期 ✗(host=${host}, HTTP ${r.http}:${r.raw.slice(0, 120)})`;
}

async function verifyWorkBuddy(c) {
  const r = await postJson('https://www.codebuddy.cn/v2/billing/meter/checkin-activity-status', {
    'Authorization': `Bearer ${c.accessToken}`,
    'X-User-Id': String(c.uid)
  }, {});
  if (r.error) return `校验失败(网络:${r.error})`;
  if (r.json?.code === 0) return `有效 ✓(今日${r.json.data?.today_checked_in ? '已签到' : '未签到'}, 连签${r.json.data?.streak_days ?? '-'}天)`;
  return `无效/过期 ✗(HTTP ${r.http}:${(r.json?.msg || r.raw || '').slice(0, 120)})`;
}

async function verifyQoder(c) {
  // Qoder Campaign API:GET /sash/api/v1/me/campaigns
  // 请求头:Bearer token + Cosy-ClientType: 10
  const r = await getJson('https://openapi.qoder.com.cn/sash/api/v1/me/campaigns', {
    'Authorization': `Bearer ${c.accessToken}`,
    'Accept': 'application/json',
    'Cosy-ClientType': '10'
  });
  if (r.error) return `校验失败(网络:${r.error})`;
  if (r.http === 200) return `有效 ✓\n  Campaigns 完整: ${JSON.stringify(r.json)}\n  领取入口 campaignUrl: ${r.json?.campaignUrl || '无'}`;
  return `无效/过期 ✗(HTTP ${r.http}:${(r.raw || '').slice(0, 120)})`;
}

// ============================================================
// 主流程
// ============================================================
if (require.main === module) {
(async () => {
  const lines = [];
  const out = (s) => { console.log(s); lines.push(s); };

  out('================ 签到凭证读取(uniCloud auto_sign_config)================');
  out('生成时间:' + new Date().toLocaleString('zh-CN'));
  out('');

  let trae = null, wb = null, qoder = null;
  try {
    trae = readTrae();
    const exp = jwtExp(trae.accessToken);
    out('【Trae】');
    out('  accessToken: ' + mask(trae.accessToken));
    out('  deviceId   : ' + trae.deviceId);
    if (trae.userId) out('  userId     : ' + trae.userId);
    out('  host       : ' + (trae.host || '(未读到,沿用 https://api.trae.cn)'));
    if (trae.userRegion) out('  userRegion : ' + trae.userRegion);
    if (exp) out('  token有效期: ' + exp.text + (exp.exp < Date.now() ? ' [已过期,请重新打开 Trae 后再运行本脚本]' : ''));
    out('  接口校验   : ' + await verifyTrae(trae));
  } catch (e) {
    out('【Trae】读取失败:' + e.message);
  }

  out('');
  try {
    wb = readWorkBuddy();
    out('【WorkBuddy / CodeBuddy】');
    out('  accessToken: ' + mask(wb.accessToken));
    out('  uid        : ' + (wb.uid || '(未读到,沿用数据库现有值即可)'));
    out('  接口校验   : ' + await verifyWorkBuddy(wb));
  } catch (e) {
    out('【WorkBuddy / CodeBuddy】读取失败:' + e.message);
  }

  out('');
  try {
    qoder = readQoder();
    out('【Qoder CN】');
    out('  accessToken: ' + mask(qoder.accessToken));
    out('  接口校验   : ' + await verifyQoder(qoder));
  } catch (e) {
    out('【Qoder CN】读取失败:' + e.message);
  }

  out('');
  out('================ 复制下面配置到 uniCloud 数据库 ================');
  out('');
  if (trae) {
    out('-- 集合 auto_sign_config,_id = trae 的记录(更新 accessToken / deviceId / host 字段)--');
    const traeDoc = {
      _id: 'trae',
      enable: true,
      accessToken: trae.accessToken,
      deviceId: trae.deviceId
    };
    const traeExp = jwtExp(trae.accessToken); if (traeExp && traeExp.exp) traeDoc.expires_at = traeExp.exp;
    if (trae.userId) traeDoc.userId = trae.userId;
    if (trae.host) traeDoc.host = trae.host;
    if (trae.userRegion) traeDoc.userRegion = trae.userRegion;
    out(JSON.stringify(traeDoc, null, 2));
    out('');
  }
  if (wb) {
    out('-- 集合 auto_sign_config,_id = workbuddy 的记录(更新 accessToken;uid 通常不用变)--');
    const doc = { _id: 'workbuddy', enable: true, accessToken: wb.accessToken };
    const wbExp = jwtExp(wb.accessToken); if (wbExp && wbExp.exp) doc.expires_at = wbExp.exp;
    if (wb.uid) doc.uid = wb.uid;
    out(JSON.stringify(doc, null, 2));
  }
  if (qoder) {
    out('');
    out('-- 集合 auto_sign_config,_id = qoder 的记录 --');
    out(JSON.stringify({ _id: 'qoder', enable: true, accessToken: qoder.accessToken /* 非JWT,无有效期 */ }, null, 2));
  }

  fs.writeFileSync(OUT_FILE, lines.join('\n'), 'utf8');

  try {
    execSync('clip', { input: lines.join('\n') });
    console.log('\n完整配置已:① 写入 ' + OUT_FILE + '  ② 复制到剪贴板(直接去数据库粘贴)');
  } catch {
    console.log('\n完整配置已写入:' + OUT_FILE + '(自动复制剪贴板失败,请手动打开文件复制)');
  }
})();
}

// 导出复用函数(供 qoder-claim.js 等测试脚本 require)
module.exports = { readQoder, getJson, postJson };
