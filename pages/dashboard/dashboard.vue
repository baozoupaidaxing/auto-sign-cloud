<template>
  <view class="page">
    <view class="header">
      <view class="h-title">签到状态</view>
      <view class="h-actions">
<view class="h-btn" @click="onTapRefresh">刷新</view>
        <view class="h-btn" @click="checkinAll" :class="{ disabled: allSigned }">全部签到</view>
        <view class="h-btn warn" @click="logout">退出</view>
      </view>
    </view>

    <view v-if="loading" class="loading">加载中...</view>

    <view v-else class="list">
      <view class="card" v-for="item in list" :key="item.platform"
            :class="{ off: !item.configured || item.enable === false }">
        <view class="row">
          <text class="pname">{{ nameOf(item.platform) }}</text>
          <text class="status" :class="statusClass(item)">{{ statusText(item) }}</text>
        </view>
        <view class="row sub">
          <text class="cred">{{ item.masked || '(未配置凭证)' }}</text>
          <text class="exp" v-if="item.configured">{{ expText(item) }}</text>
          <text class="signbtn" @click="checkinOne(item.platform)" :class="{ disabled: item.checkedIn }">{{ item.checkedIn ? '已签到' : '手动签到' }}</text>
        </view>
        <view v-if="item.lastSign" class="last line2">
          最近：{{ item.lastSign.date }} · {{ item.lastSign.message }}
        </view>
        <view v-else class="last line2">尚无签到记录</view>
        <view class="update" @click="goCredential(item.platform)">更新凭证 ›</view>
      </view>
    </view>
  </view>
</template>

<script>
import api from '@/common/api.js';
const NAMED = { trae: 'Trae', workbuddy: 'WorkBuddy', qoder: 'Qoder' };
export default {
  data() { return { list: [], loading: true, checking: false, lastRefresh: 0 }; },
  onLoad() { this.refresh(); },
  computed: {
    // 全部已签(或无可签平台) => 置灰
    allSigned() { return !this.list.some(x => x.configured && x.enable !== false && !x.checkedIn); }
  },
  methods: {
    nameOf(p) { return NAMED[p] || p; },
    expText(item) {
      if (item.configured === false) return '(未配置凭证)';
      if (!item.expires_at) return '(有效期未知)';
      const exp = new Date(item.expires_at);
      const days = Math.max(0, Math.ceil((item.expires_at - Date.now()) / 86400000));
      if (days === 0) return '(今日过期)';
      if (days > 3650) return '(有效期未知)'; // 仅当极其离谱才视为未解析
      return '(' + exp.toLocaleDateString('zh-CN') + ' 剩 ' + days + ' 天)';
    },
    statusText(item) {
      if (!item.configured) return '未配置';
      if (item.enable === false) return '已禁用';
      if (item.checkedIn) return '今日已签';
      return '待签到';
    },
    statusClass(item) {
      if (!item.configured || item.enable === false) return 'off';
      if (item.checkedIn) return 'done';
      return 'todo';
    },
    refresh() {
      this.loading = true;
      api.status().then(data => { this.list = data; }).catch(() => { this.list = this.list || []; })
        .finally(() => { this.loading = false; });
    },
    // 刷新按钮:1 分钟内只允许点一次(按钮专用,action 后的 refresh 不走此限制)
    onTapRefresh() {
      const now = Date.now();
      if (now - this.lastRefresh < 60000) {
        uni.showToast({ title: '1 分钟后才能再次刷新', icon: 'none' });
        return;
      }
      this.lastRefresh = now;
      this.refresh();
    },
    checkinOne(platform) {
      if (this.checking) return;
      const it = this.list.find(x => x.platform === platform);
      if (it && it.checkedIn) return; // 已签则不再重复签到
      this.checking = true;
      uni.showLoading({ title: '签到中...' });
      api.checkin(platform).then(() => { uni.hideLoading(); uni.showToast({ title: '完成', icon: 'success' }); this.refresh(); })
        .catch(() => { uni.hideLoading(); }).finally(() => { this.checking = false; });
    },
    checkinAll() {
      if (this.checking || this.allSigned) return;
      const todo = this.list.filter(x => x.configured && x.enable !== false && !x.checkedIn).map(x => x.platform);
      if (!todo.length) return;
      this.checking = true;
      uni.showLoading({ title: '签到未签平台...' });
      api.checkin(todo).then(() => { uni.hideLoading(); uni.showToast({ title: '完成', icon: 'success' }); this.refresh(); })
        .catch(() => { uni.hideLoading(); }).finally(() => { this.checking = false; });
    },
    goCredential(platform) { uni.navigateTo({ url: '/pages/credential/credential?platform=' + platform }); },
    logout() { api.clearToken(); uni.reLaunch({ url: '/pages/login/login' }); }
  }
};
</script>

<style scoped>
.page { min-height: 100vh; background: #f4f6fb; padding-bottom: 40rpx; }
.header { display: flex; align-items: center; justify-content: space-between; padding: 40rpx 32rpx 20rpx; }
.h-title { font-size: 40rpx; font-weight: 600; color: #1a2a6c; }
.h-actions { display: flex; }
.h-btn { font-size: 26rpx; color: #1a2a6c; background: #fff; padding: 10rpx 20rpx; border-radius: 30rpx; margin-left: 14rpx; border: 1rpx solid #ccd3ea; }
.h-btn.warn { color: #c0392b; border-color: #e5b3ad; }
.h-btn.disabled { opacity: .45; pointer-events: none; }
.loading { text-align: center; color: #999; padding-top: 120rpx; }
.list { padding: 0 24rpx; }
.card { background: #fff; border-radius: 16rpx; padding: 28rpx; margin-bottom: 24rpx; }
.card.off { opacity: .55; }
.row { display: flex; align-items: center; justify-content: space-between; }
.pname { font-size: 34rpx; font-weight: 600; color: #222; }
.status { font-size: 24rpx; padding: 6rpx 18rpx; border-radius: 24rpx; }
.status.done { background: #e1f6e6; color: #1f8f44; }
.status.todo { background: #fff4e0; color: #d9820b; }
.status.off { background: #f0f0f0; color: #888; }
.row.sub { margin-top: 16rpx; }
.cred { font-size: 26rpx; color: #666; }
.exp { font-size: 22rpx; color: #999; margin-left: 12rpx; flex-shrink: 0; }
.signbtn { font-size: 26rpx; color: #1a2a6c; text-decoration: underline; }
.signbtn.disabled { color: #aaa; text-decoration: none; pointer-events: none; }
.last { font-size: 24rpx; color: #999; margin-top: 14rpx; }
.line2 { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.update { margin-top: 14rpx; font-size: 26rpx; color: #1a2a6c; text-align: right; }
</style>
