'use strict';
/**
 * 共享模块 crypto-util - AES-256-GCM 凭证加解密 + 口令哈希 + 会话 token
 *
 * uniCloud 公共模块,其他云函数通过 require('crypto-util') 引入。
 * 零第三方依赖。
 * 加密主密钥通过环境变量 AS_MASTER_KEY 覆盖(部署时配置),默认值仅占位。
 */
const crypto = require('crypto');

// 部署前务必设置 AS_MASTER_KEY! 生成示例:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
const MASTER_KEY_HEX = process.env.AS_MASTER_KEY
  || '0000000000000000000000000000000000000000000000000000000000000000';
const MASTER_KEY = Buffer.from(MASTER_KEY_HEX, 'hex');
if (MASTER_KEY.length !== 32) {
  throw new Error('AS_MASTER_KEY 必须为 32 字节(64 位十六进制)');
}

const SESSION_TTL = Number(process.env.AS_SESSION_TTL || 4 * 60 * 60 * 1000);

// 加密 -> { alg, iv(base64), data(base64: 密文||tag) }
function encryptText(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { alg: 'aes-256-gcm', iv: iv.toString('base64'), data: Buffer.concat([enc, tag]).toString('base64') };
}

// 解密 encryptText 结果;非法输入返回 null
function decryptText(enc) {
  try {
    if (!enc || typeof enc !== 'object') {
      if (typeof enc === 'string') {
        // 兼容裸 base64 密文(v10 等旧格式)
        const buf = Buffer.from(enc, 'base64');
        const tag = buf.subarray(buf.length - 16);
        const data = buf.subarray(0, buf.length - 16);
        const d = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.alloc(12, 0));
        d.setAuthTag(tag);
        return Buffer.concat([d.update(data), d.final()]).toString('utf8');
      }
      return null;
    }
    const iv = Buffer.from(enc.iv, 'base64');
    const buf = Buffer.from(enc.data, 'base64');
    const tag = buf.subarray(buf.length - 16);
    const data = buf.subarray(0, buf.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// 脱敏:abcd...wxyz
function maskToken(token) {
  if (!token) return '(空)';
  const s = String(token);
  if (s.length <= 8) return '***';
  return s.slice(0, 4) + '***' + s.slice(-4);
}

// 口令哈希(sha256 + 固定盐,不可逆)
function hashPassword(password) {
  return crypto.createHash('sha256').update('as_admin_salt::' + password).digest('hex');
}

function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { encryptText, decryptText, maskToken, hashPassword, genToken, SESSION_TTL };