
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