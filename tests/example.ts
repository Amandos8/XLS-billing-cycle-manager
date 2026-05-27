/**
 * =============================================================================
 * tests/example.ts — 使用示例和手动测试脚本
 * =============================================================================
 *
 * 【这个文件是干什么的？】
 * 这是一个独立的测试示例，演示如何通过代码调用"账期开关助手"的各项功能。
 * 如果你不想通过命令行使用，也可以在代码中直接调用这些函数。
 *
 * 【运行方式】
 *   npm run test
 *   或者
 *   ts-node tests/example.ts
 *
 * 【注意】
 * 运行前请确保：
 * 1. .env 文件中已配置好密码
 * 2. config/env-config.json 中已配置好环境信息
 * 3. Oracle Instant Client 已安装
 * 4. Chrome 已以调试模式打开并登录了目标Portal
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { runBillingCycleWorkflow } from '../src/orchestrator';
import { queryBillingCycle, createPool, closePool } from '../src/database';
import { loadConfig, validateInput, logger } from '../src/utils';
import { UserInput } from '../src/types';

// =============================================================================
// 示例1：最简单的使用方式 —— 直接调用主工作流
// =============================================================================
async function example1_directCall(): Promise<void> {
  logger.divider();
  logger.info('【示例1】直接调用主工作流函数');
  logger.divider();

  // 构造用户输入参数
  const userInput: UserInput = {
    env: 'UAT',            // ← 改为你要操作的环境
    billingCycleId: '123', // ← 改为你要操作的账期ID
    action: '开',          // ← "开"或"关"
  };

  // 调用主工作流 —— 一键完成所有操作
  const result = await runBillingCycleWorkflow(userInput);

  // 输出结果
  if (result.success) {
    logger.success(`操作成功: ${result.message}`);
  } else {
    logger.error(`操作失败: ${result.message}`);
  }
}

// =============================================================================
// 示例2：分步操作 —— 先只操作数据库，再手动确认后操作GUI
// =============================================================================
async function example2_stepByStep(): Promise<void> {
  logger.divider();
  logger.info('【示例2】分步操作：先查数据库，确认后再执行GUI');
  logger.divider();

  // ----- 第1步：读取配置文件 -----
  const configPath = path.resolve(__dirname, '..', 'config', 'env-config.json');
  const config = loadConfig(configPath);
  const envConfig = config.environments['UAT']; // ← 改为你要操作的环境

  // ----- 第2步：连接数据库 -----
  await createPool(envConfig.oracle);

  // ----- 第3步：查询账期（只查不改） -----
  const billingCycleId = '123'; // ← 改为你要查询的账期ID
  const record = await queryBillingCycle(billingCycleId);

  if (!record) {
    logger.error(`账期ID ${billingCycleId} 不存在`);
  } else {
    logger.info(`账期ID: ${record.BILLING_CYCLE_ID}`);
    logger.info(`当前状态: ${record.STATE} (A=激活, C=关闭)`);
    // 这里可以打印更多字段
    logger.info(`完整记录: ${JSON.stringify(record, null, 2)}`);
  }

  // 用完记得关闭连接池
  await closePool();
}

// =============================================================================
// 示例3：参数验证 —— 演示validateInput函数的使用
// =============================================================================
async function example3_validation(): Promise<void> {
  logger.divider();
  logger.info('【示例3】参数验证演示');
  logger.divider();

  // 测试1：参数齐全的正确输入
  const validInput: Partial<UserInput> = {
    env: 'UAT',
    billingCycleId: '123456',
    action: '关',
  };
  const validResult = validateInput(validInput);
  logger.info(`参数齐全的验证结果: ${JSON.stringify(validResult)}`);
  // 期望输出: { valid: true, missing: [], invalid: [] }

  // 测试2：缺少参数
  const missingInput: Partial<UserInput> = {
    env: 'UAT',
    // 缺了 billingCycleId 和 action
  };
  const missingResult = validateInput(missingInput);
  logger.info(`缺少参数的验证结果: ${JSON.stringify(missingResult)}`);
  // 期望输出: { valid: false, missing: ['账期ID(billingCycleId)', '操作类型(action)'], invalid: [] }

  // 测试3：参数值不合法
  const invalidInput: Partial<UserInput> = {
    env: 'NONEXISTENT',  // ← 不存在的环境名
    billingCycleId: 'abc123', // ← 包含非数字字符
    action: '删',        // ← 不是"开"或"关"
  };
  const invalidResult = validateInput(invalidInput as UserInput);
  logger.info(`参数不合法的验证结果: ${JSON.stringify(invalidResult)}`);
  // 期望输出: { valid: false, missing: [], invalid: [3条错误信息] }
}

// =============================================================================
// 示例4：通过命令行运行（模拟）
// =============================================================================
function example4_cliUsage(): void {
  logger.divider();
  logger.info('【示例4】命令行使用方式');
  logger.divider();

  console.log(`
  ╔═══════════════════════════════════════════════════════╗
  ║         账期开关助手 —— 命令行使用示例               ║
  ╚═══════════════════════════════════════════════════════╝

  # 开UAT环境的账期123
  npm run dev -- --env UAT --id 123 --action 开

  # 关TB环境的账期456
  npm run dev -- --env TB --id 456 --action 关

  # 使用短参数名
  npm run dev -- -e UAT -i 789 -a 关

  # 开双A环境0模式的账期
  npm run dev -- --env 双A环境0模式 --id 100 --action 开

  # 查看帮助
  npm run dev -- --help
  `);
}

// =============================================================================
// 主函数 —— 选择运行哪个示例
// =============================================================================
async function main(): Promise<void> {
  console.log('');
  logger.info('========== 账期开关助手 - 使用示例 ==========');
  logger.info('请修改示例代码中的环境名和账期ID后再运行');
  logger.info('');

  // 【重要】在运行示例1之前，请确认以下内容：
  // 1. .env 文件中已配置好密码
  // 2. Chrome 已以调试模式启动: chrome.exe --remote-debugging-port=9222
  // 3. 已在 Chrome 中登录目标 Portal

  // 选择要运行的示例（取消注释相应的行）：

  // await example1_directCall();   // 一键执行完整流程
  // await example2_stepByStep();   // 分步操作（仅查询）
  await example3_validation();      // 参数验证演示（默认运行，安全无副作用）
  example4_cliUsage();              // 显示命令行用法
}

main().catch((err) => {
  logger.error('示例运行出错:', err);
  process.exit(1);
});
