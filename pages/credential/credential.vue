<template>
  <view class="page">
    <view class="card">
      <view class="title">{{ nameOf(platform) }} · 更新凭证</view>
      <view class="tip">凭证将加密存储，不会明文回显。Enter / 提交后写库。</view>

      <view class="field">
        <text class="label">平台</text>
        <picker :range="platformList" :value="idx" @change="onPick">
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
export default {
  data() {
    return {
      platform: 'trae', idx: 0, loading: false,
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
    back() { uni.navigateBack({ delta: 1 }) || uni.reLaunch({ url: '/pages/dashboard/dashboard' }); }
  }
};
</script>

<style scoped>
.page { min-height: 100vh; background: #f4f6fb; padding: 40rpx 24rpx; box-sizing: border-box; }
.card { background: #fff; border-radius: 16rpx; padding: 32rpx; }
.title { font-size: 36rpx; font-weight: 600; color: #1a2a6c; }
.tip { font-size: 22rpx; color: #999; margin: 10rpx 0 28rpx; line-height: 1.6; }
.field { margin-bottom: 26rpx; }
.label { display: block; font-size: 26rpx; color: #555; margin-bottom: 10rpx; }
.input { border: 1rpx solid #ddd; border-radius: 12rpx; padding: 18rpx 20rpx; font-size: 28rpx; width: 100%; box-sizing: border-box; }
.area { min-height: 120rpx; }
.picker { color: #222; }
.btn { background: #1a2a6c; color: #fff; border-radius: 12rpx; margin-top: 10rpx; }
.back { text-align: center; color: #999; font-size: 26rpx; margin-top: 26rpx; }
</style>