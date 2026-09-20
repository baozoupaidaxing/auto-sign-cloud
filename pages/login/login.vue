<template>
  <view class="login-wrap">
    <view class="card">
      <view class="title">签到管理面板</view>
      <view class="sub">Trae · WorkBuddy · Qoder</view>
      <input class="input" type="password" v-model="password" placeholder="请输入管理口令" @confirm="doLogin" />
      <button class="btn" :loading="loading" @click="doLogin">登 录</button>
      <view class="tip">首次使用：设置此处口令并登录，将作为管理员口令（请牢记）</view>
    </view>
  </view>
</template>

<script>
import api from '@/common/api.js';
export default {
  data() { return { password: '', loading: false }; },
  methods: {
    doLogin() {
      if (!this.password || this.password.length < 6) {
        uni.showToast({ title: '口令至少 6 位', icon: 'none' });
        return;
      }
      this.loading = true;
      api.login(this.password).then(data => {
        api.saveToken(data.token);
        uni.showToast({ title: '登录成功', icon: 'success' });
        setTimeout(() => uni.reLaunch({ url: '/pages/dashboard/dashboard' }), 400);
      }).catch(err => {
        uni.showToast({ title: (err && err.message) || '登录失败', icon: 'none' });
      }).finally(() => { this.loading = false; });
    }
  }
};
</script>

<style scoped>
.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(160deg,#1a2a6c,#00416a); padding: 40rpx; box-sizing: border-box; }
.card { width: 100%; background: #fff; border-radius: 20rpx; padding: 60rpx 48rpx; box-sizing: border-box; }
.title { font-size: 42rpx; font-weight: 600; color: #1a2a6c; }
.sub { font-size: 26rpx; color: #888; margin: 10rpx 0 40rpx; }
.input { border: 1rpx solid #ddd; border-radius: 12rpx; padding: 22rpx 24rpx; margin-bottom: 30rpx; font-size: 30rpx; }
.btn { background: #1a2a6c; color: #fff; border-radius: 12rpx; }
.tip { margin-top: 24rpx; font-size: 22rpx; color: #999; line-height: 1.6; }
</style>