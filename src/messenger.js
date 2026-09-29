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

async function dismissBlockingOverlays(page) {
  try {
    const dialogCount = await page.locator('div[role="dialog"]').count();
    if (dialogCount === 0) return false;

    console.log(`[OVERLAY] Phát hiện ${dialogCount} hộp thoại dialog, đang xử lý đóng...`);

    // 1. Nếu có nút "Không khôi phục tin nhắn" / "Continue without restoring"
    const clickedConfirm = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('div[role="dialog"] div[role="button"], div[role="dialog"] button'));
      const btn = buttons.find((b) => {
        const t = (b.innerText || '').toLowerCase();
        return t.includes('không khôi phục') || t.includes('continue without') || t.includes('để sau') || t.includes('không phải bây giờ');
      });
      if (btn) {
        btn.click();
        return btn.innerText;
      }
      return null;
    });

    if (clickedConfirm) {
      console.log(`[OVERLAY] Đã bấm xác nhận: "${clickedConfirm}"`);
      await page.waitForTimeout(1000);
    }

    // 2. Click nút Đóng (✕)
    const clickedClose = await page.evaluate(() => {
      const btn = document.querySelector('div[role="dialog"] div[aria-label="Đóng"], div[role="dialog"] [aria-label="Close"], div[role="dialog"] [aria-label="close"]');
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    if (clickedClose) {
      console.log('[OVERLAY] Đã bấm nút Đóng (✕) của dialog');
      await page.waitForTimeout(1000);

      // Thử kiểm tra tiếp xem có hiện modal xác nhận tiếp không
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('div[role="dialog"] div[role="button"], div[role="dialog"] button'));
        const btn = buttons.find((b) => {
          const t = (b.innerText || '').toLowerCase();
          return t.includes('không khôi phục') || t.includes('continue without') || t.includes('để sau') || t.includes('không phải bây giờ');
        });
        if (btn) btn.click();
      });
      await page.waitForTimeout(500);
    }

    // 3. Fallback: Escape
    const remaining = await page.locator('div[role="dialog"]').count();
    if (remaining > 0) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }

    return true;
  } catch (err) {
    console.warn('[OVERLAY] Bỏ qua lỗi khi xử lý dialog:', err.message);
    return false;
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
    await dismissBlockingOverlays(page);
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

function parseMessageSegments(message) {
  const segments = [];
  const regex = /@\[([^\]]+)\]/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(message)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: message.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'mention', name: match[1], raw: match[0] });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < message.length) {
    segments.push({ type: 'text', value: message.slice(lastIndex) });
  }

  return segments;
}

async function insertTextLines(page, text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      await page.keyboard.press('Shift+Enter');
      await page.waitForTimeout(100);
    }
    if (lines[i].length > 0) {
      await page.keyboard.insertText(lines[i]);
      await page.waitForTimeout(50);
    }
  }
}

async function getVisibleMentionOption(page) {
  const optionSelectors = [
    '[role="listbox"] [role="option"]',
    'ul[role="listbox"] li',
    '[role="menu"] [role="menuitem"]',
    'div[data-testid*="mention"] [role="option"]',
    'div[aria-label*="gợi ý" i] [role="option"]',
    'div[aria-label*="suggestion" i] [role="option"]',
    'div[aria-label*="nhắc đến" i] [role="option"]',
  ];
  for (const selector of optionSelectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const item = locator.nth(i);
      if (await item.isVisible().catch(() => false)) {
        return item;
      }
    }
  }
  return null;
}

async function typeMessageWithMentions(page, composer, message) {
  const segments = parseMessageSegments(message);

  await composer.click();
  await page.waitForTimeout(300);

  for (const segment of segments) {
    if (segment.type === 'text') {
      await composer.focus().catch(() => {});
      await page.keyboard.press('End');
      await insertTextLines(page, segment.value);
      continue;
    }

    if (segment.type === 'mention') {
      // Gõ '@' để kích hoạt popup danh sách thành viên
      await page.keyboard.type('@', { delay: 100 });
      await page.waitForTimeout(200);

      // Gõ tên để lọc gợi ý
      await page.keyboard.type(segment.name, { delay: 60 });

      // Chờ tối đa 1.8s xem popup gợi ý có xuất hiện hay không
      const deadline = Date.now() + 1800;
      let option = null;
      while (Date.now() < deadline) {
        option = await getVisibleMentionOption(page);
        if (option) break;
        await page.waitForTimeout(150);
      }

      if (option) {
        // Popup xuất hiện: click option đầu tiên hoặc ấn Enter để xác nhận tag
        const clicked = await option.click().then(() => true).catch(() => false);
        if (!clicked) {
          await page.keyboard.press('Enter');
        }
        await page.waitForTimeout(300);
        await composer.focus().catch(() => {});
        await page.keyboard.press('End');
        await page.waitForTimeout(100);
      } else {
        // Fallback: popup không xuất hiện -> xóa những gì vừa gõ và giữ nguyên @[Tên]
        await composer.focus().catch(() => {});
        const charCount = 1 + [...segment.name].length;
        for (let i = 0; i < charCount; i++) {
          await page.keyboard.press('Backspace');
        }
        await page.keyboard.insertText(segment.raw);
        await composer.focus().catch(() => {});
        await page.keyboard.press('End');
        await page.waitForTimeout(100);
      }
    }
  }
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
    await dismissBlockingOverlays(page);
    try {
      await composer.click({ timeout: 5000 });
    } catch (clickErr) {
      console.warn(`[WARN] Click thông thường gặp cản trở (${clickErr.message}), thử dismiss lại overlay và click force...`);
      await dismissBlockingOverlays(page);
      await composer.click({ force: true });
    }
    if (config.message.includes('@[')) {
      await typeMessageWithMentions(page, composer, config.message);
    } else {
      await composer.fill(config.message);
    }

    if (!confirmSend) {
      console.log('PREVIEW: Nội dung đã được nhập nhưng CHƯA gửi.');
      console.log('Kiểm tra đúng group và nội dung trong trình duyệt.');
      await waitForTerminalEnter('Nhấn Enter trong terminal để đóng trình duyệt... ');
      return;
    }

    await composer.press('Enter');
    await page.waitForTimeout(10_000);
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
  parseMessageSegments,
  getVisibleMentionOption,
};
