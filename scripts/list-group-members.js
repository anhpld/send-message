const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { getConfig, loadEnvFile, validateChatUrl } = require('../src/messenger');

const projectRoot = path.resolve(__dirname, '..');
const INFO_BUTTON_NAMES = [
  /Conversation information/i,
  /Chat information/i,
  /Thông tin (?:về )?(?:đoạn|cuộc) trò chuyện/i,
  /Chi tiết (?:đoạn|cuộc) trò chuyện/i,
];
const INFO_BUTTON_SELECTORS = [
  '[aria-label="Thông tin về cuộc trò chuyện"]',
  '[aria-label="Conversation information"]',
  '[aria-label="Chat information"]',
];
const MEMBER_BUTTON_NAMES = [
  /Chat members/i,
  /Conversation members/i,
  /People in this chat/i,
  /Thành viên trong (?:đoạn|cuộc) trò chuyện/i,
  /^Thành viên$/i,
];
const MEMBER_BUTTON_SELECTORS = [
  '[aria-label="Thành viên trong đoạn chat"]',
  '[aria-label="Thành viên trong cuộc trò chuyện"]',
  '[aria-label="Chat members"]',
  '[aria-label="Conversation members"]',
];
function usage() {
  console.log('Cách dùng: npm run messenger:members -- https://www.messenger.com/t/ID_NHOM');
}

async function findVisibleControl(page, patterns, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const pattern of patterns) {
      const roleCandidates = page.getByRole('button', { name: pattern });
      for (let index = 0; index < await roleCandidates.count(); index += 1) {
        const candidate = roleCandidates.nth(index);
        if (await candidate.isVisible().catch(() => false)) return candidate;
      }

      const textCandidates = page.getByText(pattern);
      for (let index = 0; index < await textCandidates.count(); index += 1) {
        const text = textCandidates.nth(index);
        if (!(await text.isVisible().catch(() => false))) continue;

        const control = text.locator(
          'xpath=ancestor-or-self::*[@role="button" or name()="button"][1]',
        );
        if (await control.isVisible().catch(() => false)) return control;

        // Messenger sometimes attaches the click handler to a role-less parent.
        // Clicking the visible text still bubbles the event to that control.
        return text;
      }
    }
    await page.waitForTimeout(400);
  }
  return null;
}

async function findConversationInfoControl(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of INFO_BUTTON_SELECTORS) {
      const candidates = page.locator(selector);
      for (let index = 0; index < await candidates.count(); index += 1) {
        const candidate = candidates.nth(index);
        if (await candidate.isVisible().catch(() => false)) return candidate;
      }
    }
    await page.waitForTimeout(400);
  }

  return findVisibleControl(page, INFO_BUTTON_NAMES, timeoutMs);
}

async function findMembersControl(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of MEMBER_BUTTON_SELECTORS) {
      const candidates = page.locator(selector);
      for (let index = 0; index < await candidates.count(); index += 1) {
        const candidate = candidates.nth(index);
        if (await candidate.isVisible().catch(() => false)) return candidate;
      }
    }
    await page.waitForTimeout(400);
  }

  return findVisibleControl(page, MEMBER_BUTTON_NAMES, timeoutMs);
}

async function requiresAuthentication(page) {
  const currentUrl = page.url().toLowerCase();
  if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) return true;
  return page.locator('input[name="email"], input[name="pass"]').first().isVisible().catch(() => false);
}

function chatIdFromUrl(rawUrl) {
  const parts = new URL(rawUrl).pathname.split('/').filter(Boolean);
  const index = parts.indexOf('t');
  return index >= 0 ? parts[index + 1] : null;
}

async function findMemberPanel(membersButton, timeoutMs) {
  const buttonHandle = await membersButton.elementHandle();
  if (!buttonHandle) return null;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const panelHandle = await buttonHandle.evaluateHandle((button) => {
      let current = button.parentElement;
      let sidePanel = null;

      while (current && current !== document.body) {
        const rect = current.getBoundingClientRect();
        const style = window.getComputedStyle(current);
        const isRightPanel = rect.left >= window.innerWidth * 0.5
          && rect.right >= window.innerWidth * 0.9
          && rect.height >= window.innerHeight * 0.5;
        const isScrollable = current.scrollHeight > current.clientHeight + 8
          && ['auto', 'scroll'].includes(style.overflowY);

        if (isRightPanel && !sidePanel) sidePanel = current;
        if (isRightPanel && isScrollable) return current;
        current = current.parentElement;
      }

      return sidePanel;
    });
    const panel = panelHandle.asElement();
    if (panel) {
      await buttonHandle.dispose();
      return panel;
    }
    await panelHandle.dispose();
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  await buttonHandle.dispose();
  return null;
}

async function readMemberPanel(panel) {
  return panel.evaluate((element) => {
    const members = [];
    for (const row of element.querySelectorAll('[role="listitem"]')) {
      const avatar = row.querySelector('svg[role="img"][aria-label]');
      const image = avatar?.querySelector('image, img');
      const name = (avatar?.getAttribute('aria-label') || '').trim();
      const imageUrl = image?.getAttribute('xlink:href')
        || image?.getAttribute('href')
        || image?.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
        || image?.getAttribute('src')
        || null;
      if (name) members.push({ name, imageUrl });
    }

    const previousScrollTop = element.scrollTop;
    element.scrollTop = Math.min(
      element.scrollTop + Math.max(Math.floor(element.clientHeight * 0.8), 500),
      element.scrollHeight,
    );
    return {
      members,
      moved: element.scrollTop > previousScrollTop,
      atEnd: element.scrollTop + element.clientHeight >= element.scrollHeight - 3,
    };
  });
}

async function saveDiagnostic(page, diagnosticsDir) {
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const screenshotPath = path.join(diagnosticsDir, `members-${timestamp}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.error(`Đã lưu ảnh chẩn đoán tại: ${screenshotPath}`);
}

async function savePanelDiagnostic(panel, diagnosticsDir) {
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const htmlPath = path.join(diagnosticsDir, `member-panel-${timestamp}.html`);
  const html = await panel.evaluate((element) => element.outerHTML);
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.error(`Đã lưu HTML panel thành viên tại: ${htmlPath}`);
}

async function listGroupMembers(chatUrl, config) {
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    headless: config.headless,
  });
  let context;
  let page;

  try {
    context = await browser.newContext({
      storageState: fs.existsSync(config.storageStatePath) ? config.storageStatePath : undefined,
      viewport: { width: 1440, height: 1000 },
      locale: process.env.MESSENGER_LOCALE || 'vi-VN',
    });
    page = context.pages()[0] || await context.newPage();
    console.error('Đang mở nhóm Messenger...');
    await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });

    if (await requiresAuthentication(page)) {
      throw new Error('Session Messenger không hợp lệ hoặc tài khoản đang yêu cầu đăng nhập/checkpoint.');
    }

    const expectedChatId = chatIdFromUrl(chatUrl);
    const openedChatId = chatIdFromUrl(page.url());
    if (!expectedChatId || openedChatId !== expectedChatId) {
      throw new Error(`Messenger đã mở sai cuộc trò chuyện. URL hiện tại: ${page.url()}`);
    }
    console.error(`Đã mở đúng cuộc trò chuyện: ${page.url()}`);
    await page.waitForTimeout(2_000);

    console.error('Đang mở thông tin cuộc trò chuyện...');
    const infoButton = await findConversationInfoControl(page, config.timeoutMs);
    if (!infoButton) throw new Error('Không tìm thấy nút thông tin cuộc trò chuyện.');
    await infoButton.evaluate((element) => element.click());

    console.error('Đang mở danh sách thành viên...');
    const membersButton = await findMembersControl(page, config.timeoutMs);
    if (!membersButton) throw new Error('Không tìm thấy mục danh sách thành viên.');
    const expanded = await membersButton.getAttribute('aria-expanded');
    if (expanded !== 'true') await membersButton.evaluate((element) => element.click());

    const panel = await findMemberPanel(membersButton, config.timeoutMs);
    if (!panel) {
      throw new Error('Danh sách thành viên chưa mở; không thực hiện đọc dữ liệu để tránh lấy nhầm sidebar.');
    }

    const members = new Map();
    let unchangedRounds = 0;
    let previousSize = -1;

    console.error('Đang đọc thành viên...');
    for (let round = 0; round < 40 && (!members.size || unchangedRounds < 4); round += 1) {
      const snapshot = await readMemberPanel(panel);
      for (const member of snapshot.members) {
        const key = member.name.toLocaleLowerCase('vi');
        const previous = members.get(key);
        if (!previous || member.imageUrl || !previous.imageUrl) members.set(key, member);
      }
      unchangedRounds = members.size === previousSize ? unchangedRounds + 1 : 0;
      previousSize = members.size;
      if (members.size && snapshot.atEnd && !snapshot.moved && unchangedRounds >= 1) break;
      await page.waitForTimeout(350);
    }

    if (!members.size) {
      await savePanelDiagnostic(panel, config.diagnosticsDir).catch(() => {});
      await panel.dispose();
      throw new Error('Đã mở danh sách nhưng không đọc được thành viên. Giao diện Messenger có thể đã thay đổi.');
    }

    const result = [...members.values()].sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    if (result.some((member) => !member.imageUrl)) {
      await savePanelDiagnostic(panel, config.diagnosticsDir).catch(() => {});
      console.error('Một số avatar chưa đọc được; đã lưu HTML panel để chẩn đoán.');
    }
    await panel.dispose();

    return result;
  } catch (error) {
    if (page) await saveDiagnostic(page, config.diagnosticsDir).catch(() => {});
    throw error;
  } finally {
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function main() {
  loadEnvFile();
  const rawChatUrl = process.argv[2] || process.env.MESSENGER_CHAT_URL;
  if (!rawChatUrl || ['--help', '-h'].includes(rawChatUrl)) {
    usage();
    process.exitCode = rawChatUrl ? 0 : 1;
    return;
  }

  const chatUrl = validateChatUrl(rawChatUrl);
  const members = await listGroupMembers(chatUrl, getConfig());
  console.log(JSON.stringify({ count: members.length, members }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Lỗi: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { chatIdFromUrl, listGroupMembers };
