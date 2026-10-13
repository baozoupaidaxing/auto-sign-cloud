
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
├── manifest.json             # 标准 uni-app + uniCloud(aliyun) 配置，appid 已内置（__UNI__7FD496E）
├── App.vue / main.js         # uni-app 应用入口（壳，使项目可被识别为完整 uni-app 项目）
├── pages.json / uni.scss     # uni-app 页面与样式配置（壳）
├── package.json              # 前端依赖声明
├── pages/
│   └── index/
│       └── index.vue         # 最小首页（壳，无需改动）
├── uniCloud-aliyun/          # ⚠️ 目录名不可改，见下方说明
│   ├── cloudfunctions/
│   │   └── auto-sign/
│   │       ├── index.js      # uniCloud 云函数（三平台签到逻辑）
│   │       └── package.json  # 云函数配置：内存 128MB / 超时 60s
│   └── database/             # 集合 schema 存放位置（暂无文件，.gitkeep 占位）
├── get-credentials.js        # 一键读取本机三平台凭证（本地运行）
├── 一键获取签到凭证.bat       # 双击运行 get-credentials.js
└── README.md
```

> ⚠️ **`uniCloud-aliyun` 这个目录名不能改**，云函数必须放在 `uniCloud-aliyun/cloudfunctions/<函数名>/` 下，
> 否则 HBuilderX 识别不出 uniCloud 项目，右键也就没有「上传部署」「关联云服务空间」等菜单。
> 这是 HBuilderX unicloud 插件的判定规则（按项目根目录的相对路径正则匹配）：
>
> ```jsonc
> // plugins/unicloud/package.json 中的菜单显示条件
> "isCloudFunctionDir":      "... =~ /^uniCloud\\-(tcb|aliyun|alipay)\\/cloudfunctions$/"
> "isCloudFunctionChildDir": "workspaceFolderRelativePath =~ /^uniCloud\\-(tcb|aliyun|alipay)\\/cloudfunctions\\/[a-zA-Z0-9-_]+$/"
> ```
>
> 换腾讯云空间时目录名相应改为 `uniCloud-tcb`。

## 工作原理

| 平台 | 凭证存放位置 | 鉴权方式 |
|------|-------------|----------|
| Trae | `%APPDATA%\Trae CN\User\globalStorage\storage.json`（envelope 加密） | `Cloud-IDE-JWT <token>` + `x-device-id` |
| WorkBuddy | `%APPDATA%\CodeBuddy CN\...\state.vscdb`（OSCrypt） | `Bearer <token>` + `X-User-Id` |
| Qoder | `%APPDATA%\QoderCN\...\state.vscdb`（OSCrypt） | `Bearer <token>` + `Cosy-ClientType: 10` |

- **Trae**：`POST /trae/api/v2/ug/checkin_credits/claim`，body `{req_source:1}`，请求带 `X-User-Region` 头（缺失会导致 9074 风控）
- **WorkBuddy**：`POST /v2/billing/meter/daily-checkin`
- **Qoder**：先 `GET /sash/api/v1/me/campaigns` 查活动（每日 10:00 刷新新 campaignId），再 `POST /sash/api/v1/me/campaigns/{campaignId}/claim` 领取

## 部署步骤

> ⚠️ 凭证敏感，请在所有主机上始终先导入凭证再部署。

> 💡 **本项目是「完整的 uni-app + uniCloud 项目」，不是纯云函数目录。**
> 仓库根目录下的 `App.vue` / `main.js` / `pages.json` / `uni.scss` / `package.json` / `pages/index/index.vue`
> 是一套 uni-app **标准模板骨架**（壳），引入它们是为了：
> 1. **能运行本地云函数**：HBuilderX 只在「完整 uni-app 项目」语境下，才会为 `manifest.json` 提供 AppID 注册入口；
>    纯云函数项目虽能上传部署，但「运行本地云函数」会因 appid 未注册而报错「appid 为空，请先在 manifest.json 内重新获取」。
>    带上这套前端骨架后项目被完整识别，本地运行/调试云函数即可直接使用。
> 2. **可拓展**：未来可基于这套 uni-app 框架加前端页面（如签到状态面板），无需另起项目。
> 3. **可被 HBuilderX 正确识别为 uniCloud 项目**：配合 `uniCloud-aliyun/` 目录，右键即有「关联云服务空间」「上传部署」。
> 云函数本身的全部逻辑仍在 `uniCloud-aliyun/cloudfunctions/auto-sign/`，前端骨架无需改动。

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

> ⚠️ **云函数只能通过 HBuilderX 上传部署**。Web 控制台（unicloud.dcloud.net.cn）**没有**「新建云函数」入口，
> 它只用于：查看运行日志、建数据库集合、配置定时器与内存。所以下面必须走 HBuilderX。

**3.1 用 HBuilderX 打开本仓库目录**

**文件 → 打开目录** → 选择 `auto-sign-cloud`。

仓库已按 `uniCloud-aliyun/cloudfunctions/auto-sign/` 组织，打开后项目管理器里 `uniCloud-aliyun`
会显示为 uniCloud 目录，右键就有 uniCloud 相关菜单（若没有，检查目录名是否是 `uniCloud-aliyun`，
少了 `-aliyun` 后缀识别不到）。

**3.2 appid（作者已内置，他人需重新获取）**

`manifest.json` 内置的 `__UNI__7FD496E` 是作者已注册的，作者本人打开即用，无需改动。
他人 clone 使用时，请用**自己的** DCloud 账号登录 HBuilderX，双击 `manifest.json` → 设计器
「基础配置」→ 点 **「重新获取」**（自动注册并写回，无需去网页手动建），再关联你自己的空间。

> ⚠️ appid 必须与创建服务空间时用的 appid 一致；关联时提示无权限/空间不存在，多半是 appid 对不上。

**3.3 关联服务空间**

右键 `uniCloud-aliyun/cloudfunctions` →「**关联云服务空间**」→ 选中你的阿里云空间。

若空间列表为空，检查：
- HBuilderX 右上角已登录 DCloud 账号，且与**开通该服务空间的账号一致**
- 协作者身份需空间所有者在 uniCloud 控制台 →「成员管理」中授权
- 空间已实名认证、未欠费/冻结

**3.4 上传部署**

右键 `uniCloud-aliyun/cloudfunctions/auto-sign` →「**上传部署**」，底部控制台提示上传成功即可。

每次改完代码都要重新上传一次，云端才会生效——**git 提交不会自动同步到云端**，两者是独立的。

**3.5 配置内存规格（重要，省配额）**

`package.json` 中已声明 `"cloudfunction-config": { "memorySize": 128, "timeout": 60 }`，上传时会自动覆盖云端配置；
仍建议到控制台 → 云函数 → `auto-sign` → 详情复核一次，确认显示 **128MB**（默认 512MB）。
资源量按「内存 × 运行秒数（GBs）」计费，降到 128MB 后 GBs 消耗降 3/4；签到属轻 I/O 场景，128MB 无副作用。免费版每月 1000 GBs，512MB 时单次签到约 28 GBs，几天就超限。

**3.6 配置定时触发器**

控制台 → 云函数 → `auto-sign` → 定时触发器 → 新建，cron 填 `0 1 10 * * *`（北京时间每天 10:01）。

> ⚠️ 触发器、内存、环境变量都是**空间侧配置，不随 git 走**。删除云函数后重建，需要重新配置，别忘记改回 128MB。

> ⚠️ **Qoder 每日 10:00（UTC+8）刷新活动**，Trigger 必须设在 10:00 之后，故定在 10:01。
> ⚠️ uniCloud 定时触发为 **at-least-once**，同一次可能重复投递两遍（日志表现为同一 triggerTime 成对出现两次 `TIMER_LATEST`）；`auto-sign` 入口已加「当日幂等」，重复投递会直接跳过已签平台，不会重复烧 GBs。

## CLI 方式部署（可选）

不想每次点右键时，可以用 HBuilderX 自带的命令行工具（uniCloud cli 需 HBuilderX 3.1.9+）：

```powershell
$cli = "D:\Program Files\HBuilderX\cli.exe"

# 1. 列出项目，确认 --prj 要填的项目名或序号
& $cli project list

# 2. 列出可关联的服务空间（拿到序号 / 空间ID / 空间名）
& $cli cloud functions --list space --prj auto-sign-cloud --provider aliyun

# 3. 绑定服务空间（序号、空间ID、空间名 三选一）
& $cli cloud functions --assignspace 1 --prj auto-sign-cloud --provider aliyun

# 4. 上传：全部云函数，或只上传 auto-sign
& $cli cloud functions --upload all --prj auto-sign-cloud --provider aliyun
& $cli cloud functions --upload cloudfunction --prj auto-sign-cloud --provider aliyun --name auto-sign --force

# 5. 查看云端已有云函数
& $cli cloud functions --list cloudfunction --prj auto-sign-cloud --provider aliyun --cloud
```

| 参数 | 含义 |
|------|------|
| `--prj` | `cli project list` 中列出的项目名或序号 |
| `--provider` | 服务商代号：阿里云 `aliyun`、腾讯云 `tcb` |
| `--name` | 资源名，云函数填**目录名**（这里是 `auto-sign`） |
| `--cloud` | 列资源时加此参数 = 列云端；不加 = 列本地 |
| `--force` | 强制覆盖。CLI 模式遇到同名资源默认**跳过**，要覆盖必须加 |

常用变体：

```powershell
# 下载云端云函数到本地
& $cli cloud functions --download cloudfunction --prj auto-sign-cloud --provider aliyun --name auto-sign --force

# 初始化数据库（建表结构）
& $cli cloud functions --prj auto-sign-cloud --provider aliyun --initdatabase
```

> ⚠️ CLI 只是把右键操作脚本化，**前提不变**：目录结构必须是 `uniCloud-aliyun/cloudfunctions/<函数名>/`，
> `manifest.json` 里 appid 已填真实值，且 HBuilderX 已登录、该项目已在项目管理器中打开过。
> ⚠️ CLI 没有配置定时触发器和内存的命令，这两项仍要去 Web 控制台。

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