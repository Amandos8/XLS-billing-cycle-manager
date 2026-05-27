/**
 * =============================================================================
 * index.ts — 程序入口文件
 * =============================================================================
 *
 * 【这个文件是干什么的？】
 * 当你运行 `npm start` 或 `npm run dev` 时，Node.js首先执行这个文件。
 * 它负责：
 * 1. 加载 .env 文件中的环境变量（密码等）
 * 2. 解析命令行参数（环境名、账期ID、操作类型）
 * 3. 调用编排器执行完整工作流
 * 4. 输出最终结果给用户
 *
 * 【使用方式】
 *
 * 方式1：通过命令行参数直接运行
 *   npm run dev -- --env UAT --id 123456 --action 开
 *
 * 方式2：交互模式（推荐，参数缺失时会逐项询问）
 *   npm run dev
 *
 * 方式3：编译后运行
 *   npm run build
 *   npm start -- --env UAT --id 123456 --action 开
 */

// 在最开始就加载环境变量（从 .env 文件读取密码等配置）
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { runBillingCycleWorkflow } from './orchestrator';
import { UserInput, EnvName, ActionType } from './types';
import { logger, validateInput } from './utils';

/**
 * 从命令行参数中解析用户输入
 *
 * 支持的命令行参数格式：
 *   --env UAT       环境名称
 *   --id 123456     账期ID
 *   --action 开     操作类型（开/关）
 *
 * 示例完整命令：
 *   ts-node src/index.ts --env UAT --id 123456 --action 开
 */
function parseArgs(): Partial<UserInput> {
  const args = process.argv.slice(2); // 跳过前两个参数(node路径和脚本路径)
  const input: Partial<UserInput> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--env':
      case '-e':
        input.env = next as EnvName;
        i++;
        break;
      case '--id':
      case '-i':
        input.billingCycleId = next;
        i++;
        break;
      case '--action':
      case '-a':
        input.action = next as ActionType;
        i++;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return input;
}

/**
 * 打印帮助信息
 */
function printHelp(): void {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              账期开关助手 (Billing Cycle Manager)            ║
╚══════════════════════════════════════════════════════════════╝

【功能说明】
  自动执行"先操作Oracle数据库，再通过浏览器操作网页"的账期开关工作流。

【使用方式】

  1. 命令行直接运行（所有参数齐全时）：
     npm run dev -- --env <环境名> --id <账期ID> --action <操作类型>

  2. 交互模式运行（参数缺失时会提示补齐）：
     npm run dev

【参数说明】
  --env, -e     环境名称
                可选值: UAT, TB, XLS_REGRESSION, XLS_DRYRUN, 双A环境0模式
                示例: --env UAT

  --id, -i      账期ID
                必须是纯数字
                示例: --id 123456

  --action, -a  操作类型
                开 = 开账期（将账期状态设为 A=Active）
                关 = 关账期（将账期状态设为 C=Closed）
                示例: --action 开

【完整示例】
  npm run dev -- --env UAT --id 202501 --action 开

【准备工作】
  1. 安装依赖：    npm install
  2. 配置环境变量： 复制 .env.example 为 .env，填入各环境的数据库密码
  3. 配置环境信息： 编辑 config/env-config.json，填写各环境的数据库和Portal地址
  4. 启动Chrome：   chrome.exe --remote-debugging-port=9222
  5. 登录Portal：  在Chrome中打开并登录目标环境的Portal页面
  6. 执行命令：    npm run dev -- --env UAT --id 123456 --action 开
`);
}

/**
 * 主函数 —— 程序真正的起点
 */
async function main(): Promise<void> {
  console.log(''); // 空行，让输出更美观

  // 1. 解析命令行参数
  const input = parseArgs();

  // 2. 验证参数
  const validation = validateInput(input);

  // 3. 如果参数有问题，输出错误并退出
  if (!validation.valid) {
    if (validation.missing.length > 0) {
      logger.error(`缺少必要参数: ${validation.missing.join(', ')}`);
      logger.info('请补充以下参数后重新运行：');
      logger.info(`  --env <环境名>    可选: UAT, TB, XLS_REGRESSION, XLS_DRYRUN, 双A环境0模式`);
      logger.info(`  --id <账期ID>     纯数字，如 123456`);
      logger.info(`  --action <操作>   开 或 关`);
      logger.info('');
      logger.info('示例: npm run dev -- --env UAT --id 123456 --action 开');
      logger.info('查看完整帮助: npm run dev -- --help');
    }

    if (validation.invalid.length > 0) {
      logger.error(`参数不合法:\n  ${validation.invalid.join('\n  ')}`);
    }

    process.exit(1); // 以错误码退出
  }

  // 4. 执行工作流（完整的input已确认合法）
  const result = await runBillingCycleWorkflow(input as UserInput);

  // 5. 输出结果
  console.log('');
  if (result.success) {
    logger.success(result.message);
    process.exit(0); // 成功退出
  } else {
    logger.error(result.message);
    process.exit(1); // 失败退出
  }
}

// 启动程序
main().catch((err) => {
  // 捕获所有未被处理的异常
  logger.error('程序发生未预期的错误:', err);
  logger.info('请检查：');
  logger.info('  1. .env 文件是否存在且填写了正确的密码');
  logger.info('  2. config/env-config.json 配置是否正确');
  logger.info('  3. Oracle Instant Client 是否已安装');
  logger.info('  4. Chrome 是否以调试模式启动');
  logger.info('  5. 网络是否能连通数据库和Portal');
  process.exit(1);
});
