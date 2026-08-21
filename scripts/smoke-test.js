const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div role="textbox" contenteditable="true"></div>');

    const composer = page.locator('[role="textbox"]');
    await composer.fill('smoke test');
    if ((await composer.textContent()) !== 'smoke test') {
      throw new Error('Không điền được nội dung vào contenteditable.');
    }

    console.log('Playwright Chromium smoke test: OK');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
