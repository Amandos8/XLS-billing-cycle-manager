# 账期开关助手 (Billing Cycle Manager)

自动化执行 Oracle 数据库状态更新 + Portal 网页 Data Refresh 的账期开关工作流。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 编译
npm run build

# 3. 配置密码（见下方"配置"章节）
cp .env.example .env
# 编辑 .env，将占位符替换为实际密码

# 4. 在 Claude Code 中直接说：
#    "开XLS_REGRESSION的账期20041"
```

## 使用方式

直接用自然语言告诉 Claude 你要做什么，Skill 会自动解析参数并执行完整流程。

### 交互示例

```
你: 开UAT的账期202501
→ 自动解析: env=UAT, billingCycleId=202501, action=开

你: 关掉XLS_DRYRUN的账期888
→ 自动解析: env=XLS_DRYRUN, billingCycleId=888, action=关

你: 开账期
→ Skill询问: 请问要操作哪个环境？可选：UAT, TB, XLS_REGRESSION, XLS_DRYRUN
你: XLS_REGRESSION
→ Skill询问: 请提供账期ID（纯数字）
你: 20041
→ 开始执行...
```

### 可选环境

| 环境名 | 说明 |
|--------|------|
| `UAT` | UAT 测试环境 |
| `TB` | TB 测试环境 |
| `XLS_REGRESSION` | XLS 回归测试环境 |
| `XLS_DRYRUN` | XLS DryRun 环境 |

### 操作类型

- **开账期**：将 STATE 设为 'A'（Active）
- **关账期**：将 STATE 设为 'C'（Closed）

如果参数不全，Skill 会逐项询问补齐后再执行。

## 工作流程

执行顺序：数据库操作 → GUI 操作，共 4 个阶段。

```
阶段1: 参数验证
  └→ 检查 env、id、action 三个参数是否齐全且合法

阶段2: 数据库操作（Oracle）
  ├→ 连接数据库（密码从环境变量获取）
  ├→ SELECT 查询账期是否存在
  │   └→ 不存在 → 返回错误
  └→ UPDATE 更新账期状态（开→'A'，关→'C'）+ COMMIT

阶段3: GUI操作（Chrome CDP + Playwright）
  ├→ 连接 Chrome（自动拉起调试模式）
  ├→ 自动登录 Portal（如需要）
  ├→ 自动选择 Job（如出现弹窗）
  ├→ 第一轮：INVOICING CENTER Data Refresh
  │   ├→ 打开菜单 → 搜索"data refresh" → 进入 Data Refresh 页面
  │   ├→ 点击 Refresh → 确认 OK → 等待 loading 消失
  │   ├→ 选择最新 Version 行 → 点击 Immediately Active → 确认 OK ×2
  │   └→ 每步失败自动重试（最多3次）
  └→ 第二轮：BILLING COMMON DATA Common Data Refresh
      ├→ 打开菜单 → 搜索"data refresh" → 进入 Common Data Refresh 页面
      ├→ 点击 Refresh All → 等待 loading 消失
      └→ 每步失败自动重试（最多3次）

阶段4: 清理资源
  └→ 关闭浏览器连接 + 关闭数据库连接池
```

### GUI 操作步骤详情（共17步）

**第一轮：INVOICING CENTER Data Refresh（步骤1-11）**

| # | 操作 | 说明 |
|---|------|------|
| 1 | 点击菜单按钮 | 打开左上角菜单面板 |
| 2 | 输入搜索关键词 | 在搜索框输入"data refresh" |
| 3 | 点击搜索按钮 | 执行菜单搜索 |
| 4 | 点击 Data Refresh 菜单 | 进入 INVOICING CENTER > Data Refresh |
| 5 | 点击 Refresh 按钮 | 触发数据刷新 |
| 6 | 确认 OK | 确认弹出对话框 |
| 7 | 等待 loading 消失 | 等待 Refresh 完成（最长30秒） |
| 8 | 选择最新 Version 行 | 在 jqGrid 表格中选中 row id 最大的行 |
| 9 | 点击 Immediately Active | 激活选中的版本 |
| 10 | 确认 OK | 确认激活对话框 |
| 11 | 确认 OK（绿色按钮） | 最终确认 |

**第二轮：BILLING COMMON DATA Common Data Refresh（步骤12-17）**

| # | 操作 | 说明 |
|---|------|------|
| 12 | 点击菜单按钮 | 再次打开菜单 |
| 13 | 输入搜索关键词 | 搜索"data refresh" |
| 14 | 点击搜索按钮 | 执行菜单搜索 |
| 15 | 点击 Common Data Refresh 菜单 | 进入 BILLING COMMON DATA > Common Data Refresh |
| 16 | 点击 Refresh All | 一键触发 30 个 Refresh Cache |
| 17 | 等待 loading 消失 | 等待所有缓存刷新完成（最长120秒） |

## 配置

### 1. 环境变量（.env 文件）

密码通过 `.env` 文件注入，不硬编码在代码中。

```bash
cp .env.example .env
```

编辑 `.env`，将所有 `请替换为实际密码` 替换为真实密码：

```
# Oracle 数据库密码
ORACLE_PASSWORD_UAT=实际密码
ORACLE_PASSWORD_TB=实际密码
ORACLE_PASSWORD_XLS_REGRESSION=实际密码
ORACLE_PASSWORD_XLS_DRYRUN=实际密码

# Portal 登录密码
PORTAL_PASSWORD_UAT=实际密码
PORTAL_PASSWORD_TB=实际密码
PORTAL_PASSWORD_XLS_REGRESSION=实际密码
PORTAL_PASSWORD_XLS_DRYRUN=实际密码
```

所有环境都需要配置 Oracle 和 Portal 密码。

### 2. 环境配置（config/env-config.json）

每个环境的数据库连接信息和 Portal 地址在此文件中定义。如果需要修改 IP、端口、服务名等，编辑此文件。

关键字段说明：

```jsonc
{
  "environments": {
    "环境名称": {
      "oracle": {
        "host": "数据库IP",       // Oracle 服务器地址
        "port": 11521,            // Oracle 端口
        "service": "服务名",       // Oracle SERVICE_NAME
        "user": "cpc",            // 数据库用户名
        "passwordEnvVar": "环境变量名"  // 密码从 .env 中读取，不直接存储
      },
      "portal": {
        "url": "Portal地址",       // Portal 登录入口 URL
        "loginRequired": true,     // true=需登录，false=SSO免登
        "cookieDomain": "域名",    // Cookie 所属域名
        "credentials": {           // loginRequired=true 时必填
          "username": "用户名",
          "passwordEnvVar": "环境变量名",
          "organization": "Job选择中的Organization",
          "job": "Job选择中的Job"
        }
      }
    }
  }
}
```

**需要手动修改的占位符**：部分环境的 `username`、`organization` 字段仍为占位符 `请替换为实际用户名` / `Default Organization(Please modify)`，需替换为实际值。

### 3. Chrome 浏览器

程序自动启动 Chrome 调试模式（CDP 端口 9222），使用独立用户目录，不影响日常使用的 Chrome。

默认 Chrome 路径：`C:/Program Files/Google/Chrome/Application/chrome.exe`

如果 Chrome 安装在其他位置，需修改 `src/browser.ts` 中的 `CHROME_PATH` 常量。

## 依赖安装

### 首次安装

```bash
npm install
```

安装的包（约 300MB）：

| 包 | 用途 |
|---|------|
| `oracledb` | Oracle 数据库连接（内置 Thin Mode，无需额外安装 Oracle Client） |
| `playwright` | 通过 CDP 操控 Chrome（不下载 Chromium，复用已有 Chrome） |
| `dotenv` | 从 `.env` 文件读取环境变量 |
| `typescript` | TypeScript 编译器 |
| `ts-node` | 开发模式直接运行 .ts 文件 |

### 前置要求

- **Node.js >= 18**：`node --version` 验证
- **Google Chrome**：程序通过 CDP 连接已有 Chrome，不下载 Chromium

### Oracle 连接

优先检测系统已有 `oci.dll`（Oracle Instant Client），未找到则自动降级为 oracledb Thin Mode（纯 JavaScript，零额外安装）。两种模式均无需手动配置。

### 编译

```bash
npm run build
```

TypeScript 编译到 `dist/` 目录，5-15 秒完成。

## 失败处理与回滚

| 失败场景 | 处理方式 |
|----------|----------|
| 参数不完整 | 提示补充参数，不执行任何操作 |
| 账期不存在 | 提示重新输入账期ID |
| GUI 单步失败 | 自动重试当前步骤（最多 3 次） |
| GUI 重试 3 次仍失败 | **自动回滚数据库**，恢复为操作前的状态，保存截图 |
| 账期已是目标状态 | 跳过数据库更新，仍执行 GUI 操作 |

截图保存在 `screenshots/` 目录，用于失败排查。

## 项目结构

```
billing-cycle-manager/
├── .env                    # 密码环境变量（不提交Git）
├── .env.example            # 密码模板（复制后编辑）
├── config/env-config.json  # 各环境数据库和Portal配置
├── src/
│   ├── index.ts            # 入口：参数解析
│   ├── orchestrator.ts     # 编排：串联数据库+GUI流程
│   ├── database.ts         # Oracle 数据库操作
│   ├── browser.ts          # Chrome CDP + Playwright GUI操作
│   ├── types.ts            # 类型定义
│   ├── utils.ts            # 工具函数（日志、验证等）
│   └── inspect.ts          # 环境检查（依赖检测）
├── scripts/                # 辅助脚本（UI录制等）
├── dist/                   # 编译输出（npm run build 生成）
└── screenshots/            # 错误截图（运行时生成）
```

## 常见问题

**Chrome 启动超时**

确认 Chrome 已安装且路径正确。如果端口 9222 被占用，关闭其他 Chrome 调试实例后重试。

**Oracle 连接失败**

检查网络是否可达数据库服务器 IP 和端口。确认 `.env` 中密码正确。

**Portal 登录失败**

确认 `config/env-config.json` 中 `credentials` 的 `username`、`organization`、`job` 已从占位符替换为实际值。确认 `.env` 中对应 Portal 密码正确。

**GUI 步骤超时**

Portal 页面加载慢可能导致超时。可在 `src/browser.ts` 的 `buildGuiSteps()` 中调整各步骤的 `timeout` 值。截图保存在 `screenshots/` 目录可供排查。

**SSL 证书警告**

程序自动忽略 SSL 证书错误（Chrome 启动参数 `--ignore-certificate-errors`），内网环境无需额外配置。