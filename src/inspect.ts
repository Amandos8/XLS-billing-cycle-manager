/**
 * 探测脚本 v2 - 等待SPA渲染完成
 */
import { chromium } from 'playwright';

const CDP_PORT = 9222;
const PORTAL_URL = 'https://10.16.180.15/portal-web/';

async function main() {
  const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  const contexts = browser.contexts();
  const context = contexts[0];
  const pages = context.pages();
  let page = pages.find(p => !p.url().startsWith('chrome://') && !p.url().startsWith('about:') && !p.url().startsWith('devtools://'));
  if (!page) {
    page = await context.newPage();
  }

  // 监听导航和请求
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) {
      console.log('导航到:', frame.url());
    }
  });

  page.on('request', req => {
    if (['document', 'xhr', 'fetch'].includes(req.resourceType())) {
      console.log(`  [${req.resourceType()}] ${req.method()} ${req.url().substring(0, 120)}`);
    }
  });

  console.log('=== 导航到Portal ===');
  await page.goto(PORTAL_URL, { waitUntil: 'networkidle', timeout: 60000 }).catch(err => {
    console.log('导航警告:', err.message);
  });

  console.log('导航完成，当前URL:', page.url());
  console.log('等待额外10秒让SPA渲染...');
  await page.waitForTimeout(10000);

  console.log('最终URL:', page.url());

  // 检查是否在登录页
  const url = page.url();
  if (url.includes('login') || url.includes('signin') || url.includes('sso')) {
    console.log('在登录页面，尝试自动登录...');
    try {
      await page.waitForSelector('input[name="j_username"]', { timeout: 10000 });
      await page.fill('input[name="j_username"]', 's0027029233');
      await page.fill('input[type="password"]', 'Uportal_123');
      await page.click('input[value="Sign In"]');
      console.log('已点击Sign In');
      await page.waitForTimeout(8000);
      console.log('登录后URL:', page.url());
    } catch (err) {
      console.log('自动登录出错:', err instanceof Error ? err.message : String(err));
    }
  }

  // 检查Job选择弹窗
  const content = await page.content();
  if (content.includes('Please Select') || content.includes('Organization')) {
    console.log('检测到Job选择弹窗，尝试处理...');
    const rows = await page.$$('table tbody tr, table tr, .el-table__row');
    for (const row of rows) {
      const text = await row.textContent();
      if (text && text.includes('CASH_CSR')) {
        await row.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        await row.dblclick();
        console.log('已双击选择Job行');
        break;
      }
    }
    await page.waitForTimeout(3000);
  }

  // 截图
  await page.screenshot({ path: 'D:/billing-cycle-manager/screenshots/inspect2.png', fullPage: false });
  console.log('截图已保存');

  // 获取完整页面内容
  const fullContent = await page.content();
  console.log('\n=== 页面HTML (前5000字符) ===');
  console.log(fullContent.substring(0, 5000));

  // 找所有可见元素
  const visibleElements = await page.$$eval('*', els =>
    els.filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).slice(0, 50).map(el => ({
      tag: el.tagName,
      class: el.className?.substring(0, 100),
      id: el.id,
      text: el.textContent?.trim().substring(0, 80),
      html: el.outerHTML?.substring(0, 200),
    }))
  );
  console.log('\n=== 可见元素 ===');
  console.log(JSON.stringify(visibleElements, null, 2));

  console.log('\n=== 探测完成 ===');
}

main().catch(err => {
  console.error('探测失败:', err);
  process.exit(1);
});
