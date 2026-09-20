# auto-sign-cloud

uniCloud 定时云函数，自动签到三个平台并领取每日积分：

- **Trae SOLO CN**（`trae`）
- **WorkBuddy / CodeBuddy CN**（`workbuddy`）
- **Qoder CN**（`qoder`）

零依赖、零第三方包，仅用 Node 内置模块 + Windows 自带 PowerShell（DPAPI）。

---

## 版本/分支

| 分支 | 说明 |
|------|------|
| `master`（v1.x） | 纯定时签到，稳定，持续可维护（tag `v1.0.0` 为可回滚快照基线，**非冻结**） |
| `v2` | 在 master 基础上＋uniapp 可视化面板，开发完成后可合并回 master 打 `v2.0.0` |

## 目录结构（v2 合并工程）

```
auto-sign-cloud/
├── uniCloud-aliyun/         # 云端资源（当前绑定阿里云空间；目录名随厂商变，见下）
│   └── cloudfunctions/
│       ├── auto-sign/        # 三平台定时签到云函数
│       ├── auto-sign-api/    # 【v2】签到管理面板后端 API
│       └── common/           # 公共模块
│           ├── crypto-util/  # 【v2】AES-256-GCM 加解密
│           └── auth-util/    # 【v2】口令 + 会话
├── pages/                    # 【v2】uniapp 页面（H5 + 小程序）
│   ├── login/                #   登录（首次自动初始化口令）
│   ├── dashboard/            #   三平台状态 + 手动签到
│   └── credential/           #   更新凭证（加密提交）
├── common/                   # 【v2】前端公共请求封装
│   └── api.js
├── pages.json / manifest.json / main.js / App.vue / uni.scss   # uniapp 根配置
├── get-credentials.js        # 一键读取本机三平台凭证（本地运行）
├── 一键获取签到凭证.bat       # 双击运行 get-credentials.js
└── README.md
```

## 云厂商与目录名

本项目保持**云厂商无关**（云函数只调用 uniCloud 标准 API，不绑定厂商 SDK）。但 HBuilderX 的云目录名**由你关联的服务空间厂商决定**：

| 关联的空间 | HBuilderX 生成的云目录 |
|-----------|----------------------|
| 阿里云 | `uniCloud-aliyun/` |
| 支付宝云 | `uniCloud-alipay/` |
| 腾讯云 | `uniCloud-tencent/` |

- 本仓库 git 显示的 `uniCloud-aliyun/` 表示**当前绑定的是阿里云空间**；换厂商后该目录会被 HBuilderX 自动改成 `uniCloud-<厂商>/`。
- 换厂商时：在 HBuilderX 重新“关联新服务空间”，HBuilderX 会生成对应新目录名的云目录，**用同一套源码重新上传云函数 / 公共模块 / schema 即可**，代码无需改动。
- 数据库初始化用 **当前厂商目录下的 `database/*.schema.json`**。

## 工作原理

| 平台 | 凭证存放位置 | 鉴权方式 |
|------|-------------|----------|
| Trae | `%APPDATA%\TRAE SOLO CN\...\storage.json`（envelope 加密） | `Cloud-IDE-JWT <token>` + `x-device-id` |
| WorkBuddy | `%APPDATA%\CodeBuddy CN\...\state.vscdb`（OSCrypt） | `Bearer <token>` + `X-User-Id` |
| Qoder | `%APPDATA%\QoderCN\...\state.vscdb`（OSCrypt） | `Bearer <token>` + `Cosy-ClientType: 10` |

- **Trae**：`POST /trae/api/v2/ug/checkin_credits/claim`，body `{req_source:1}`，请求带 `X-User-Region` 头（缺失会导致 9074 风控）
- **WorkBuddy**：`POST /v2/billing/meter/daily-checkin`
- **Qoder**：先 `GET /sash/api/v1/me/campaigns` 查活动（每日 10:00 刷新新 campaignId），再 `POST /sash/api/v1/me/campaigns/{campaignId}/claim` 领取

## v1 部署步骤

> ⚠️ 凭证敏感，请在所有主机上始终先导入凭证再部署。

### 1. 获取凭证

双击 `一键获取签到凭证.bat`（或 `node get-credentials.js`）。脚本会：
1. 读取本机三平台本地登录态的 token
2. 调用各平台查询接口校验有效性 + 显示过期时间
3. 生成 `auto_sign_config` 集合的三条配置 JSON，写入 `签到凭证.txt`（已 gitignore，不会入库）并复制到剪贴板

### 2. 配置 uniCloud 数据库

在 uniCloud 数据库建 **`auto_sign_config`** 集合，插入 3 条记录（`_id` 分别为 `trae` / `workbuddy` / `qoder`），字段来自脚本输出：

```jsonc
// _id: "trae"
{ "_id": "trae", "enable": true, "accessToken": "<token>", "deviceId": "<deviceId>", "userId": "<userId>", "host": "https://api.trae.cn", "userRegion": "CN" }
// _id: "workbuddy"
{ "_id": "workbuddy", "enable": true, "accessToken": "<token>", "uid": "<uid>" }
// _id: "qoder"
{ "_id": "qoder", "enable": true, "accessToken": "<token>" }
```

### 3. 部署云函数 + 配置定时触发器

1. 新建云函数 `auto-sign`，把 `uniCloud/cloudfunctions/auto-sign/index.js` 内容粘贴部署
2. 建定时触发器（cron）

> ⚠️ **Qoder 每日 10:00（UTC+8）刷新活动**，Trigger 必须设在 10:00 之后。建议 `0 3 20 * * *`（阿里云 / UTC 20:00 = 北京 04:00）视时钟而定，**确保在北京时间 10:05 后运行**。

## 定时说明

| 平台 | 每日刷新点 |
|------|-----------|
| Trae | 北京时间 00:00 |
| WorkBuddy | 北京时间 00:00 |
| Qoder | **北京时间 10:00** |

## 签到日志

云函数将结果写入 **`sign_log`** 集合（`platform` / `success` / `message` / `date`）。

## 说明

- token 会过期。重新运行 `一键获取签到凭证.bat` 并更新数据库即可续期。
- 已签到 / 已领取会跳过（幂等），不会重复调用。

---

## 🆕 v2：可视化签到管理面板（uniapp）

在 v1 定时签到基础上，新增一个 **uniapp 管理面板**（可同时部署 H5 网页 + 微信小程序），用于：
- 查看三平台当前签到状态 / 是否已签 / 最近结果
- 凭证失效时**直接在网页上输入新凭证**（加密存储，不回显明文）
- **手动触发**签到云函数

### 新增/改动文件

```
uniCloud-aliyun/cloudfunctions/
├── common/
│   ├── crypto-util/          # 【新增】公共模块：AES-256-GCM 加解密 / 口令哈希 / 会话token
│   │   ├── index.js
│   │   └── package.json
│   └── auth-util/            # 【新增】公共模块：管理口令 + 会话校验
│       ├── index.js
│       └── package.json
├── auto-sign/                # 【改造】导入 crypto-util，cfg.enc 存在则解密凭证（兼容旧明文）
│   └── index.js
└── auto-sign-api/            # 【新增】云函数 API：login/status/checkin/credential
    └── index.js
pages/                        # 【新增】uniapp 面板（H5 + 微信小程序）
├── login/                    #   口令登录页（首次自动初始化口令）
├── dashboard/                #   三平台状态 + 手动签到 + 更新入口
└── credential/               #   更新凭证页（加密提交）
common/api.js                 #   跨端统一 callFunction 封装
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

> v2 是 uni-app + uniCloud 合并工程，请用 **HBuilderX** 打开本项目根目录。

1. **建公共模块**：右键 `uniCloud-aliyun/cloudfunctions/common/crypto-util`、`auth-util` → 上传公共模块
2. **部署云函数**：`auto-sign`、`auto-sign-api` 分别上传部署（`auto-sign-api` 依赖公共模块，直接 `require('crypto-util')` / `require('auth-util')`）
3. **配置密钥**：在 `auto-sign-api` 云函数环境变量设置 `AS_MASTER_KEY=64位hex`
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
4. **首次登录初始化**：打开 H5 网页 → 输入口令登录（首次自动把该口令设为管理员口令，请牢记）
5. **导入/更新凭证**：在网页“更新凭证”页粘贴各平台 token（可配合 v1 的 `一键获取签到凭证.bat` 读取，再手动填入）
6. **手动签到/看状态**：仪表盘一键查看与触发
7. **发布**：H5 用 uniCloud 前端网页托管；小程序用 `uniCloud.callFunction` 无需额外域名配置

> ⚠️ 资源配额：面板状态查询默认读数据库缓存日志，不做高频轮询；实时接口仅在你点“刷新 / 手动签到”时触发，注意关注免费版每日云函数调用与前端访问量限额。

### 与 v1 凭证脚本联动

v1 的 `get-credentials.js` 仍可直接读取本机三平台登录态。v2 面板中新增的凭证就是从这里拿到的 token/deviceId/uid 等，手动填入“更新凭证”页即可。

### 上报问题

- 签到失败看云函数 `auto-sign` 日志
- 面板接口问题看 `auto-sign-api` 日志（返回 `code`：`0`成功/`401`未登录/`400`参数错/`403`未初始化/`404`未知动作/`500`内部错）
### v2 面板交互增强

- **状态查询（方案 B）**：默认读数据库缓存日志，今日无记录才实时查平台 status 接口；真已签则兜底回写今日 `sign_log`，供下次直接读缓存 —— 既准确又省配额。
- **已签不重复执行**：全部/手动签到对已签的平台自动跳过；全部已签时「全部签到」按钮置灰。批量签到时只对「已配置、启用、未签」的平台发起，避免浪费。
- **凭证有效期提醒**：Trae / WorkBuddy token 为 JWT，由 `get-credentials.js` 输出（或后端从 token 解析）存入 `auto_sign_config.expires_at`，仪表盘凭证旁显示“剩 X 天 / 今日到期”；Qoder token 非 JWT（27 位随机串）无到期信息，恒显示“有效期未知”。
- **一键 JSON 批量导入**：`一键获取签到凭证.bat` 的输出整体复制到「更新凭证」页 JSON 框，一次更新三平台；勾选自动识别并跳过无效/过短的 token。
- **刷新限频**：仪表盘「刷新」按钮 1 分钟最多点一次，控制云函数调用量。

### v2 仪表盘状态判定（方案 B 时序）

```
进入/刷新
 └→ 查 sign_log 今日(platform,date)记录
       ├─ 今日有成功记录 → 显示“今日已签”(只读库,不烧接口)
       └─ 无 → 一次性实时查 auto-sign(mode:status)
                 ├─ 真已签 → upsert 补写今日记录 → “今日已签”
                 └─ 未签 → “待签到”(不写记录)
```