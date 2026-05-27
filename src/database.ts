/**
 * =============================================================================
 * database.ts — Oracle数据库操作模块
 * =============================================================================
 *
 * 【模块职责】
 * 1. 根据环境配置创建Oracle数据库连接池
 * 2. 查询账期是否存在（SELECT）
 * 3. 更新账期状态（UPDATE + COMMIT）
 * 4. 操作失败时回滚（UPDATE回原状态 + COMMIT）
 *
 * 【安全设计】
 * - 密码从环境变量读取，不硬编码
 * - 所有SQL使用绑定变量（:billingCycleId），防止SQL注入
 * - 连接池自动管理连接生命周期
 *
 * 【依赖】
 * - oracledb npm包：Node.js的Oracle数据库驱动
 * - Oracle Instant Client：Oracle提供的本地库（需单独安装，见README）
 */

import * as oracledb from 'oracledb';
import { OracleConfig, BillingCycle, ActionType } from './types';
import { logger, getPasswordFromEnv, getRollbackState } from './utils';

/** 全局数据库连接池（整个应用生命周期内复用） */
let pool: oracledb.Pool | null = null;

/**
 * 创建数据库连接池
 *
 * 【什么是连接池？】
 * 连接池预先创建几个数据库连接并保持打开状态，
 * 当需要访问数据库时直接从池中借用一个连接，用完后归还，
 * 避免了反复"连接-断开"的性能开销。
 *
 * @param config - Oracle连接配置（来自 env-config.json）
 *
 * 使用示例：
 *   await createPool(uatEnvConfig.oracle);
 */
export async function createPool(config: OracleConfig): Promise<void> {
  // 如果已经有连接池了，先关闭旧的
  if (pool) {
    await closePool();
  }

  // 从环境变量获取密码（不能硬编码密码！）
  const password = getPasswordFromEnv(config.passwordEnvVar);

  logger.info(`正在连接Oracle数据库: ${config.host}:${config.port}/${config.service}`);

  try {
    pool = await oracledb.createPool({
      user: config.user,
      password: password,
      connectString: `${config.host}:${config.port}/${config.service}`,
      poolMin: 1,
      poolMax: 4,
      poolIncrement: 1,
    });

    // 强制设置当前Schema为CPC，避免其他平台环境变量覆盖默认Schema
    const initConn = await pool.getConnection();
    try {
      await initConn.execute('ALTER SESSION SET CURRENT_SCHEMA = CPC');
    } finally {
      await initConn.close();
    }

    logger.success(`Oracle数据库连接池创建成功 (Schema: CPC)`);
  } catch (err) {
    logger.error('Oracle数据库连接失败，请检查：', err);
    logger.info('  1. Oracle Instant Client是否正确安装');
    logger.info('  2. 数据库地址和端口是否正确');
    logger.info('  3. 环境变量中的密码是否正确');
    logger.info('  4. 网络是否能连通数据库服务器');
    throw err;
  }
}

/**
 * 执行单条SQL语句（带绑定变量）
 *
 * 【什么是绑定变量？】
 * 使用 :变量名 作为占位符，实际值通过 bindParams 传入。
 * 这种方式可以：
 *   1. 防止SQL注入攻击
 *   2. 提高SQL执行效率（Oracle可以缓存执行计划）
 *
 * @param sql - SQL语句，使用 :参数名 作为占位符
 * @param bindParams - 绑定变量的值，键名对应SQL中的 :参数名
 * @param autoCommit - 是否自动提交事务（默认false，需要手动COMMIT）
 * @returns 执行结果对象，包含 rowsAffected（影响行数）等信息
 */
async function execute(
  sql: string,
  bindParams: Record<string, any> = {},
  autoCommit: boolean = false
): Promise<oracledb.Result<any>> {
  if (!pool) {
    throw new Error('数据库连接池未初始化，请先调用 createPool()');
  }

  // 从连接池获取一个连接
  const connection = await pool.getConnection();
  try {
    // 执行SQL
    const result = await connection.execute(sql, bindParams, {
      autoCommit: autoCommit,
      outFormat: oracledb.OUT_FORMAT_OBJECT, // 结果以JS对象形式返回（而非数组）
    });
    return result;
  } finally {
    // 无论如何都要归还连接到池中（即使执行出错）
    await connection.close();
  }
}

/**
 * 查询账期记录是否存在
 *
 * 执行SQL: SELECT * FROM CBEC_BILLING_CYCLE WHERE BILLING_CYCLE_ID = :id
 *
 * @param billingCycleId - 账期ID
 * @returns 账期记录对象，如果不存在返回 null
 */
export async function queryBillingCycle(billingCycleId: string): Promise<BillingCycle | null> {
  logger.info(`正在查询账期: BILLING_CYCLE_ID = ${billingCycleId}`);

  const sql = `SELECT * FROM CPC.CBEC_BILLING_CYCLE WHERE BILLING_CYCLE_ID = :billingCycleId`;
  const result = await execute(sql, { billingCycleId });

  // result.rows 是查询返回的行数组，如果长度为0说明没有这个账期
  if (!result.rows || result.rows.length === 0) {
    logger.warn(`账期ID ${billingCycleId} 不存在`);
    return null;
  }

  logger.success(`账期查询成功，当前状态: STATE='${(result.rows[0] as BillingCycle).STATE}'`);
  return result.rows[0] as BillingCycle;
}

/**
 * 更新账期状态（开账期或关账期）
 *
 * 开账期: UPDATE ... SET STATE='A' （Active = 激活状态）
 * 关账期: UPDATE ... SET STATE='C' （Closed = 关闭状态）
 *
 * @param billingCycleId - 账期ID
 * @param action - 操作类型：'开'=设为A, '关'=设为C
 * @returns 影响的行数
 */
export async function updateBillingCycleState(
  billingCycleId: string,
  action: ActionType
): Promise<number> {
  const newState = action === '开' ? 'A' : 'C';
  const actionName = action === '开' ? '开账期' : '关账期';

  logger.info(`正在执行${actionName}: BILLING_CYCLE_ID = ${billingCycleId}, 目标状态 = '${newState}'`);

  const startTime = Date.now();

  // 执行UPDATE —— autoCommit: true 确保立即生效（与查询使用同一连接,避免事务丢失）
  const sql = `UPDATE CPC.CBEC_BILLING_CYCLE SET STATE = :newState WHERE BILLING_CYCLE_ID = :billingCycleId`;
  const result = await execute(sql, { newState, billingCycleId }, true);

  const elapsed = Date.now() - startTime;
  const rowsAffected = result.rowsAffected || 0;

  logger.success(`数据库UPDATE完成: 影响 ${rowsAffected} 行, 耗时 ${elapsed}ms`);

  return rowsAffected;
}

/**
 * 提交事务（COMMIT）
 *
 * 【什么是COMMIT？】
 * 数据库操作（INSERT/UPDATE/DELETE）执行后不会立即生效，
 * 需要执行COMMIT来"确认"这些修改。在COMMIT之前，
 * 其他用户看不到这些修改，而且可以ROLLBACK撤销。
 */
export async function commitTransaction(): Promise<void> {
  logger.info('正在提交数据库事务(COMMIT)...');
  await execute('COMMIT', {}, true);
  logger.success('数据库事务已提交');
}

/**
 * 回滚数据库操作
 *
 * 当GUI操作连续失败需要恢复数据库时调用此函数。
 * 将账期状态恢复为操作前的原始值。
 *
 * @param billingCycleId - 账期ID
 * @param originalState - 操作前的原始状态值
 */
export async function rollbackBillingCycle(
  billingCycleId: string,
  originalState: string
): Promise<void> {
  logger.warn(`⚠️  正在回滚数据库: 将账期 ${billingCycleId} 恢复为 STATE='${originalState}'`);

  // autoCommit: true 确保回滚立即生效
  const sql = `UPDATE CPC.CBEC_BILLING_CYCLE SET STATE = :state WHERE BILLING_CYCLE_ID = :id`;
  await execute(sql, { state: originalState, id: billingCycleId }, true);

  logger.success('数据库回滚完成');
}

/**
 * 关闭数据库连接池
 *
 * 在程序退出前调用，释放所有数据库连接。
 * 建议在程序结束时调用（正常退出或异常退出）。
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
    logger.info('数据库连接池已关闭');
  }
}
