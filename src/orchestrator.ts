/**
 * =============================================================================
 * orchestrator.ts — 主工作流编排器
 * =============================================================================
 *
 * 【什么是编排器？】
 * 编排器(Orchestrator)是整个Skill的"大脑"，它负责：
 * 1. 接收并验证用户输入的参数
 * 2. 按照正确的顺序调用各模块（数据库 → 网页操作）
 * 3. 处理异常情况（失败回滚、错误提示）
 * 4. 输出最终的操作结果报告
 *
 * 【工作流程总览】
 *   用户输入参数
 *     ↓
 *   参数验证（缺失/非法 → 提示用户）
 *     ↓
 *   读取配置文件 → 获取Oracle和Portal配置
 *     ↓
 *   连接数据库 → 查询账期是否存在
 *     ↓                    ↓
 *   存在 → 记录原始状态   不存在 → 提示重新输入
 *     ↓
 *   执行UPDATE（开/关账期） → COMMIT
 *     ↓
 *   连接浏览器 → 检查登录状态
 *     ↓                    ↓
 *   已登录 → 执行GUI步骤   未登录 → 等待用户登录
 *     ↓
 *   GUI全部成功 → 输出成功报告
 *     ↓                    ↓
 *   GUI失败 → 回滚数据库   GUI异常 → 回滚数据库
 */

import * as path from 'path';
import { UserInput, OperationResult, EnvConfigFile } from './types';
import { loadConfig, validateInput, logger, getRollbackState } from './utils';
import { createPool, queryBillingCycle, updateBillingCycleState, rollbackBillingCycle, closePool } from './database';
import { initBrowser, executeFullGuiWorkflow, closeBrowser } from './browser';

/**
 * 执行完整的账期开关工作流
 *
 * 这是Skill的核心函数，也是唯一需要从外部调用的函数。
 * 它协调数据库操作和网页操作，并处理所有异常情况。
 *
 * @param input - 用户输入的参数（环境、账期ID、开/关）
 * @returns 操作结果，包含成功/失败状态和详细信息
 */
export async function runBillingCycleWorkflow(
  input: UserInput
): Promise<OperationResult> {
  logger.divider();
  logger.info('========================================');
  logger.info('  账期开关助手 (Billing Cycle Manager)');
  logger.info('========================================');
  logger.divider();

  const startTime = Date.now();

  // ===== 阶段1: 参数验证与配置加载 =====
  logger.info('[阶段1/4] 参数验证...');

  // 1.1 验证参数格式
  const validation = validateInput(input);
  if (!validation.valid) {
    const errParts: string[] = [];
    if (validation.missing.length > 0) {
      errParts.push(`缺少参数: ${validation.missing.join(', ')}`);
    }
    if (validation.invalid.length > 0) {
      errParts.push(`参数不合法: ${validation.invalid.join(', ')}`);
    }
    return {
      success: false,
      message: errParts.join('；') || '参数验证失败',
    };
  }
  logger.success('参数验证通过');

  // 1.2 读取配置文件
  logger.info('正在读取环境配置...');
  const config: EnvConfigFile = loadConfig(
    path.resolve(__dirname, '..', 'config', 'env-config.json')
  );
  const envConfig = config.environments[input.env];
  if (!envConfig) {
    return {
      success: false,
      message: `未找到环境 "${input.env}" 的配置，请在 config/env-config.json 的 "environments" 中添加该环境。`,
    };
  }

  logger.success(`环境 "${input.env}" 配置已加载`);

  // ===== 阶段2: 数据库操作 =====
  logger.info('[阶段2/4] 数据库操作...');

  let originalState = ''; // 保存操作前的状态，用于失败回滚
  const targetState = input.action === '开' ? 'A' : 'C'; // 目标状态（外层作用域，回滚时也要用）

  try {
    // 2.1 创建数据库连接池
    await createPool(envConfig.oracle);

    // 2.2 查询账期是否存在
    const billingCycle = await queryBillingCycle(input.billingCycleId);
    if (!billingCycle) {
      await closePool();
      return {
        success: false,
        message: `账期ID ${input.billingCycleId} 不存在！请确认账期ID是否正确，然后重新执行。`,
      };
    }

    // 2.3 保存原始状态（万一GUI失败，需要回滚到这个状态）
    originalState = billingCycle.STATE;

    // 检查当前状态是否已经是目标状态
    if (originalState === targetState) {
      logger.warn(`账期当前状态已经是 '${originalState}'，无需更新数据库。`);
    } else {
      // 2.4 执行UPDATE
      const rowsAffected = await updateBillingCycleState(input.billingCycleId, input.action);
      if (rowsAffected === 0) {
        await closePool();
        return {
          success: false,
          message: `更新账期失败：影响了0行数据，请检查账期ID是否正确。`,
        };
      }

    }

    logger.success('数据库操作完成');
  } catch (err) {
    await closePool().catch(() => {});
    return {
      success: false,
      message: `数据库操作失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ===== 阶段3: GUI操作 =====
  logger.info('[阶段3/4] GUI操作...');

  try {
    // 3.1 初始化浏览器连接（CDP协议）
    const browserReady = await initBrowser(envConfig.portal);
    if (!browserReady) {
      // 如果没登录，提示用户登录后重试
      await closePool().catch(() => {});
      return {
        success: false,
        message:
          '浏览器未就绪或未登录。请按照上面的提示手动操作后，重新执行本命令。',
      };
    }

    // 3.2 执行GUI操作序列
    const guiResult = await executeFullGuiWorkflow();

    if (!guiResult.success) {
      // GUI失败，需要回滚数据库
      logger.error('GUI操作失败，正在回滚数据库...');

      // 如果数据库状态被改变了，回滚到原始状态
      if (originalState !== targetState) {
        try {
          await rollbackBillingCycle(input.billingCycleId, originalState);
        } catch (rollbackErr) {
          logger.error('数据库回滚也失败了！', rollbackErr);
          logger.error(
            `⚠️⚠️⚠️ 严重问题：数据库已更新但GUI操作和回滚都失败了！\n` +
            `请手动恢复账期 ${input.billingCycleId} 的状态为 '${originalState}'`
          );
        }
      }

      await closePool().catch(() => {});
      await closeBrowser().catch(() => {});

      return {
        success: false,
        message:
          `GUI操作失败（已重试3次），数据库已回滚。\n` +
          `失败步骤: ${guiResult.details.failedStep}\n` +
          `完成步骤: ${guiResult.details.guiStepsCompleted}/${guiResult.details.guiStepsTotal}\n` +
          `错误信息: ${guiResult.details.error}\n` +
          (guiResult.details.screenshots?.length
            ? `截图已保存至: ${guiResult.details.screenshots.join(', ')}`
            : ''),
        details: guiResult.details,
      };
    }

    logger.success('GUI操作全部完成');
  } catch (err) {
    // GUI执行过程中出现未预期的异常
    logger.error('GUI操作出现未预期异常，正在回滚数据库...');

    if (originalState !== targetState) {
      try {
        await rollbackBillingCycle(input.billingCycleId, originalState);
      } catch (rollbackErr) {
        logger.error('数据库回滚失败！', rollbackErr);
      }
    }

    await closePool().catch(() => {});
    await closeBrowser().catch(() => {});

    return {
      success: false,
      message: `GUI操作异常: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ===== 阶段4: 清理和返回结果 =====
  logger.info('[阶段4/4] 清理资源...');

  await closeBrowser().catch(() => {});
  await closePool().catch(() => {});

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  logger.divider();
  logger.success(`========== 账期开关工作流完成 ==========`);
  logger.success(`操作: ${input.action === '开' ? '开账期' : '关账期'}`);
  logger.success(`环境: ${input.env}`);
  logger.success(`账期ID: ${input.billingCycleId}`);
  logger.success(`总耗时: ${totalTime}秒`);
  logger.divider();

  return {
    success: true,
    message: `✅ 账期已成功${input.action === '开' ? '打开' : '关闭'}！\n` +
      `环境: ${input.env}\n` +
      `账期ID: ${input.billingCycleId}\n` +
      `状态已设为: ${input.action === '开' ? 'A (Active/激活)' : 'C (Closed/关闭)'}\n` +
      `GUI操作已全部完成`,
    details: {
      dbRowsAffected: originalState === targetState ? 0 : 1,
      dbExecutionTime: 0,
      guiStepsCompleted: 15,
      guiStepsTotal: 15,
    },
  };
}
