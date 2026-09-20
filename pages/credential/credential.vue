<template>
  <view class="page">
    <view class="card">
      <view class="title">一键粘贴 · JSON 批量导入</view>
      <view class="tip">直接执行 一键获取签到凭证.bat，把输出的内容整体复制到这里，即可一次更新三平台。</view>
      <textarea class="input area big" v-model="paste" :maxlength="-1" :auto-height="false" placeholder="粘贴 bat 输出的 JSON（支持多段，自动识别平台）" />
      <button class="btn" :loading="importing" @click="importJson">识别并批量更新</button>
    </view>

    <view class="card">
      <view class="title">{{ nameOf(platform) }} · 更新凭证</view>
      <view class="tip">凭证将加密存储，不会明文回显。Enter / 提交后写库。</view>

      <view class="field">
        <text class="label">平台</text>
        <picker :range="platformList" range-key="name" :value="idx" @change="onPick">
          <view class="input picker">{{ nameOf(platform) }} ▾</view>
        </picker>
      </view>

      <view class="field">
        <text class="label">accessToken *</text>
        <textarea class="input area" v-model="form.accessToken" :auto-height="true" placeholder="粘贴完整 accessToken" />
      </view>

      <view class="field">
        <text class="label">deviceId</text>
        <input class="input" v-model="form.deviceId" placeholder="Trae 需要(可选)" />
      </view>
      <view class="field">
        <text class="label">host</text>
        <input class="input" v-model="form.host" placeholder="Trae 自定义主机，留空默认" />
      </view>
      <view class="field">
        <text class="label">userRegion</text>
        <input class="input" v-model="form.userRegion" placeholder="Trae 需要(可选)" />
      </view>
      <view class="field">
        <text class="label">uid</text>
        <input class="input" v-model="form.uid" placeholder="WorkBuddy 需要(可选)" />
      </view>

      <button class="btn" :loading="loading" @click="save">加密并保存</button>
      <view class="back" @click="back">返回仪表盘</view>
    </view>
  </view>
</template>

<script>
import api from '@/common/api.js';
const ALL = [{ key: 'trae', name: 'Trae' }, { key: 'workbuddy', name: 'WorkBuddy' }, { key: 'qoder', name: 'Qoder' }];
const KEYS = ['trae', 'workbuddy', 'qoder'];
export default {
  data() {
    return {
      platform: 'trae', idx: 0, loading: false, importing: false, paste: '',
      platformList: ALL,
      form: { accessToken: '', deviceId: '', host: '', userRegion: '', uid: '' }
    };
  },
  onLoad(q) {
    if (q && q.platform) {
      const i = ALL.findIndex(x => x.key === q.platform);
      if (i >= 0) { this.idx = i; this.platform = q.platform; }
    }
  },
  methods: {
    nameOf(p) { const t = ALL.find(x => x.key === p); return t ? t.name : p; },
    onPick(e) { this.idx = Number(e.target.value); this.platform = ALL[this.idx].key; },
    save() {
      const t = (this.form.accessToken || '').trim();
      if (t.length < 20) { uni.showToast({ title: 'accessToken 过短，请检查', icon: 'none' }); return; }
      this.loading = true;
      api.updateCredential({ platform: this.platform, ...this.form, accessToken: t })
        .then(() => {
          uni.showToast({ title: '已加密保存', icon: 'success' });
          this.form.accessToken = '';
          setTimeout(() => this.back(), 500);
        })
        .catch(() => {})
        .finally(() => { this.loading = false; });
    },
    // 容错解析:从粘贴内容提取各平台配置,返回 {trae:{...},workbuddy:{...},qoder:{...}}
    extractConfig(text) {
      const out = {};
      const t = (text || '').trim();
      const tryParse = s => { try { return JSON.parse(s); } catch (e) { return null; } };
      const push = o => {
        if (!o || typeof o !== 'object') return;
        const id = (o._id || o.platform || '').toLowerCase();
        if (KEYS.indexOf(id) < 0) return;
        const c = Object.assign({}, o); delete c._id; delete c.platform; delete c.enable;
        if (c.accessToken && String(c.accessToken).length >= 20) out[id] = c;
      };
      const w = tryParse(t);
      if (w && typeof w === 'object' && !Array.isArray(w)) {
        if (!w._id && KEYS.some(k => w[k])) {
          KEYS.forEach(k => push(Object.assign({ platform: k }, w[k])));
        } else {
          push(w);
        }
        return out;
      }
      if (Array.isArray(w)) { w.forEach(push); return out; }
      let i = 0;
      while ((i = t.indexOf('{', i)) >= 0) {
        let depth = 0, j = i, inStr = false;
        for (; j < t.length; j++) {
          const ch = t[j];
          if (inStr) { if (ch === '"' && t[j - 1] !== '\\') inStr = false; }
          else { if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) break; } }
        }
        const seg = t.slice(i, j + 1);
        push(tryParse(seg));
        i = j + 1;
      }
      return out;
    },
    importJson() {
      if (!(this.paste || '').trim()) { uni.showToast({ title: '请先粘贴 JSON', icon: 'none' }); return; }
      const cfg = this.extractConfig(this.paste);
      const keys = Object.keys(cfg);
      if (!keys.length) { uni.showToast({ title: '未识别到有效的 accessToken，请检查', icon: 'none' }); return; }
      this.importing = true;
      api.importCredentials(cfg)
        .then(data => {
          uni.showToast({ title: '已更新: ' + (data.updated || []).join('/'), icon: 'success' });
          this.paste = '';
        })
        .catch(() => {})
        .finally(() => { this.importing = false; });
    },
    back() { uni.navigateBack({ delta: 1 }) || uni.reLaunch({ url: '/pages/dashboard/dashboard' }); }
  }
};
</script>

<style scoped>
.page { min-height: 100vh; background: #f4f6fb; padding: 40rpx 24rpx; box-sizing: border-box; }
.card { background: #fff; border-radius: 16rpx; padding: 32rpx; margin-bottom: 24rpx; }
.title { font-size: 36rpx; font-weight: 600; color: #1a2a6c; }
.tip { font-size: 22rpx; color: #999; margin: 10rpx 0 28rpx; line-height: 1.6; }
.field { margin-bottom: 26rpx; }
.label { display: block; font-size: 26rpx; color: #555; margin-bottom: 10rpx; }
.input { border: 1rpx solid #ddd; border-radius: 12rpx; padding: 18rpx 20rpx; font-size: 28rpx; width: 100%; box-sizing: border-box; }
.area { min-height: 120rpx; }
.area.big { height: 420rpx; max-height: 420rpx; overflow-y: auto; }
.picker { color: #222; }
.btn { background: #1a2a6c; color: #fff; border-radius: 12rpx; margin-top: 10rpx; }
.back { text-align: center; color: #999; font-size: 26rpx; margin-top: 26rpx; }
</style>