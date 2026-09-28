
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

## 目录结构

```
auto-sign-cloud/
├── cloudfunctions/
│   └── auto-sign/
│       └── index.js          # uniCloud 云函数（三平台签到逻辑）
├── get-credentials.js        # 一键读取本机三平台凭证（本地运行）
├── 一键获取签到凭证.bat       # 双击运行 get-credentials.js
└── README.md
```

## 工作原理

| 平台 | 凭证存放位置 | 鉴权方式 |
|------|-------------|----------|
| Trae | `%APPDATA%\TRAE SOLO CN\...\storage.json`（envelope 加密） | `Cloud-IDE-JWT <token>` + `x-device-id` |
| WorkBuddy | `%APPDATA%\CodeBuddy CN\...\state.vscdb`（OSCrypt） | `Bearer <token>` + `X-User-Id` |
| Qoder | `%APPDATA%\QoderCN\...\state.vscdb`（OSCrypt） | `Bearer <token>` + `Cosy-ClientType: 10` |

- **Trae**：`POST /trae/api/v2/ug/checkin_credits/claim`，body `{req_source:1}`，请求带 `X-User-Region` 头（缺失会导致 9074 风控）
- **WorkBuddy**：`POST /v2/billing/meter/daily-checkin`
- **Qoder**：先 `GET /sash/api/v1/me/campaigns` 查活动（每日 10:00 刷新新 campaignId），再 `POST /sash/api/v1/me/campaigns/{campaignId}/claim` 领取

## 部署步骤

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

1. 新建云函数 `auto-sign`，把 `cloudfunctions/auto-sign/index.js` 内容粘贴部署
2. **配置内存规格（重要，省配额）**：在云控制台把 `auto-sign` 内存从默认 **512MB 改为 128MB**。资源量按「内存 × 运行秒数（GBs）」计费，降到 128MB 后 GBs 消耗降 3/4；签到属轻 I/O 场景，128MB 无副作用。免费版每月 1000 GBs，512MB 时单次签到约 28 GBs，几天就超限。
3. 建定时触发器（cron）：`0 1 10 * * *`（北京时间每天 10:01）

> ⚠️ **Qoder 每日 10:00（UTC+8）刷新活动**，Trigger 必须设在 10:00 之后，故定在 10:01。
> ⚠️ uniCloud 定时触发为 **at-least-once**，同一次可能重复投递两遍（日志表现为同一 triggerTime 成对出现两次 `TIMER_LATEST`）；`auto-sign` 入口已加「当日幂等」，重复投递会直接跳过已签平台，不会重复烧 GBs。

## 资源优化（GBs 配额）

`auto-sign` 已针对免费版 1000 GBs/月 配额做如下优化：

- **入口当日幂等**：每次触发先查 `sign_log` 今日成功记录，已签平台直接跳过，抵御定时 at-least-once 重复投递；各平台「已签/已领取」出口均会回写成功记录，保证幂等命中。
- **三平台并行**：`Promise.allSettled` 并发签到，端到端耗时 = 最慢的单个平台（原为串行相加）。
- **超时收紧**：查询类 8s、claim 类 10s（原统一 15s）。
- **重试收紧**：Trae 9074 限流重试由 3 次（2s/5s/10s）降为 2 次（1s/3s），重试后仍有 status 回查兜底。
- **日期修正**：`sign_log.date` 按北京时间（UTC+8）取值，修复凌晨 00:00~08:00 写成「昨天」的问题。

配合内存降到 128MB，单次签到 GBs 消耗从约 28 降到个位数。

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
- 已签到 / 已领取会跳过（幂等），不会重复调用；入口另有「当日幂等」，今日已成功的平台连状态查询都不再发起。