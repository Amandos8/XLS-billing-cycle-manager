---
name: billing-cycle-manager
description: 自动开关账期，支持UAT/TB/XLS_REGRESSION/XLS_DRYRUN。先操作Oracle数据库更新账期状态，再通过Playwright自动操作Portal网页完成Data Refresh。
triggers:
  - 开账期
  - 关账期
  - 账期开关
  - 打开账期
  - 关闭账期
  - billing cycle
---

# 账期开关助手 (Billing Cycle Manager)

## 概述

账期开关助手是一个自动化工具，用于执行"先操作Oracle数据库 → 再操作Portal网页"的完整账期开关工作流。

**一句话描述：** 用户说"帮我开UAT的账期123"，Skill自动完成数据库更新 + 网页Data Refresh全部操作。

---

## Agent执行纪律（CRITICAL — 必须严格遵守）

**本Skill的所有操作必须通过运行项目代码完成，Agent不得自行执行任何操作。**

### 绝对禁止事项

1. **禁止自行执行SQL** — Agent不得使用任何工具（包括但不限于Bash、数据库客户端、其他平台的数据操作能力）直接执行SELECT/UPDATE/INSERT/DELETE语句。所有数据库操作必须通过运行 `npx ts-node src/index.ts --env <环境> --id <账期ID> --action <开/关>` 由代码完成。代码内部已实现：Schema隔离（`ALTER SESSION SET CURRENT_SCHEMA = CPC`）、绑定变量防注入、事务提交、失败回滚。Agent自行执行SQL会导致：连错数据库、操作错误Schema、遗漏回滚、数据不一致。

2. **禁止要求用户手动启动Chrome** — 代码已实现自动启动Chrome调试模式（独立user-data-dir，不影响用户日常Chrome）。Agent不得输出"请手动执行 chrome.exe --remote-debugging-port=9222"或任何类似提示。如果Chrome启动失败，应排查代码报错原因并修复代码，而非绕过代码让用户手动操作。

3. **禁止绕过代码逻辑自行操作浏览器** — Agent不得使用Playwright、Puppeteer或其他浏览器自动化工具直接操作Portal页面。所有GUI操作必须通过运行项目代码完成。代码已实现：自动登录、Job选择、Data Refresh全流程、失败重试、截图记录。

4. **禁止跳过或修改工作流步骤** — Agent不得因为"这一步看起来不需要"而跳过任何步骤，也不得自行决定"先做GUI再做数据库"等与代码逻辑不同的执行顺序。代码的工作流顺序（数据库先行 → GUI后续 → 失败回滚）是保证数据一致性的关键。

### 正确执行方式

```
正确：npx ts-node src/index.ts --env UAT --id 202501 --action 开
错误：sqlplus cpc/password@host:port/service "UPDATE CBEC_BILLING_CYCLE SET STATE='A'..."
错误：请手动打开Chrome调试模式
错误：用Playwright直接打开Portal操作
错误：这一步不需要，我直接跳过
```

### 异常处理原则

- 代码运行出错 → 阅读错误日志，修复代码中的bug，重新运行代码
- 配置缺失 → 引导用户修改配置文件或环境变量，然后重新运行代码
- 任何情况下都不得用"手动操作"替代代码执行

---

## 输入契约（Input Contract）

### 必填参数

用户调用此Skill时必须提供以下三个参数。**如果任何一个缺失，Skill必须主动向用户询问补齐。**

| 参数 | 类型 | 说明 | 可选值 |
|------|------|------|--------|
| `env` | 字符串 | 目标环境名称 | `UAT`, `TB`, `XLS_REGRESSION`, `XLS_DRYRUN` |
| `billingCycleId` | 字符串 | 账期ID | 纯数字，如 `123456` |
| `action` | 字符串 | 操作类型 | `开` (开账期), `关` (关账期) |

### 参数采集规则

当用户调用Skill但参数不完整时，按以下规则依次询问：

1. **缺少环境名称**：询问"请问要操作哪个环境？可选：UAT, TB, XLS_REGRESSION, XLS_DRYRUN"
2. **缺少账期ID**：询问"请提供账期ID（纯数字）"
3. **缺少操作类型**：询问"请问要开账期还是关账期？"

### 输入示例

```
用户: 帮我开UAT的账期202501
→ 解析结果: env=UAT, billingCycleId=202501, action=开

用户: 关掉XLS_DRYRUN的账期888
→ 解析结果: env=XLS_DRYRUN, billingCycleId=888, action=关

用户: 开账期
→ Skill询问: "请问要操作哪个环境？还需要提供账期ID。"
```

---

## 输出契约（Output Contract）

### 成功输出

```
✅ 账期已成功打开！
环境: UAT
账期ID: 202501
状态已设为: A (Active/激活)
GUI操作已全部完成（Data Refresh + Common Data Refresh）
```

### 失败输出

```
❌ 操作失败: GUI步骤执行失败: 点击Refresh按钮 - Timeout 30000ms exceeded
失败步骤: 点击Refresh按钮
完成步骤: 3/15
截图已保存至: D:\billing-cycle-manager\screenshots\error-2025-01-15T10-30-00.png
数据库已回滚，账期状态已恢复。
```

---

## 工作流程

Skill内部按以下顺序自动执行：

```
阶段0: 环境检查（首次使用时自动执行，最大化复用已有软件）
  ├→ 检查 Node.js >= 18
  │   └→ 不满足 → 提示升级。大多数用户已安装，极少触发。
  ├→ 检查 npm 依赖（node_modules/ 是否存在）
  │   └→ 不存在 → 自动 npm install。仅此一步需要下载，约300MB。
  ├→ 检查 Oracle 连接能力（按优先级尝试）
  │   ├→ ① 检测 oci.dll 是否在 PATH 中 → 找到则直接使用（复用已有）
  │   └→ ② 未找到 → 使用 oracledb Thin Mode，零额外安装
  ├→ 检查 Playwright npm 包（node_modules 安装后即满足）
  │   └→ 无需单独下载浏览器，因为使用 CDP 连接用户已有 Chrome
  └→ 检查 Chrome 浏览器
  │   └→ 检测 chrome.exe → 找到则复用
  │   └→ 未找到 → 提示安装。大多数用户已安装，极少触发。

阶段1: 参数验证
  └→ 检查env、billingCycleId、action三个参数是否齐全且合法

阶段2: 读取配置
  └→ 从 config/env-config.json 读取目标环境的Oracle和Portal配置

阶段3: 数据库操作（Oracle）
  ├→ 连接数据库（密码从环境变量获取）
  ├→ SELECT查询账期是否存在
  │   └→ 不存在 → 返回错误，要求用户重新输入
  └→ UPDATE更新账期状态
      ├→ 开账期: SET STATE='A'
      ├→ 关账期: SET STATE='C'
      └→ COMMIT提交

阶段4: GUI操作（Playwright + Chrome CDP）
  ├→ 自动检测Chrome调试端口（localhost:9222）
  │   └→ 未检测到 → 代码自动启动独立Chrome实例（--user-data-dir隔离，不影响用户日常Chrome）
  ├→ 自动登录Portal（从env-config.json读取凭据，密码从环境变量获取）
  │   └→ 登录失败 → 代码输出提示，Agent应引导用户检查凭据配置而非要求手动操作
  ├→ 自动选择Job（匹配Organization + Role后双击）
  ├→ 第一轮Data Refresh（INVOICING CENTER）
  │   ├→ 打开菜单 → 搜索"data refresh" → 点击菜单项
  │   ├→ 点击Refresh → 确认对话框 → 等待loading
  │   ├→ 选择最新Version → 点击Immediately Active → 确认×2
  │   └→ 失败时自动重试（最多3次）
  └→ 第二轮Data Refresh（BILLING COMMON DATA）
      ├→ 打开菜单 → 搜索"data refresh" → 点击Common Data Refresh
      ├→ 点击Refresh All → 等待loading
      └→ 失败时自动重试（最多3次）

阶段5: 结果输出
  ├→ 全部成功 → 输出成功报告
  └→ GUI失败（重试3次后） → 自动回滚数据库 → 输出失败报告
```

---

## 失败处理与回滚策略

| 失败阶段 | 处理方式 |
|----------|----------|
| Node.js 版本不满足 | 提示升级到 >= 18，终止执行 |
| npm 依赖未安装 | 自动执行 `npm install`（约 300MB），安装完成后继续 |
| Oracle oci.dll 检测 | 未找到则自动降级为 Thin Mode，零安装、零等待 |
| Chrome 浏览器未安装 | 提示用户安装 Google Chrome，终止执行。Agent不得要求用户手动启动Chrome调试模式 |
| 参数验证失败 | 提示用户补充/修正参数，不执行任何操作 |
| 配置文件错误 | 提示检查 config/env-config.json |
| 数据库连接失败 | 提示检查网络、Oracle Instant Client、密码。Agent不得自行执行SQL |
| 账期不存在 | 提示用户重新输入账期ID |
| GUI单步失败 | 自动重试当前步骤（最多3次） |
| GUI超过3次重试 | **自动回滚数据库**（恢复为操作前的状态），保存截图 |
| GUI未预期崩溃 | **自动回滚数据库**，输出异常详情 |

---

## 环境变量说明

本Skill需要以下环境变量（在项目根目录的 `.env` 文件中配置）：

| 环境变量名 | 对应环境 | 说明 |
|------------|----------|------|
| `ORACLE_PASSWORD_UAT` | UAT | UAT环境Oracle cpc用户的密码 |
| `ORACLE_PASSWORD_TB` | TB | TB环境Oracle cpc用户的密码 |
| `ORACLE_PASSWORD_XLS_REGRESSION` | XLS_REGRESSION | XLS_REGRESSION环境Oracle cpc用户的密码 |
| `ORACLE_PASSWORD_XLS_DRYRUN` | XLS_DRYRUN | XLS_DRYRUN环境Oracle cpc用户的密码 |

**如何设置环境变量：**

```bash
# 方法1：在 .env 文件中设置（推荐）
# 复制 .env.example 为 .env，然后编辑
cp .env.example .env

# 方法2：在命令行临时设置（仅当前终端有效）
# Windows PowerShell:
$env:ORACLE_PASSWORD_UAT="你的密码"

# Windows CMD:
set ORACLE_PASSWORD_UAT=你的密码

# Mac/Linux:
export ORACLE_PASSWORD_UAT=你的密码
```

---

## 配置文件说明

### config/env-config.json

这个文件定义了每个环境的数据库连接信息和Portal地址。

```jsonc
{
  "environments": {
    "UAT": {
      "oracle": {
        "host": "数据库服务器IP地址",
        "port": 11521,
        "service": "Oracle服务名(SERVICE_NAME)",
        "user": "数据库用户名",
        "passwordEnvVar": "ORACLE_PASSWORD_UAT"  // ← 密码从这里指定的环境变量读取
      },
      "portal": {
        "url": "Portal网页地址",
        "loginRequired": true,              // 所有环境均需登录
        "cookieDomain": "Cookie所属域名",      // 用于判断是否已登录
        "credentials": {
          "username": "用户名",
          "passwordEnvVar": "环境变量名",
          "organization": "Job选择中的Organization",
          "job": "Job选择中的Job"
      }
    }
    // ... 其他环境配置
  }
}
```

**修改方法：** 用文本编辑器（记事本/VSCode）打开文件，将 `<>` 包裹的占位符替换为实际值。

---

## 使用场景示例

### 场景1：日常开账期

```
用户: 开UAT的账期202501
Skill:
  1. 解析参数: env=UAT, id=202501, action=开
  2. 连接UAT数据库，查询账期202501是否存在
  3. 执行 UPDATE SET STATE='A'
  4. 通过Chrome操作Portal，执行两轮Data Refresh
  5. 输出: ✅ 账期已成功打开！
```

### 场景2：关账期

```
用户: 关掉XLS_DRYRUN环境的账期789
Skill:
  1. 解析参数: env=XLS_DRYRUN, id=789, action=关
  2. 执行 UPDATE SET STATE='C' 和 COMMIT
  3. GUI操作Portal
  4. 输出结果
```

### 场景3：参数不全

```
用户: 帮我开账期
Skill: 请问要操作哪个环境？（可选: UAT, TB, XLS_REGRESSION, XLS_DRYRUN）

用户: UAT
Skill: 请提供账期ID（纯数字）

用户: 202501
Skill: 开始执行: UAT环境，账期202501，开账期...
```

### 场景4：GUI失败自动回滚

```
用户: 关TB的账期555
Skill:
  1. ✅ 数据库更新成功 (STATE='C')
  2. ❌ GUI操作失败（第7步"选择最新版本"超时，重试3次后仍失败）
  3. 🔄 自动回滚数据库: 将账期555恢复为 STATE='A'
  4. 输出失败报告 + 截图路径
```

---

## 依赖安装指南（首次使用必读）

**核心原则：最大化复用用户电脑上已有的软件，避免重复安装。**

### 依赖总览

| 依赖 | 是否必须安装 | 策略 | 新增空间 |
|------|-------------|------|----------|
| Node.js | 检测后按需 | 大多数电脑已有，`node --version` 验证即可 | 0（已有）|
| npm 项目依赖 | **必须安装** | `npm install`，项目库必须本地化 | ~300MB |
| Oracle Instant Client | **无需安装** | 优先复用已有 `oci.dll`，否则用 Thin Mode | 0 |
| Playwright 浏览器 | **无需安装** | 使用 CDP 连接用户已有 Chrome，不下载 Chromium | 0 |
| Google Chrome | 检测后按需 | 大多数电脑已有，检测 `chrome.exe` 即可 | 0（已有）|
| **合计新增空间** | | | **~300MB** |

对比原方案需 1.5GB，新方案仅需 300MB，节省 1.2GB。

---

### 第1步：确认 Node.js（>= 18）

大多数从事技术工作的用户电脑上已安装。验证即可：
```bash
node --version
```
输出 `v18.x.x` 或更高 = 通过。否则从 https://nodejs.org 下载 LTS 版安装。

---

### 第2步：安装 npm 项目依赖（唯一需要下载的步骤）

```bash
cd D:\billing-cycle-manager
npm install
```

下载约 80MB，解压后约 300MB。这是整个安装流程中唯一必须下载的一步。

> 6 个包说明：`oracledb`（Oracle连接）、`playwright`（CDP操控Chrome）、`dotenv`（读.env密码）、`typescript` + `ts-node` + `@types/node`（编译运行）。

---

### 第3步：确认 Oracle 连接能力（二选一，无需下载）

**方案A — 复用已有 Oracle Instant Client（优先）：**
```bash
where oci.dll
```
如果输出路径，说明电脑上已有 Oracle Instant Client，直接复用。完成。

**方案B — Thin Mode（oci.dll 不存在时自动启用）：**
`oracledb` 6.1+ 内置纯 JavaScript 模式，无需任何 Oracle 本地库。代码自动检测并降级，用户无需任何操作。

> 两种方案均零下载、零空间占用。

---

### 第4步：确认 Google Chrome

```bash
where chrome.exe
```
输出路径 = 已有，复用。否则从 https://www.google.com/chrome/ 安装。

---

### 第5步：编译 TypeScript

```bash
npm run build
```
5-15 秒完成，纯本地操作。

---

### 安装完成检查清单

```bash
node --version          # >= v18.x.x
npm --version           # 版本号
ls node_modules         # 存在 oracledb, playwright, dotenv 等
npm run build           # TypeScript 编译成功
```

全部通过即可使用。

---

## 备用方案：内网离线安装

如果电脑无法连接外网，可在一台有网络的电脑上下载依赖，U盘拷贝安装：

```bash
# 有网电脑上：下载并打包
npm install
npm pack

# 目标电脑上：解压并安装
npm install ./billing-cycle-manager-1.0.0.tgz
```

---

## SLAs & 预期

- 正常执行时间：2-5分钟（数据库操作几秒 + GUI操作1-3分钟）
- GUI单步超时：30秒（loading等待60秒）
- 最大重试次数：每步3次
- 回滚保证：GUI失败自动回滚数据库，保证数据一致性

---

## 注意事项

1. **密码安全**：密码必须通过环境变量传入，不能硬编码在代码或配置文件中
2. **Chrome自动管理**：代码自动启动独立Chrome实例（使用独立user-data-dir），无需用户手动启动调试模式；流程结束后自动关闭该实例，不影响用户日常Chrome
3. **Portal自动登录**：代码自动填写登录表单并登录，如登录失败应检查env-config.json中的credentials配置和.env中的密码
4. **选择器适配**：`browser.ts` 中的CSS选择器是通用写法，如果Portal页面改版，可能需要更新选择器
5. **网络要求**：需要能同时连通Oracle数据库服务器和Portal网站
6. **回滚保证**：如果数据库更新成功但GUI操作失败，会自动回滚数据库
7. **Schema隔离**：代码已强制设置 `CURRENT_SCHEMA = CPC` 并在SQL中使用 `CPC.` 前缀，确保不会误操作其他Schema
