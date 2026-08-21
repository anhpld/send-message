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
    profileDir: path.resolve(
      projectRoot,
      process.env.MESSENGER_PROFILE_DIR || '.playwright/messenger-profile',
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
  return chromium.launchPersistentContext(config.profileDir, {
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    headless: config.headless,
    viewport: null,
    locale: process.env.MESSENGER_LOCALE || 'vi-VN',
  });
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

  const context = await openBrowser(config);
  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
    console.log(`Session sẽ được lưu tại: ${config.profileDir}`);
    console.log('Hãy đăng nhập Facebook/Messenger và xử lý 2FA trong cửa sổ trình duyệt.');
    await waitForTerminalEnter('Đăng nhập xong, quay lại terminal và nhấn Enter để lưu session... ');
  } finally {
    await context.close();
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

  const context = await openBrowser(config);
  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
    const composer = await findComposer(page, config.timeoutMs);
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
    console.log('Đã nhấn Enter để gửi tin nhắn.');
  } finally {
    await context.close();
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
