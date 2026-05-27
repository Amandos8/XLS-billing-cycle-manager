/**
 * =============================================================================
 * utils.ts — 工具函数集合
 * =============================================================================
 * 这里包含日志输出、参数校验、配置读取等辅助功能。
 */

import * as fs from 'fs';
import * as path from 'path';
import { EnvConfigFile, UserInput, EnvName, ActionType } from './types';

/** 合法的环境名称列表 */
const VALID_ENVS: EnvName[] = ['UAT', 'TB', 'XLS_REGRESSION', 'XLS_DRYRUN'];

/** 合法的操作类型列表 */
const VALID_ACTIONS: ActionType[] = ['开', '关'];

/**
 * 日志输出工具
 * 统一管理所有的控制台输出，包含时间戳和日志级别。
 *
 * 使用方法：
 *   logger.info('数据库连接成功');
 *   logger.error('操作失败', error对象);
 */
export const logger = {
  /** 普通信息日志 */
  info(msg: string): void {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`[${time}] ℹ️  ${msg}`);
  },

  /** 成功日志（绿色不是所有终端都支持，使用✅标记） */
  success(msg: string): void {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`[${time}] ✅ ${msg}`);
  },

  /** 警告日志 */
  warn(msg: string): void {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.warn(`[${time}] ⚠️  ${msg}`);
  },

  /** 错误日志 */
  error(msg: string, err?: unknown): void {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.error(`[${time}] ❌ ${msg}`);
    if (err instanceof Error) {
      console.error(`        原因: ${err.message}`);
    } else if (err !== undefined) {
      console.error(`        详情: ${String(err)}`);
    }
  },

  /** 分隔线，用于区分不同阶段的输出 */
  divider(): void {
    console.log('─'.repeat(60));
  },
};

/**
 * 读取并解析配置文件
 *
 * @param configPath - env-config.json 的文件路径
 * @returns 解析后的配置对象
 *
 * 配置文件位置：项目根目录下的 config/env-config.json
 * 如果文件不存在或JSON格式错误，会抛出明确的错误提示。
 */
export function loadConfig(configPath: string): EnvConfigFile {
  // 第一步：检查文件是否存在
  if (!fs.existsSync(configPath)) {
    throw new Error(`配置文件不存在: ${configPath}\n请确认 config/env-config.json 文件已创建。`);
  }

  // 第二步：读取文件内容（UTF-8编码的文本）
  const raw = fs.readFileSync(configPath, 'utf-8');

  // 第三步：解析JSON
  try {
    const config: EnvConfigFile = JSON.parse(raw);

    // 第四步：验证配置结构是否完整
    if (!config.environments || typeof config.environments !== 'object') {
      throw new Error('配置文件中缺少 "environments" 字段或格式不正确。');
    }

    return config;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`配置文件JSON格式错误: ${err.message}\n请检查 config/env-config.json 语法。`);
    }
    throw err;
  }
}

/**
 * 验证用户输入参数是否完整且合法
 *
 * @param input - 用户提供的参数对象
 * @returns 一个包含验证结果的对象
 *   - valid: true表示通过, false表示有问题
 *   - missing: 缺失的参数名列表
 *   - invalid: 值不合法的参数名列表
 */
export function validateInput(input: Partial<UserInput>): {
  valid: boolean;
  missing: string[];
  invalid: string[];
} {
  const missing: string[] = [];
  const invalid: string[] = [];

  // 检查每个必填参数

  // 1. 环境名称
  if (!input.env) {
    missing.push('环境名称(env)');
  } else if (!VALID_ENVS.includes(input.env as EnvName)) {
    invalid.push(`环境名称(env): "${input.env}" 不合法，可选值: ${VALID_ENVS.join(', ')}`);
  }

  // 2. 账期ID
  if (!input.billingCycleId) {
    missing.push('账期ID(billingCycleId)');
  } else if (!/^\d+$/.test(input.billingCycleId)) {
    // 账期ID必须是纯数字
    invalid.push(`账期ID(billingCycleId): "${input.billingCycleId}" 必须是纯数字`);
  }

  // 3. 操作类型
  if (!input.action) {
    missing.push('操作类型(action)');
  } else if (!VALID_ACTIONS.includes(input.action as ActionType)) {
    invalid.push(`操作类型(action): "${input.action}" 不合法，可选值: ${VALID_ACTIONS.join(', ')}`);
  }

  return {
    valid: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
  };
}

/**
 * 从环境变量中获取数据库密码
 *
 * 【安全说明】
 * 密码不能硬编码在代码或配置文件中，必须通过操作系统的环境变量传入。
 *
 * 设置环境变量的方法：
 *   Windows (CMD):   set ORACLE_PASSWORD_UAT=你的密码
 *   Windows (PowerShell): $env:ORACLE_PASSWORD_UAT="你的密码"
 *   Mac/Linux:       export ORACLE_PASSWORD_UAT=你的密码
 *
 * 或者：在项目根目录创建 .env 文件（参考 .env.example），程序会自动读取。
 *
 * @param envVarName - 环境变量的名称，来自配置文件的 passwordEnvVar 字段
 * @returns 密码字符串
 */
export function getPasswordFromEnv(envVarName: string): string {
  const password = process.env[envVarName];
  if (!password || password === '' || password.startsWith('请替换')) {
    throw new Error(
      `未找到数据库密码！\n` +
      `请在环境变量中设置 ${envVarName}。\n` +
      `方法1: 在命令行执行 export ${envVarName}=你的密码 (Mac/Linux)\n` +
      `       或在命令行执行 set ${envVarName}=你的密码 (Windows CMD)\n` +
      `方法2: 在项目根目录的 .env 文件中添加一行: ${envVarName}=你的密码`
    );
  }
  return password;
}

/**
 * 获取数据库操作前的原始状态，用于失败回滚
 *
 * @param action - 操作类型
 * @returns 对应的回滚状态值
 *
 * 开账期(SET STATE='A')的回滚是关账期(SET STATE='C')，反之亦然。
 */
export function getRollbackState(action: ActionType): string {
  return action === '开' ? 'C' : 'A';
}

/**
 * 等待指定毫秒数（异步延迟函数）
 *
 * @param ms - 等待的毫秒数
 *
 * 使用场景：某些页面操作之间需要短暂等待，让动画完成或元素渲染。
 * 使用示例：await sleep(1000); // 等待1秒
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 确保截图目录存在
 *
 * @param dir - 目录路径
 *
 * 截图在GUI操作失败时自动保存，用于问题排查。
 */
export function ensureScreenshotDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
