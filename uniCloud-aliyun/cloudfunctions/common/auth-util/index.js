'use strict';
/**
 * 共享模块 auth-util - 管理口令 + 会话 token
 *
 * 依赖 crypto-util。
 * 集合: auto_sign_admin
 *   - _id: 'settings'  => { adminTokenHash }
 *   - _id: 'sessions'  => { token, expiry, created_at }
 */
const cc = require('../crypto-util');

const DB = () => uniCloud.database().collection('auto_sign_admin');

async function initPassword(password) {
  if (!password || password.length < 6) throw new Error('口令至少 6 位');
  await DB().doc('settings').set({ adminTokenHash: cc.hashPassword(password) });
  return true;
}

async function login(password) {
  const doc = await DB().doc('settings').get();
  const cfg = doc.data && doc.data[0];
  if (!cfg || !cfg.adminTokenHash) throw new Error('尚未初始化管理口令');
  if (cc.hashPassword(password) !== cfg.adminTokenHash) throw new Error('口令错误');
  const token = cc.genToken();
  const expiry = Date.now() + cc.SESSION_TTL;
  await DB().doc('sessions').set({ token, expiry, created_at: Date.now() });
  return { token, expiry };
}

async function verifyToken(token) {
  if (!token) return false;
  const doc = await DB().doc('sessions').get();
  const s = doc.data && doc.data[0];
  if (!s || !s.token || s.token !== token) return false;
  if (Date.now() > s.expiry) {
    await DB().doc('sessions').remove().catch(() => {});
    return false;
  }
  return true;
}

async function logout() {
  await DB().doc('sessions').remove().catch(() => {});
  return true;
}

function extractToken(headers) {
  const auth = headers['authorization'] || headers['Authorization'] || '';
  if (!auth) return '';
  const m = /^bearer\s+(.+)$/i.exec(String(auth).trim());
  return m ? m[1].trim() : '';
}

module.exports = { initPassword, login, verifyToken, logout, extractToken };