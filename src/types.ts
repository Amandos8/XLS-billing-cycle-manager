/**
 * =============================================================================
 * types.ts — 项目中所有类型定义
 * =============================================================================
 * 这个文件定义了整个项目中使用的数据结构"形状"。
 * 如果你不熟悉TypeScript，可以把 interface 理解为"一坨数据的模板"——
 * 它规定了某个对象必须包含哪些字段，每个字段是什么类型。
 */

/* ===== 数据库相关类型 ===== */

/** Oracle数据库的连接配置 */
export interface OracleConfig {
  host: string;           // 数据库服务器的IP地址，如 "10.16.180.39"
  port: number;           // 数据库端口号，通常是 1521 或 11521
  service: string;        // Oracle服务名（SERVICE_NAME），如 "cc01_uat"
  user: string;           // 数据库用户名，如 "cpc"
  passwordEnvVar: string; // 【重要】密码不从配置文件读取，而是从这里指定的环境变量名去获取
                          // 例如 "ORACLE_PASSWORD_UAT" 表示密码存在环境变量 ORACLE_PASSWORD_UAT 中
}

/* ===== 网页端相关类型 ===== */

/** Portal网页端的配置 */
export interface PortalConfig {
  url: string;            // Portal网页地址（登录入口）
  loginRequired: boolean; // 是否需要先登录才能操作（true=需要登录, false=已配置SSO免登）
  cookieDomain: string;   // Cookie所属域名，用于判断浏览器是否已登录该环境
  credentials?: PortalCredentials; // 登录凭据（loginRequired=true 时必须配置）
}

/** Portal 登录凭据 */
export interface PortalCredentials {
  username: string;         // 登录用户名
  passwordEnvVar: string;   // 密码对应的环境变量名
  organization: string;     // Job选择表格中的 Organization 列值
  job: string;              // Job选择表格中的 Job 列值
}

/* ===== 环境配置 ===== */

/** 单个环境的完整配置（数据库 + 网页端） */
export interface EnvironmentConfig {
  oracle: OracleConfig;
  portal: PortalConfig;
}

/** 整个配置文件 env-config.json 的顶层结构 */
export interface EnvConfigFile {
  environments: Record<string, EnvironmentConfig>;
  // Record<string, EnvironmentConfig> 的意思是：
  // "一个键值对集合，键是环境名称（字符串），值是该环境的配置"
  // 例如 { "UAT": {...}, "TB": {...} }
}

/* ===== 用户输入相关类型 ===== */

/** 用户调用Skill时需要提供的操作类型 */
export type ActionType = '开' | '关';
// "开" = 开账期（将状态设为 'A' = Active）
// "关" = 关账期（将状态设为 'C' = Closed）

/** 合法的环境名称列表 */
export type EnvName = 'UAT' | 'TB' | 'XLS_REGRESSION' | 'XLS_DRYRUN';

/** 用户输入的完整参数集合 */
export interface UserInput {
  env: EnvName;              // 环境名称
  billingCycleId: string;    // 账期ID（数字，但用string存储以避免大数精度问题）
  action: ActionType;        // 操作类型：开或关
}

/* ===== 数据库记录类型 ===== */

/** CBEC_BILLING_CYCLE 表中的一条账期记录 */
export interface BillingCycle {
  BILLING_CYCLE_ID: string;  // 账期ID（主键）
  STATE: string;             // 账期状态：'A'=打开(Active), 'C'=关闭(Closed)
  // 注意：表中可能还有其他字段（如创建时间、描述等），
  // 但我们在查询时使用 SELECT * 可以获取全部字段
  [key: string]: any;        // 允许访问任意额外字段
}

/* ===== 操作结果类型 ===== */

/** 每一步执行后的结果 */
export interface StepResult {
  success: boolean;          // 当前步骤是否成功
  stepName: string;          // 步骤名称（用于日志输出）
  error?: string;            // 如果失败，这里是失败原因
  screenshot?: string;       // 如果失败，这里是截图文件路径
}

/** 整个工作流的最终执行结果 */
export interface OperationResult {
  success: boolean;          // 整体操作是否成功
  message: string;           // 结果描述信息
  details?: {
    dbRowsAffected?: number;   // 数据库影响的行数
    dbExecutionTime?: number;  // 数据库执行耗时（毫秒）
    guiStepsCompleted?: number; // GUI操作完成的步骤数
    guiStepsTotal?: number;    // GUI操作总步骤数
    screenshots?: string[];    // 失败时保存的截图路径列表
  };
}

/* ===== GUI步骤定义类型 ===== */

/** 单个GUI操作步骤的定义 */
export interface GuiStep {
  name: string;              // 步骤名称（用于日志和错误报告）
  action: 'click' | 'type' | 'wait' | 'waitForHidden' | 'clickForce' | 'clickRowByMaxId';
  // click: 点击一个页面元素
  // type: 在输入框中输入文本
  // wait: 等待某个条件
  // waitForHidden: 等待某个元素从页面消失
  // clickForce: 强制点击隐藏元素(jqGrid虚拟渲染等场景)
  // clickRowByMaxId: 在jqGrid表格中找到row id最大的行，点击其gridcell选中

  selector?: string;         // CSS选择器，用于定位页面元素
  tableSelector?: string;    // jqGrid表格选择器（clickRowByMaxId专用）
  value?: string;            // 如果是 type 操作，这里是要输入的文字
  timeout?: number;          // 超时时间（毫秒），默认30000（30秒）
  description: string;       // 步骤的中文描述
}
