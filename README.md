
> ## 豁免权声明（免责声明）
>
> **本项目仅供个人学习与程序研究参考，禁止任何形式的商业使用。**
>
> 1. **非商用**：未经作者书面授权，不得将本项目（含全部或部分代码、文档）用于任何商业用途，包括但不限于：收费提供服务、内置于盈利产品、用于生产经营。
> 2. **风险自担**：本项目通过自动化方式登录并操作第三方平台（Trae / WorkBuddy / Qoder 等），可能违反相应平台的用户协议或触发风控，导致账号被限制、封禁或数据异常。**因使用本项目造成的一切账号异常、数据丢失、经济损失或其他后果，均由使用者自行承担。**
> 3. **凭证与信息安全**：本项目会读取并提交你的登录凭证（Token / 设备信息）。任何凭证、密钥、环境变量的读取与保管责任均由使用者承担；因配置不当、泄露、滥用等导致的任何损失，作者不承担责任。
> 4. **无任何明示或默示保证**：本项目按“现况”（AS IS）提供，作者不对其适用性、稳定性、准确性或任何特定用途作任何保证。
> 5. **合规责任**：使用者应自行遵守所在地法律法规及涉事平台服务条款；作者不审查使用场景，亦不对使用者的任何违规行为负责。
>
> 使用本项目即表示你已阅读并同意以上条款。若不同意，请勿使用。
>
> 本项目的代码许可见文件 LICENSE（MIT License）。
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
├── uniCloud-alipay/         # 云端资源（当前绑定支付宝云空间；目录名随厂商变，见下）
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

- 本仓库 git 显示的 `uniCloud-alipay/` 表示**当前绑定的是支付宝云空间**（历史上曾用阿里云 `uniCloud-aliyun/`）；换厂商后该目录会被 HBuilderX 自动改成 `uniCloud-<厂商>/`。
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

1. 新建云函数 `auto-sign`，把 `uniCloud-alipay/cloudfunctions/auto-sign/index.js` 内容粘贴部署
2. 建定时触发器（cron）

> ⚠️ **Qoder 每日 10:00（UTC+8）刷新活动**，Trigger 必须设在 10:00 之后。当前配置为 `0 1 10 * * *`（每天北京时间 10:01）。

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
uniCloud-alipay/cloudfunctions/
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

1. **建公共模块**（注意顺序，被依赖的先传）：右键 `uniCloud-alipay/cloudfunctions/common/crypto-util` → 上传公共模块，再上传 `auth-util`（它依赖 crypto-util）
2. **部署云函数**：`auto-sign`、`auto-sign-api` 分别上传部署（`auto-sign-api` 依赖公共模块，直接 `require('crypto-util')` / `require('auth-util')`）
3. **配置密钥**：在 `auto-sign` 与 `auto-sign-api` **两个云函数的环境变量中都设置同一个** `AS_MASTER_KEY=64位hex`（两处值必须完全一致，否则加密/解密不匹配，线上会显示「未配置」或签到失败；**未设置时云函数会直接报错**，不会静默用占位密钥）
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
4. **配置内存规格（重要，省配额）**：在云控制台把 `auto-sign` 与 `auto-sign-api` 的内存从默认 **512MB 改为 128MB**。资源量按「内存 × 运行秒数（GBs）」计费，降到 128MB 后 GBs 消耗降 3/4；签到/查询属轻 I/O 场景，128MB 无副作用。免费版每月 1000 GBs（阿里云/支付宝云相同），512MB 时单次签到约 28 GBs，几天就超限。
5. **配置定时触发器**：cron `0 1 10 * * *`（北京时间 10:01，必须在 Qoder 10:00 刷新之后）。注意：uniCloud 定时触发为 **at-least-once**，同一次可能重复投递两遍；`auto-sign` 入口已加「当日幂等」（今日 `sign_log` 已有成功记录的平台直接跳过），重复投递不会重复烧 GBs。
6. **首次登录初始化**：打开 H5 网页 → 输入口令登录（首次自动把该口令设为管理员口令，请牢记）
   > ⚠️ **部署后立即登录初始化**：settings 不存在时，任何先访问面板的人都能把自己的口令设为管理员（抢注）。
7. **导入/更新凭证**：在网页“更新凭证”页粘贴各平台 token（可配合 v1 的 `一键获取签到凭证.bat` 读取，再手动填入）
8. **手动签到/看状态**：仪表盘一键查看与触发
9. **发布**：H5 用 uniCloud 前端网页托管；小程序用 `uniCloud.callFunction` 无需额外域名配置

> 会话说明：登录会话默认 4 小时有效；会话为单文档存储，**新登录会挤掉旧会话**（多设备会互踢，属预期设计）。

> ⚠️ 资源配额：面板状态查询默认读数据库缓存日志，不做高频轮询；实时接口仅在你点“刷新 / 手动签到”时触发，注意关注免费版每日云函数调用与前端访问量限额。

### 与 v1 凭证脚本联动

v1 的 `get-credentials.js` 仍可直接读取本机三平台登录态。v2 面板中新增的凭证就是从这里拿到的 token/deviceId/uid 等，手动填入“更新凭证”页即可。

### 上报问题

- 签到失败看云函数 `auto-sign` 日志
- 面板接口问题看 `auto-sign-api` 日志（返回 `code`：`0`成功/`401`未登录/`400`参数错/`403`未初始化/`404`未知动作/`500`内部错）

### 排查小节（历史真实踩坑）

| 现象 | 根因 | 解法 |
|------|------|------|
| 本地有凭证，线上显示「未配置」或签到报解密失败 | ① `auto-sign` 与 `auto-sign-api` 两函数 `AS_MASTER_KEY` 不一致；② 公共模块改后未重传；③ 换密钥后库里旧密文解不开 | 两函数环境变量设**同一个**密钥；按 crypto-util → auth-util → 云函数顺序重传；面板重新提交一次凭证（重新加密入库） |
| 云端 `MODULE_NOT_FOUND: crypto-util/auth-util` | 公共模块未上传，或用了相对路径 require 且 package.json 未声明 `file:` 依赖 | 公共模块一律 `require('模块名')` + package.json `file:` 依赖，先传被依赖模块 |
| 云函数资源量（GBs）几天就超限 | ① 内存 512MB 单价高；② 定时触发 at-least-once 重复投递（日志表现为每天同一 triggerTime 成对出现两次 `TIMER_LATEST`）；③ 三平台串行 + 长重试 sleep + 15s 超时，单次几十秒 | 内存降到 128MB；入口当日幂等跳过已签平台；三平台并行；重试收紧为 2 次（1s/3s）、超时查询 8s/claim 10s |
| 凌晨手动签到后面板仍显示「待签到」 | `date` 字段曾用 UTC 日期，北京时间 00:00~08:00 写成了「昨天」，缓存匹配失效 | 已修复：`todayCN()` 按 UTC+8 取日期 |
| Qoder 已签但面板每次刷新都实时查 | 已签/已领取路径不回写 `sign_log`，方案B缓存永不命中 | 已修复：所有「已签/已领取」出口统一回写成功记录 |
| Qoder 明明可领却报「今日无待领取活动」 | `claimable` 字段判定先于 campaigns 检查的时序坑 | 已修复：以 campaigns 中 CLAIMABLE 活动为准判定 |
| HBuilderX 改了代码不生效 | 本地调试缓存旧云函数 | 重启本地调试或重新上传部署 |
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
---

## 支持作者 ☕

如果这个项目对你有帮助，欢迎请作者喝杯咖啡，你的支持是我持续维护的动力 👇

<p align="center">
  <img src="./docs/images/alipay.webp" width="320" alt="支付宝赞助" />
  &nbsp;&nbsp;
  <img src="./docs/images/wechat.webp" width="320" alt="微信赞助" />
</p>

<p align="center">
  <strong>扫码赞助 · 感谢支持</strong>
</p>