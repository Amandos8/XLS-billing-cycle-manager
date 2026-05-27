/**
 * =============================================================================
 * browser.ts — Playwright浏览器自动化模块
 * =============================================================================
 *
 * 【模块职责】
 * 1. 自动拉起Chrome调试模式（无需用户手动操作）
 * 2. 自动填写登录表单并登录Portal
 * 3. 自动完成Job选择弹窗
 * 4. 自动执行账期刷新及激活的全部GUI操作步骤
 * 5. 截图记录（用于失败排查）
 * 6. 支持失败后从失败步骤重试（最多3次）
 *
 * 【Chrome调试模式】
 * 程序会自动启动一个独立的Chrome实例（使用独立用户目录），
 * 不影响你日常使用的Chrome窗口。
 * 首次启动时会打开Portal登录页，自动填入账号密码并登录。
 */

import { chromium, Page } from 'playwright';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { PortalConfig, GuiStep, StepResult, PortalCredentials } from './types';
import { logger, sleep, ensureScreenshotDir } from './utils';

/** CDP调试端口 */
const CDP_PORT = 9222;

/** Chrome用户数据目录（独立，不影响日常Chrome） */
const CHROME_PROFILE_DIR = path.resolve(__dirname, '..', '.chrome-profile');

/** Chrome可执行文件路径 */
const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/** 当前操作的页面对象 */
let currentPage: Page | null = null;

/** 截图保存目录 */
const SCREENSHOT_DIR = path.resolve(__dirname, '..', 'screenshots');

// =============================================================================
// Chrome 生命周期管理
// =============================================================================

/**
 * 检测Chrome CDP调试端口是否可用
 */
async function isCdpAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${CDP_PORT}/json/version`);
    const data = await response.json() as Record<string, unknown>;
    if (data && data['Browser']) {
      logger.info(`检测到Chrome CDP就绪: ${String(data['Browser'])}`);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 杀死所有chrome.exe进程
 */
function killAllChrome(): void {
  try {
    execSync('taskkill /F /IM chrome.exe /T 2>nul', { stdio: 'ignore' });
    logger.info('已清理残留Chrome进程');
  } catch {
    // 没有Chrome进程在运行，忽略错误
  }
}

/**
 * 启动Chrome调试模式（独立用户目录）
 *
 * 使用独立用户目录的好处：
 * 1. 不影响用户日常使用的Chrome窗口
 * 2. Cookie/登录状态独立存储，下次可复用
 * 3. 关闭后干净退出，不留后台进程
 */
function launchChrome(): void {
  logger.info('正在启动Chrome调试模式（独立用户目录）...');

  // 确保用户目录存在
  if (!fs.existsSync(CHROME_PROFILE_DIR)) {
    fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
  }

  // 启动Chrome:
  // --remote-debugging-port=9222  开启CDP调试端口
  // --user-data-dir=...           使用独立用户目录
  // --no-first-run                跳过首次运行向导
  // --no-default-browser-check    不检查默认浏览器
  const cmd = `start "" "${CHROME_PATH}" --remote-debugging-port=${CDP_PORT} --user-data-dir="${CHROME_PROFILE_DIR}" --no-first-run --no-default-browser-check --ignore-certificate-errors`;
  execSync(cmd, { stdio: 'ignore' });

  logger.info('Chrome已启动（独立窗口），等待CDP就绪...');
}

/**
 * 确保Chrome CDP可用
 * 先检测已有端口，没有则自动启动
 */
async function ensureCdpReady(): Promise<void> {
  if (await isCdpAvailable()) {
    return; // 已有CDP端口在运行，直接用
  }

  // 杀掉残留进程，启动新的Chrome
  killAllChrome();
  await sleep(2000);
  launchChrome();

  // 等待CDP端口就绪（最多等30秒）
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await isCdpAvailable()) {
      return;
    }
    process.stdout.write('.');
  }

  throw new Error('Chrome启动超时：30秒内未检测到CDP端口，请手动执行 chrome.exe --remote-debugging-port=9222');
}

// =============================================================================
// 自动登录
// =============================================================================

/**
 * 从环境变量读取Portal登录密码
 */
function getPortalPassword(envVar: string): string {
  const password = process.env[envVar];
  if (!password || password === '请替换为实际密码') {
    throw new Error(
      `Portal登录密码未配置！\n` +
      `请在 .env 文件中设置 ${envVar}=你的密码`
    );
  }
  return password;
}

/**
 * 自动填写登录表单并登录
 *
 * 登录页: /portal-web/login.jsp
 * 表单字段: Domain下拉框 → User Name → Password → Sign In按钮
 */
async function autoLogin(page: Page, creds: PortalCredentials): Promise<void> {
  logger.info('检测到登录页面，开始自动登录...');

  // 1. 填入 User Name
  const usernameInput = await page.waitForSelector(
    'input[name="inputUserName"]',
    { timeout: 10000 }
  );
  await usernameInput.click();
  await usernameInput.fill(creds.username);
  logger.info(`  用户名: ${creds.username}`);

  // 2. 填入 Password
  const passwordInput = await page.waitForSelector(
    'input[name="inputPasswd"]',
    { timeout: 10000 }
  );
  const password = getPortalPassword(creds.passwordEnvVar);
  await passwordInput.click();
  await passwordInput.fill(password);
  logger.info('  密码: ******');

  // 3. 点击 Sign In
  const signInBtn = await page.waitForSelector(
    'button:has-text("Sign In"), button:has-text("Sign in"), button:has-text("登录"), input[type="submit"]',
    { timeout: 10000 }
  );
  await signInBtn.click();
  logger.info('  已点击 Sign In');

  // 等待登录完成（页面跳转或弹窗出现）
  await sleep(3000);
}

// =============================================================================
// Job 选择
// =============================================================================

/**
 * 自动选择Job：在表格中找到匹配Organization+Role的行，双击；
 * 然后等待最长30秒，直到弹窗消失且跳转到前台界面。
 */
async function autoSelectJob(page: Page, creds: PortalCredentials): Promise<void> {
  logger.info('检测到Job选择弹窗，开始自动选择...');

  // 在弹窗表格中查找目标行（精确匹配 Organization + Job）
  const rows = await page.$$('table tbody tr, table tr, .el-table__row');
  let targetRow: any = null;
  for (const row of rows) {
    const text = await row.textContent();
    if (text && text.includes(creds.organization) && text.includes(creds.job)) {
      targetRow = row;
      break;
    }
  }

  if (!targetRow) {
    throw new Error(
      `未找到匹配的Job行: Organization="${creds.organization}", Job="${creds.job}"`
    );
  }

  // 双击目标行
  await targetRow.scrollIntoViewIfNeeded();
  await targetRow.dblclick();
  logger.success(`已双击选择: ${creds.organization} / ${creds.job}`);

  // 等待跳转：表格消失即视为已离开Job选择页（超时30秒）
  await page.waitForSelector('table tbody tr, .el-table__row', { state: 'detached', timeout: 30000 });
  logger.success('已跳转至前台界面');
}

// =============================================================================
// 浏览器初始化（公开入口）
// =============================================================================

/**
 * 初始化浏览器连接
 *
 * 完整流程:
 * 1. 确保Chrome CDP可用（自动拉起）
 * 2. 连接已有Chrome
 * 3. 导航到Portal
 * 4. 自动登录（如需要）
 * 5. 自动选择Job（如出现弹窗）
 *
 * @param portalConfig - 目标环境的Portal配置
 * @returns 是否成功初始化
 */
export async function initBrowser(portalConfig: PortalConfig): Promise<boolean> {
  ensureScreenshotDir(SCREENSHOT_DIR);

  // 第一步：确保CDP可用
  logger.info('正在检测Chrome调试端口...');
  await ensureCdpReady();

  // 第二步：连接Chrome
  logger.info('正在连接Chrome浏览器...');
  const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  logger.success('已连接到Chrome');

  // 第三步：获取或创建页面
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  const pages = context.pages();

  let targetPage: Page | null = null;
  for (const p of pages) {
    const url = p.url();
    if (url && !url.startsWith('chrome://') && !url.startsWith('about:') && !url.startsWith('devtools://')) {
      targetPage = p;
      break;
    }
  }

  if (!targetPage) {
    targetPage = await context.newPage();
  }

  currentPage = targetPage;

  // 第四步：导航到Portal（强制导航，不做跳过判断）
  logger.info(`正在打开: ${portalConfig.url}`);
  try {
    await targetPage.goto(portalConfig.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    // SSL证书问题等
    logger.warn(`导航到Portal时出现警告: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 第五步：检测登录表单（等待页面元素加载，最长30秒）
  // 用实际表单元素检测代替URL字符串匹配，避免白屏期间误判
  const loginFormSelector = 'input[name="inputUserName"], input[name="inputPasswd"]';
  let isLoginPage = false;
  try {
    await targetPage.waitForSelector(loginFormSelector, { timeout: 30000 });
    isLoginPage = true;
    logger.info('检测到登录表单元素');
  } catch {
    logger.info('未检测到登录表单（30秒超时），可能无需登录或页面无法访问');
  }

  if (isLoginPage) {
    logger.info('检测到登录页面');

    if (!portalConfig.credentials) {
      logger.error('该环境需要登录但未配置credentials，请在 env-config.json 中添加登录凭据');
      return false;
    }

    try {
      await autoLogin(targetPage, portalConfig.credentials);
    } catch (err) {
      logger.warn('自动登录失败，请手动在Chrome窗口中完成登录');
      logger.warn(`错误: ${err instanceof Error ? err.message : String(err)}`);
      logger.info('登录完成后，回复"继续"以继续执行。');
      return false;
    }
  } else {
    logger.info('未检测到登录页，可能已有有效Session');
  }

  // 第六步：检查是否需要选择Job（等待弹窗组件出现，最长30秒）
  if (portalConfig.credentials) {
    try {
      await targetPage.waitForSelector('div.ui-dialog.dialog-sm.comprivroot.ui-draggable', { timeout: 30000 });
      logger.info('检测到Job选择弹窗');
      await autoSelectJob(targetPage, portalConfig.credentials);
    } catch {
      logger.info('未检测到Job选择弹窗（30秒超时），可能无需选择');
    }
  }

  return true;
}

// =============================================================================
// GUI 操作函数
// =============================================================================

/**
 * 执行单个GUI操作步骤
 */
async function executeStep(step: GuiStep): Promise<StepResult> {
  if (!currentPage) {
    return { success: false, stepName: step.name, error: '浏览器页面未初始化' };
  }

  const timeout = step.timeout || 30000;

  try {
    switch (step.action) {
      case 'click':
        logger.info(`  [步骤] ${step.description}`);
        await currentPage.waitForSelector(step.selector!, { state: 'visible', timeout });
        await currentPage.click(step.selector!);
        logger.success(`  [完成] ${step.description}`);
        break;

      case 'type':
        logger.info(`  [步骤] ${step.description}`);
        await currentPage.waitForSelector(step.selector!, { state: 'visible', timeout });
        await currentPage.fill(step.selector!, step.value || '');
        logger.success(`  [完成] ${step.description}`);
        break;

      case 'waitForHidden':
        logger.info(`  [步骤] ${step.description}`);
        const loaders = [
          '.loading-mask',
          '.modal-backdrop',
          'div.blockUI',
        ];
        let anyLoaderVisible = false;
        for (const loader of loaders) {
          try {
            const el = await currentPage.waitForSelector(loader, { state: 'visible', timeout: 3000 });
            if (el) anyLoaderVisible = true;
          } catch {
            // 选择器3秒内未出现，说明没有该loading元素，继续下一个
          }
        }
        if (anyLoaderVisible) {
          for (const loader of loaders) {
            try {
              await currentPage.waitForSelector(loader, { state: 'hidden', timeout });
            } catch {
              // 选择器不存在或超时，继续下一个
            }
          }
          await sleep(2000);
        } else {
          logger.info('  未检测到loading元素，直接继续');
        }
        logger.success(`  [完成] ${step.description}`);
        break;

      case 'clickForce':
        logger.info(`  [步骤] ${step.description}`);
        await currentPage.waitForSelector(step.selector!, { state: 'attached', timeout });
        await currentPage.locator(step.selector!).click({ force: true });
        logger.success(`  [完成] ${step.description}`);
        break;

      case 'clickRowByMaxId':
        logger.info(`  [步骤] ${step.description}`);
        await currentPage.waitForSelector(step.tableSelector!, { state: 'attached', timeout });
        const clickedRow = await currentPage.evaluate(`(() => {
          const table = document.querySelector('${step.tableSelector!.replace(/'/g, "\\'")}');
          if (!table) return { error: '未找到表格' };
          const rows = table.querySelectorAll('tbody tr[id]');
          if (rows.length === 0) return { error: '表格中没有行' };
          let maxRow = null;
          let maxId = -Infinity;
          for (const row of rows) {
            const rowId = parseInt(row.id, 10);
            if (!isNaN(rowId) && rowId > maxId) {
              maxId = rowId;
              maxRow = row;
            }
          }
          if (!maxRow) return { error: '未找到有效row id' };
          const cell = maxRow.querySelector('td[role="gridcell"]');
          if (cell) {
            cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            cell.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return { success: true, rowId: maxId };
          }
          return { error: '行中没有gridcell' };
        })()`) as Record<string, unknown>;
        if ('error' in clickedRow) {
          return { success: false, stepName: step.name, error: String(clickedRow.error) };
        }
        logger.success(`  [完成] ${step.description} (row id: ${clickedRow.rowId})`);
        break;

      default:
        return { success: false, stepName: step.name, error: `未知的操作类型: ${step.action}` };
    }

    return { success: true, stepName: step.name };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    let screenshotPath = '';
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      screenshotPath = path.join(SCREENSHOT_DIR, `error-${timestamp}.png`);
      await currentPage.screenshot({ path: screenshotPath, fullPage: false });
      logger.info(`  错误截图已保存: ${screenshotPath}`);
    } catch {
      // 截图失败不影响主流程
    }

    logger.error(`  [失败] ${step.description}: ${errorMsg}`);

    return {
      success: false,
      stepName: step.name,
      error: errorMsg,
      screenshot: screenshotPath,
    };
  }
}

/**
 * 构建完整的GUI操作步骤序列
 */
function buildGuiSteps(): GuiStep[] {
  return [
    // ===== INVOICING CENTER Data Refresh =====
    {
      name: '打开菜单',
      action: 'click',
      selector: 'span.iconfont.icon-menu-list.portal__nav_icon.js-menu, .js-top-menu, .portal_nav_toggle',
      description: '点击左上角菜单按钮',
    },
    {
      name: '搜索菜单',
      action: 'type',
      selector: 'input#searchMenuInput',
      value: 'data refresh',
      description: '在菜单搜索框输入"data refresh"',
    },
    {
      name: '点击搜索按钮',
      action: 'click',
      selector: 'img#searchMenuButton',
      description: '点击菜单搜索按钮',
    },
    {
      name: '点击DataRefresh菜单',
      action: 'clickForce',
      selector: 'a:has(span.nav-title.third-menu-title)',
      description: '点击"INVOICING CENTER"下的"Data Refresh"菜单项',
    },
    {
      name: '点击Refresh按钮',
      action: 'click',
      selector: 'button.btn.btn-primary.js-refresh-price-plan',
      description: '点击页面左侧的"Refresh"按钮',
    },
    {
      name: '确认第一个对话框',
      action: 'click',
      selector: 'button.btn.btn-primary.btn-min-width',
      description: '点击弹出对话框中的"OK"按钮',
    },
    {
      name: '等待Refresh完成',
      action: 'waitForHidden',
      description: '等待Refresh操作完成(最长30秒)',
      timeout: 30000,
    },
    {
      name: '选择最新版本',
      action: 'clickRowByMaxId',
      tableSelector: 'table#btable_pricePlanRefreshGrid',
      description: '点击表格中row id最大的行(最新Version)',
    },
    {
      name: '点击激活按钮',
      action: 'click',
      selector: 'button.btn.btn_minwidth.btn-primary.js-active-pric-plan',
      description: '点击"Immediately Active"按钮',
    },
    {
      name: '确认激活对话框',
      action: 'click',
      selector: 'button.btn.btn-primary.btn-min-width',
      description: '点击激活确认对话框的"OK"按钮',
    },
    {
      name: '确认最终对话框',
      action: 'click',
      selector: 'button.btn.btn-success.btn-min-width',
      description: '点击最终确认对话框的"OK"按钮',
    },

    // ===== BILLING COMMON DATA Common Data Refresh =====
    {
      name: '打开菜单',
      action: 'click',
      selector: 'span.iconfont.icon-menu-list.portal__nav_icon.js-menu',
      description: '点击左上角菜单按钮',
    },
    {
      name: '再次搜索菜单',
      action: 'type',
      selector: 'input#searchMenuInput',
      value: 'data refresh',
      description: '在菜单搜索框再次输入"data refresh"',
    },
    {
      name: '点击搜索按钮',
      action: 'click',
      selector: 'img#searchMenuButton',
      description: '点击菜单搜索按钮',
    },
    {
      name: '点击CommonDataRefresh菜单',
      action: 'clickForce',
      selector: 'a:has(span.nav-title.second-single-menu-title)',
      description: '点击"BILLING COMMON DATA"下的"Common Data Refresh"菜单项',
    },
    {
      name: '点击RefreshAll按钮',
      action: 'click',
      selector: 'button.btn.btn-primary.js-cbec-upload-all',
      description: '点击"Refresh All"按钮(30个Refresh Cache将自动执行)',
    },
    {
      name: '等待RefreshAll完成',
      action: 'waitForHidden',
      description: '等待所有Refresh Cache自动完成(最长120秒)',
      timeout: 120000,
    },
  ];
}

/**
 * 执行完整的GUI操作序列（带重试机制）
 */
export async function executeFullGuiWorkflow(): Promise<{ success: boolean; details: any }> {
  if (!currentPage) {
    return { success: false, details: { error: '浏览器页面未初始化，请先调用 initBrowser()' } };
  }

  const allSteps = buildGuiSteps();
  const totalSteps = allSteps.length;
  const screenshots: string[] = [];
  let completedSteps = 0;
  const MAX_RETRIES = 3;

  logger.divider();
  logger.info(`开始执行GUI操作序列（共 ${totalSteps} 个步骤）`);
  logger.divider();

  let stepIndex = 0;
  while (stepIndex < allSteps.length) {
    const step = allSteps[stepIndex];
    let retryCount = 0;

    while (retryCount <= MAX_RETRIES) {
      if (retryCount > 0) {
        logger.warn(`重试步骤 "${step.description}" (第 ${retryCount}/${MAX_RETRIES} 次重试)`);
      }

      const result = await executeStep(step);

      if (result.success) {
        completedSteps++;
        stepIndex++;
        break;
      }

      if (result.screenshot) {
        screenshots.push(result.screenshot);
      }

      retryCount++;

      if (retryCount > MAX_RETRIES) {
        logger.error(
          `步骤 "${step.description}" 重试 ${MAX_RETRIES} 次后仍然失败。\n失败原因: ${result.error}`
        );

        return {
          success: false,
          details: {
            error: `GUI步骤执行失败: ${step.description} - ${result.error}`,
            guiStepsCompleted: completedSteps,
            guiStepsTotal: totalSteps,
            failedStep: step.name,
            screenshots,
          },
        };
      }

      logger.info(
        `步骤失败: ${step.description}\n原因: ${result.error}\n` +
        `已截图: ${result.screenshot || '无'}\n` +
        `将自动进行第 ${retryCount}/${MAX_RETRIES} 次重试...`
      );
      await sleep(2000);
    }
  }

  logger.divider();
  logger.success(`GUI操作序列全部完成！共执行 ${completedSteps}/${totalSteps} 个步骤`);
  logger.divider();

  return {
    success: true,
    details: {
      guiStepsCompleted: completedSteps,
      guiStepsTotal: totalSteps,
      screenshots,
    },
  };
}

/**
 * 关闭浏览器连接
 */
export async function closeBrowser(): Promise<void> {
  if (currentPage) {
    try {
      const browser = currentPage.context().browser();
      if (browser) {
        await browser.close();
      }
    } catch {
      // 连接可能已断开
    }
    currentPage = null;
    logger.info('浏览器连接已断开');
  }
}

/**
 * 获取当前页面对象（供外部调试使用）
 */
export function getCurrentPage(): Page | null {
  return currentPage;
}
