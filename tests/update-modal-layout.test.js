'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
test('update progress dialog is centred with its inline flex display and contains its close button', { skip: !process.env.NEXUS_PLAYWRIGHT_MODULE }, async () => {
  const { chromium } = require(process.env.NEXUS_PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const page = await browser.newPage();
    const source = fs.readFileSync(path.join(root, 'views/settings.ejs'), 'utf8');
    const start = source.indexOf('  <div class="modal-backdrop" id="project-update-modal"');
    const end = source.indexOf('  <section', start);
    assert.ok(start > 0 && end > start);
    await page.setContent('<main style="height:3000px">Настройки</main>' + source.slice(start, end));
    await page.addStyleTag({ path: path.join(root, 'public/css/spectrum-clear.css') });
    for (const [width,height] of [[1920,1080],[1440,900],[390,844],[844,390]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => {
        window.scrollTo(0, 900);
        document.getElementById('project-update-modal').style.display = 'flex';
      });
      const card = page.locator('.project-update-progress-card'), close = card.locator('.modal-close');
      const box = await card.boundingBox(), button = await close.boundingBox();
      assert.ok(Math.abs(box.x + box.width/2 - width/2) < 2, JSON.stringify(box));
      assert.ok(Math.abs(box.y + box.height/2 - height/2) < 2, JSON.stringify(box));
      assert.ok(box.x >= 0 && box.y >= 0 && box.x+box.width <= width && box.y+box.height <= height);
      assert.ok(button.x >= box.x && button.y >= box.y && button.x+button.width <= box.x+box.width && button.y+button.height <= box.y+box.height);
      if (process.env.NEXUS_UI_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.NEXUS_UI_SCREENSHOT_DIR, 'update-modal-' + width + '.png') });
      await page.evaluate(() => {
        const details = document.getElementById('project-update-log-details');
        details.hidden = false; details.open = true;
        document.getElementById('project-update-log').textContent = 'Technical log\n'.repeat(100);
      });
      const expanded = await card.boundingBox();
      assert.ok(expanded.y >= 0 && expanded.y+expanded.height <= height);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth+1), false);
      await page.evaluate(() => {
        document.getElementById('project-update-log-details').hidden = true;
        document.getElementById('project-update-modal').style.display = 'none';
      });
      assert.equal(await card.isVisible(), false);
    }
  } finally { await browser.close(); }
});
