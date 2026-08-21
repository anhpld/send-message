const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { chromium } = require('playwright');

const projectRoot = path.resolve(__dirname, '..');

function loadEnvFile(filePath = path.join(projectRoot, '.env')) {
  if (!fs.existsSync(filePath)) return;

  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value.replace(/\\n/g, '\n');
  }
}

function asBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function getConfig() {
  const timeoutMs = Number(process.env.MESSENGER_TIMEOUT_MS || 30_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
    throw new Error('MESSENGER_TIMEOUT_MS phải là số từ 1000 trở lên.');
  }

  return {
    baseUrl: process.env.MESSENGER_BASE_URL || 'https://www.messenger.com/',
    storageStatePath: path.resolve(
      projectRoot,
      process.env.MESSENGER_STORAGE_STATE || '.playwright/messenger-state.json',
    ),
    diagnosticsDir: path.resolve(
      projectRoot,
      process.env.MESSENGER_DIAGNOSTICS_DIR || '.playwright/diagnostics',
    ),
    timeoutMs,
    headless: asBoolean(process.env.HEADLESS, false),
  };
}

function validateChatUrl(rawUrl) {
  if (!rawUrl) throw new Error('Thiếu MESSENGER_CHAT_URL.');

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('MESSENGER_CHAT_URL không phải URL hợp lệ.');
  }

  const allowedHosts = new Set([
    'messenger.com',
    'www.messenger.com',
    'facebook.com',
    'www.facebook.com',
  ]);
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error('MESSENGER_CHAT_URL phải thuộc messenger.com hoặc facebook.com.');
  }

  const isMessengerChat = /^\/t\/[^/]+/.test(url.pathname);
  const isFacebookChat = /^\/messages\/t\/[^/]+/.test(url.pathname);
  if (!isMessengerChat && !isFacebookChat) {
    throw new Error('MESSENGER_CHAT_URL phải là link chat dạng /t/... hoặc /messages/t/...');
  }

  return url.toString();
}

async function openBrowser(config) {
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    headless: config.headless,
  });

  try {
    const context = await browser.newContext({
      storageState: fs.existsSync(config.storageStatePath) ? config.storageStatePath : undefined,
      viewport: null,
      locale: process.env.MESSENGER_LOCALE || 'vi-VN',
    });
    return { browser, context };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function saveStorageState(context, config) {
  fs.mkdirSync(path.dirname(config.storageStatePath), { recursive: true });
  await context.storageState({
    path: config.storageStatePath,
    indexedDB: true,
  });
}

async function saveDiagnostics(page, config) {
  fs.mkdirSync(config.diagnosticsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const screenshotPath = path.join(config.diagnosticsDir, `messenger-${timestamp}.png`);
  const title = await page.title().catch(() => 'Không đọc được tiêu đề');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.error(`Messenger đang ở URL: ${page.url()}`);
  console.error(`Tiêu đề trang: ${title}`);
  console.error(`Đã lưu ảnh chẩn đoán tại: ${screenshotPath}`);
}

async function requiresAuthentication(page) {
  try {
    const pathname = new URL(page.url()).pathname.toLowerCase();
    if (pathname.includes('/login') || pathname.includes('/checkpoint')) return true;
  } catch {
    // Continue with the DOM check when the current URL cannot be parsed.
  }

  return page.locator('input[name="email"], input[name="pass"]').first().isVisible().catch(() => false);
}

function continueButton(page) {
  return page.getByRole('button', { name: /^(Tiếp tục dưới tên|Continue as)/i }).first();
}

function authenticationError() {
  const error = new Error('Session Messenger không hợp lệ hoặc tài khoản đang yêu cầu đăng nhập/checkpoint.');
  error.code = 'MESSENGER_AUTH_REQUIRED';
  return error;
}

async function clickContinueWithSavedAccount(page, timeoutMs = 0) {
  const button = continueButton(page);
  if (timeoutMs > 0) {
    await button.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {});
  }
  if (!(await button.isVisible().catch(() => false))) return false;

  await button.click();
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(2_000);
  return true;
}

async function restoreMessengerSession(page, context, config) {
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
  const continued = await clickContinueWithSavedAccount(page, Math.min(config.timeoutMs, 10_000));
  if (!continued || await requiresAuthentication(page)) return false;

  await saveStorageState(context, config);
  return true;
}

async function closeBrowser(browser, context) {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

function waitForTerminalEnter(prompt) {
  if (!process.stdin.isTTY) return Promise.resolve();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function login(config) {
  if (config.headless) {
    throw new Error('Lệnh login cần HEADLESS=false để bạn đăng nhập thủ công.');
  }

  const { browser, context } = await openBrowser(config);
  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
    console.log(`Session sẽ được lưu tại: ${config.storageStatePath}`);
    console.log('Hãy đăng nhập Facebook/Messenger và xử lý 2FA trong cửa sổ trình duyệt.');
    await waitForTerminalEnter('Đăng nhập xong, quay lại terminal và nhấn Enter để lưu session... ');
    await clickContinueWithSavedAccount(page, 3_000);
    if (await requiresAuthentication(page)) throw authenticationError();
    await saveStorageState(context, config);
    console.log('Đã lưu storage state. Không commit hoặc chia sẻ file này.');
  } finally {
    await closeBrowser(browser, context);
  }
}

async function findComposer(page, timeoutMs) {
  const selectors = [
    '[aria-label="Tin nhắn"][contenteditable="true"]',
    '[aria-label="Message"][contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"][data-lexical-editor="true"]',
  ];

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await requiresAuthentication(page) || await continueButton(page).isVisible().catch(() => false)) {
      throw authenticationError();
    }
    for (const selector of selectors) {
      const candidates = page.locator(selector);
      for (let index = (await candidates.count()) - 1; index >= 0; index -= 1) {
        const candidate = candidates.nth(index);
        if (await candidate.isVisible().catch(() => false)) return candidate;
      }
    }
    await page.waitForTimeout(500);
  }

  throw new Error(
    'Không tìm thấy ô nhập tin nhắn. Session có thể đã hết hạn hoặc giao diện Messenger đã thay đổi.',
  );
}

async function send(config, confirmSend) {
  const chatUrl = validateChatUrl(config.chatUrl);
  if (!config.message || !config.message.trim()) {
    throw new Error('Thiếu MESSAGE_TEXT hoặc nội dung đang trống.');
  }
  if (config.headless && !confirmSend) {
    throw new Error('Preview cần HEADLESS=false để bạn kiểm tra nội dung.');
  }

  const { browser, context } = await openBrowser(config);
  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
    let composer;
    try {
      composer = await findComposer(page, config.timeoutMs);
    } catch (error) {
      if (error.code !== 'MESSENGER_AUTH_REQUIRED' || !(await restoreMessengerSession(page, context, config))) {
        throw error;
      }
      await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
      composer = await findComposer(page, config.timeoutMs);
    }
    await composer.click();
    await composer.fill(config.message);

    if (!confirmSend) {
      console.log('PREVIEW: Nội dung đã được nhập nhưng CHƯA gửi.');
      console.log('Kiểm tra đúng group và nội dung trong trình duyệt.');
      await waitForTerminalEnter('Nhấn Enter trong terminal để đóng trình duyệt... ');
      return;
    }

    await composer.press('Enter');
    await page.waitForTimeout(1_500);
    await saveStorageState(context, config);
    console.log('Đã nhấn Enter để gửi tin nhắn.');
  } catch (error) {
    await saveDiagnostics(page, config).catch((diagnosticError) => {
      console.error(`Không thể lưu ảnh chẩn đoán: ${diagnosticError.message}`);
    });
    throw error;
  } finally {
    await closeBrowser(browser, context);
  }
}

function printHelp() {
  console.log(`Cách dùng:
  node src/messenger.js login
  npm.cmd run api
`);
}

async function main() {
  loadEnvFile();
  const config = getConfig();
  const [command] = process.argv.slice(2);

  if (command === 'login') {
    await login(config);
    return;
  }
  printHelp();
  if (command && !['--help', '-h'].includes(command)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Lỗi: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  getConfig,
  loadEnvFile,
  login,
  send,
  validateChatUrl,
};
