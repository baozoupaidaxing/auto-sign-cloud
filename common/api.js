// 跨端统一请求封装:小程序与 H5 都通过 uniCloud.callFunction 调用 auto-sign-api
// (同一 AppId 下 callFunction 即可,无需额外域名配置,省资源)
const TOKEN_KEY = 'as_token';

function call(action, body, needAuth = true) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (needAuth) {
      const token = uni.getStorageSync(TOKEN_KEY);
      if (token) headers['Authorization'] = 'Bearer ' + token;
    }
    uniCloud.callFunction({
      name: 'auto-sign-api',
      data: { action, headers, body: body || {} }
    }).then(res => {
      const r = res.result || {};
      if (r.code === 0) { resolve(r.data); }
      else if (r.code === 401) {
        // 会话失效 => 清 token 回登录
        uni.removeStorageSync(TOKEN_KEY);
        uni.showToast({ title: '请先登录', icon: 'none' });
        setTimeout(() => uni.navigateTo({ url: '/pages/login/login' }), 600);
        reject(r);
      } else {
        uni.showToast({ title: r.message || '操作失败', icon: 'none' });
        reject(r);
      }
    }).catch(err => { reject(err); });
  });
}

export default {
  saveToken(t) { uni.setStorageSync(TOKEN_KEY, t); },
  clearToken() { uni.removeStorageSync(TOKEN_KEY); },
  hasToken() { return !!uni.getStorageSync(TOKEN_KEY); },
  login(pwd) { return call('login', { password: pwd }, false); },
  status() { return call('status', {}); },
  checkin(platform) { return call('checkin', { platform }); },
  updateCredential(payload) { return call('credential', payload); }
};