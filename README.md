
---

## 🆕 v2：可视化签到管理面板（uniapp）

在 v1 定时签到基础上，新增一个 **uniapp 管理面板**（可同时部署 H5 网页 + 微信小程序），用于：
- 查看三平台当前签到状态 / 是否已签 / 最近结果
- 凭证失效时**直接在网页上输入新凭证**（加密存储，不回显明文）
- **手动触发**签到云函数

### 分支说明

| 分支 | 说明 |
|------|------|
| `master`（v1.x） | 纯定时签到，稳定，持续可维护（tag `v1.0.0` 为可回滚快照基线，**非冻结**） |
| `v2` | 在 master 基础上＋面板，开发完成后可合并回 master 打 `v2.0.0` |

### 新增/改动文件

```
cloudfunctions/
├── common/
│   ├── crypto-util/          # 【新增】公共模块：AES-256-GCM 加解密 / 口令哈希 / 会话token
│   │   ├── index.js
│   │   └── package.json
│   └── auth-util/            # 【新增】公共模块：管理口令 + 会话校验
│       ├── index.js
│       └── package.json
├── auto-sign/                # 【改造】导入 crypto-util，cfg.enc 存在则解密凭证（兼容旧明文）
│   └── index.js
└── auto-sign-api/            # 【新增】URL化/云函数 API：login/status/checkin/credential
    └── index.js
uni-app/                      # 【新增】uniapp 面板（H5 + 微信小程序）
├── pages/login/              #   口令登录页（首次自动初始化口令）
├── pages/dashboard/          #   三平台状态 + 手动签到 + 更新入口
├── pages/credential/         #   更新凭证页（加密提交）
└── common/api.js             #   跨端统一 callFunction 封装
```

### 安全设计

- **前端口令保护**：登录后才可访问，口令以 sha256 哈希存库（`auto_sign_admin`，不存明文）
- **会话 token**：登录签发，默认 4 小时有效，失效自动回登录页
- **凭证加密入库**：前端提交明文 token → HTTPS → 云函数内存 AES-256-GCM 加密后写入 `auto_sign_config.enc`，库与前端都只存/只显脱敏串 `abc***xyz`，**不再明文入库**
- **密钥独立**：加密主密钥取环境变量 `AS_MASTER_KEY`，不进数据库、不入 GitHub
- **手动签到不对外开放**：`auto-sign` 定时云函数仅定时触发 + 被 `auto-sign-api` 内部调用，外部不可直接伪造

### 数据库集合

- `auto_sign_config`：新增可选字段 `enc`（加密凭证），原 `accessToken` 明文**可原地保留迁移**（旧明文仍是旧样，未加密的访问仍兼容；新写入走 `enc`）
- `auto_sign_admin`：`_id='settings'`（adminTokenHash）＋ `_id='sessions'`（token/expiry）

### v2 部署步骤（HBuilderX + uniCloud）

1. **建公共模块**：将 `cloudfunctions/common/crypto-util`、`auth-util` 上传为 uniCloud 公共模块（右键“上传公共模块”）
2. **部署云函数**：`auto-sign`、`auto-sign-api` 分别创建并上传（`auto-sign-api` 依赖公共模块，直接 `require('crypto-util')` / `require('auth-util')`）
3. **配置密钥**：在 `auto-sign-api` 云函数环境变量设置 `AS_MASTER_KEY=64位hex`
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
4. **首次登录初始化**：打开 H5 网页 → 输入口令登录（首次自动把该口令设为管理员口令，请牢记）
5. **导入/更新凭证**：在网页“更新凭证”页粘贴各平台 token（可配合 v1 的 `一键获取签到凭证.bat` 读取，再手动填入）
6. **手动签到/看状态**：仪表盘一键查看与触发
7. **uniCloud 前端网页托管 / 小程序**：用 HBuilderX 发布“网页托管”重建 H5；小程序用 `uniCloud.callFunction` 无需额外域名配置

> ⚠️ 资源配额：面板状态查询默认读数据库缓存日志，不做高频轮询；实时接口仅在你点“刷新 / 手动签到”时触发，注意关注免费版每日云函数调用与前端访问量限额。

### 与 v1 凭证脚本联动

v1 的 `get-credentials.js` 仍可直接读取本机三平台登录态。v2 面板中新增的凭证就是从这里拿到的 token/deviceId/uid 等，手动填入“更新凭证”页即可。

### 上报问题

- 签到失败看云函数 `auto-sign` 日志
- 面板接口问题看 `auto-sign-api` 日志（返回 `code`：`0`成功/`401`未登录/`400`参数错/`403`未初始化/`404`未知动作/`500`内部错）