/**
 * デモの画面テスト（Playwright）。PC幅（desktop）とスマホ（mobile, タッチ）で実行する。
 */
import { expect, test, type ConsoleMessage, type Dialog, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const URL = pathToFileURL(join(import.meta.dirname, '../demo/dist/bookshelf_hub.standalone.html')).href;
const FIXTURE = readFileSync(join(import.meta.dirname, '../fixtures/demo-testdata.json'), 'utf8');

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => { errors.push(e.message); });
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d: Dialog) => { errors.push('dialog: ' + d.message()); void d.dismiss(); });
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  return errors;
}

/** 長い文字列は fill だと1文字ずつ入力されて遅い（7.6万字で約24秒）ので、値を直接入れる */
async function setText(page: Page, selector: string, text: string) {
  await page.locator(selector).evaluate((el, t) => { (el as HTMLTextAreaElement).value = t; }, text);
}

async function importFixture(page: Page) {
  await page.locator('[data-act="nav"][data-view="settings"]:visible').first().click();
  await setText(page, '#ioText', FIXTURE);
  await page.click('[data-act="importText"]');
  await page.click('#cfOk');
  await expect(page.locator('.row')).toHaveCount(11);
}

const openSeries = (page: Page, prefix: string) => page.locator('.row', { hasText: prefix }).click();
const vol = (page: Page, label: string) => page.locator(`.vol[aria-label^="${label}巻 "]`);

test('起動・サンプル・エラーなし', async ({ page }) => {
  const errors = await open(page);
  await expect(page.locator('.row')).toHaveCount(4);
  expect(errors).toEqual([]);
});

test('検索欄で続けて入力できる（v2で修正済みの回帰確認）', async ({ page }) => {
  await open(page);
  await page.click('#q');
  await page.keyboard.type('作品A');
  await expect(page.locator('#q')).toHaveValue('作品A');
  await expect(page.locator('.row')).toHaveCount(1);
});

test.describe('③ 異常な巻番号', () => {
  test('まとめて入力の 999999999 kindle は拒否し、何も変えない', async ({ page }) => {
    await open(page);
    await openSeries(page, '作品A');
    const before = await page.locator('.vol').count();
    const t = Date.now();
    await page.fill('#rangeText', '999999999 kindle');
    await page.click('#rangeForm button');
    await expect(page.locator('#rangeMsg')).toContainText('999までです');
    await expect(page.locator('#rangeMsg')).toContainText('反映していません');
    expect(Date.now() - t).toBeLessThan(3000); // 固まらない
    expect(await page.locator('.vol').count()).toBe(before);
    for (const bad of ['1-1000 kindle', '1.5-3 kobo', '１０．５００１ kindle']) {
      await page.fill('#rangeText', bad);
      await page.click('#rangeForm button');
      await expect(page.locator('#rangeMsg')).toHaveClass(/err/);
    }
  });

  test('既刊数 999999999・巻の追加 999999999 も拒否', async ({ page }) => {
    await open(page);
    await openSeries(page, '作品A');
    await page.fill('#totalInput', '999999999');
    await page.locator('#totalInput').press('Enter');
    await expect(page.locator('#toastMsg')).toContainText('999まで');
    await expect(page.locator('#totalInput')).toHaveValue('18');
    await page.fill('#volLabel', '999999999');
    await page.click('#volForm button');
    await expect(page.locator('#volMsg')).toContainText('999までです');
    await expect(page.locator('.vol')).toHaveCount(18);
  });
});

test.describe('④ 特殊な巻番号', () => {
  test('0巻・10.5・10.501・上・外伝・短編集を追加し、正しく並ぶ。上と1は別', async ({ page }) => {
    await open(page);
    await openSeries(page, '作品C');
    for (const l of ['10.501', '外伝', '0', '上', '短編集', '10.5', '１０．５０']) {
      await page.fill('#volLabel', l);
      await page.click('#volForm button');
    }
    await expect(page.locator('#volMsg')).toContainText('10.5巻はすでにあります');
    const labels = await page.locator('.vol .lbl').allTextContents();
    // 作品Cは既刊8巻。10.5巻を足しても既刊数は変わらない（整数巻ではないため）
    expect(labels).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '10.5', '10.501', '上', '外伝', '短編集']);
  });
});

test.describe('① 既刊数と記録', () => {
  test('既刊数を減らしても記録は消えず、戻すと空の巻だけ作り直す', async ({ page }) => {
    await open(page);
    await openSeries(page, '作品A');
    await page.fill('#totalInput', '5');
    await page.locator('#totalInput').press('Enter');
    // 6〜18巻は記録があるので残る（17巻だけ空なので消える）
    await expect(page.locator('.vol')).toHaveCount(17);
    await expect(page.locator('#toastMsg')).toContainText('記録があるので残しています');
    await page.fill('#totalInput', '18');
    await page.locator('#totalInput').press('Enter');
    await expect(page.locator('.vol')).toHaveCount(18);
    await expect(vol(page, '18')).toHaveAttribute('aria-label', /Kindle・Kobo/);
  });
});

test.describe('⑤ JSONバックアップ', () => {
  test('テストデータを読み込み、メモ・ストア・特殊な巻を保持し、書き出し→読み込みで変わらない', async ({ page }) => {
    const errors = await open(page);
    await importFixture(page);
    await openSeries(page, '【テスト】仕様の例');
    await expect(page.locator('#noteInput')).toHaveValue('1〜10 Kindle、11〜15 Kobo、16 ebj、17 未購入、18 両方');
    await page.click('[data-act="close"]'); // スマホでは作品ページでメニューを隠すので、本棚に戻る
    await page.locator('[data-act="nav"][data-view="settings"]:visible').first().click();
    await page.click('[data-act="exportJson"]');
    const first = await page.inputValue('#ioText');
    await page.click('[data-act="importText"]');
    await page.click('#cfOk');
    await page.locator('[data-act="nav"][data-view="settings"]:visible').first().click();
    await page.click('[data-act="exportJson"]');
    const second = await page.inputValue('#ioText');
    const strip = (s: string) => s.replace(/"exported_at": "[^"]+"/, '');
    expect(strip(second)).toBe(strip(first));
    expect(errors).toEqual([]);
  });

  test('壊れたバックアップでは上書きしない', async ({ page }) => {
    await open(page);
    await page.locator('[data-act="nav"][data-view="settings"]:visible').first().click();
    const bad = JSON.parse(FIXTURE);
    bad.series[0].total = 999999999;
    await setText(page, '#ioText', JSON.stringify(bad));
    await page.click('[data-act="importText"]');
    await expect(page.locator('#ioMsg')).toContainText('今の記録は変えていません');
    await expect(page.locator('#ioMsg')).toContainText('既刊数は999までです');
    await page.fill('#ioText', '{"version": 2, "stores": [');
    await page.click('[data-act="importText"]');
    await expect(page.locator('#ioMsg')).toContainText('JSON として読めませんでした');
    await page.locator('[data-act="nav"][data-view="library"]:visible').first().click();
    await expect(page.locator('.row')).toHaveCount(4);
  });

  test('置き換える前のデータは退避キーに残る', async ({ page }) => {
    await open(page);
    await importFixture(page);
    const saved = await page.evaluate(() => localStorage.getItem('bookshelf_hub_before_import'));
    expect(JSON.parse(saved!).series).toHaveLength(4);
  });

  test('保存データが壊れていたら、退避してお知らせを出す', async ({ page }) => {
    await page.goto(URL);
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('bookshelf_hub_v3', '{broken'); });
    await page.reload();
    await expect(page.locator('#banner')).toBeVisible();
    await expect(page.locator('#banner')).toContainText('退避しました');
    const rescued = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('bookshelf_hub_rescue_')).map((k) => localStorage.getItem(k)));
    expect(rescued).toEqual(['{broken']);
  });

  test('デモv2の保存データは自動で移行し、元のキーも残す', async ({ page }) => {
    await page.goto(URL);
    await page.evaluate((fx) => { localStorage.clear(); localStorage.setItem('bookshelf_hub_v2', fx); }, FIXTURE);
    await page.reload();
    await expect(page.locator('.row')).toHaveCount(11);
    expect(await page.evaluate(() => localStorage.getItem('bookshelf_hub_v2') !== null)).toBe(true);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('bookshelf_hub_v3')!).version)).toBe(3);
  });

  test('保存に失敗したら画面に出し続ける', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('QuotaExceededError'); }; });
    await openSeries(page, '作品A');
    await vol(page, '17').click();
    await expect(page.locator('#banner')).toContainText('保存できませんでした');
  });
});

test.describe('⑥ CSV', () => {
  test('CSVは完全バックアップではないと表示し、作品ID・既刊数・メモの列を出す', async ({ page }) => {
    await open(page);
    await page.locator('[data-act="nav"][data-view="settings"]:visible').first().click();
    await expect(page.locator('.notice-csv')).toContainText('完全なバックアップではありません');
    await page.click('[data-act="exportCsv"]');
    expect((await page.inputValue('#ioText')).split('\n')[0]).toContain('作品ID,作品,種類,既刊数,主な購入ストア,メモ,巻ID,巻キー');
  });
});

test.describe('操作性', () => {
  test('300巻：タップの反映時間を測る', async ({ page }, info) => {
    await open(page);
    await importFixture(page);
    await openSeries(page, '【テスト】300巻');
    await expect(page.locator('.vol')).toHaveCount(300);
    const times: number[] = [];
    for (const l of ['50', '100', '150', '200', '250']) {
      const t = await page.evaluate(async (label) => {
        const el = document.querySelector(`.vol[aria-label^="${label}巻 "]`) as HTMLElement;
        const t0 = performance.now();
        el.click();
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        return performance.now() - t0;
      }, l);
      times.push(t);
    }
    info.annotations.push({ type: 'perf', description: `300巻のタップ反映: ${times.map((x) => x.toFixed(1)).join(', ')} ms` });
    console.log(`[perf ${info.project.name}] 300巻のタップ反映 ms:`, times.map((x) => x.toFixed(1)).join(', '));
    expect(Math.max(...times)).toBeLessThan(500);
    await expect(vol(page, '250')).toHaveAttribute('aria-label', /Kindle/);
  });

  test('大きな範囲（51巻以上）は確認が出て、やめれば何も変わらない。当てた後は元に戻せる', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Shift+クリックはPCの操作');
    await open(page);
    await importFixture(page);
    await openSeries(page, '【テスト】全部未購入');
    await page.fill('#totalInput', '120');
    await page.locator('#totalInput').press('Enter');
    await vol(page, '1').click({ modifiers: ['Shift'] });
    await vol(page, '120').click({ modifiers: ['Shift'] });
    await expect(page.locator('#cfD')).toContainText('1〜120巻（120巻）');
    await page.click('[data-act="modalClose"]');
    await expect(page.locator('.vol.owned')).toHaveCount(0);
    await vol(page, '1').click({ modifiers: ['Shift'] });
    await vol(page, '120').click({ modifiers: ['Shift'] });
    await page.click('#cfOk');
    await expect(page.locator('.vol.owned')).toHaveCount(120);
    await page.click('#toastUndo');
    await expect(page.locator('.vol.owned')).toHaveCount(0);
  });

  test('Undo：タップ・まとめて入力・既刊数の変更をそれぞれ戻せる', async ({ page }) => {
    await open(page);
    await openSeries(page, '作品A');
    await vol(page, '17').click();
    await expect(vol(page, '17')).toHaveClass(/owned/);
    await page.fill('#rangeText', '1-3 未購入');
    await page.click('#rangeForm button');
    await expect(vol(page, '2')).toHaveClass(/gap/);
    await page.fill('#totalInput', '20');
    await page.locator('#totalInput').press('Enter');
    await expect(page.locator('.vol')).toHaveCount(20);
    await page.click('[data-act="undo"].toggle');
    await expect(page.locator('.vol')).toHaveCount(18);
    await page.click('[data-act="undo"].toggle');
    await expect(vol(page, '2')).toHaveClass(/owned/);
    await page.click('[data-act="undo"].toggle');
    await expect(vol(page, '17')).toHaveClass(/gap/);
  });

  test('Undo：値の変わらない操作のあとでも、1回で直前の変更が戻る', async ({ page }) => {
    await open(page);
    await openSeries(page, '作品A');
    await page.fill('#totalInput', '20');
    await page.locator('#totalInput').dispatchEvent('change');
    await expect(page.locator('.vol')).toHaveCount(20);
    // フォーカスが外れるときにもう一度 change が出る（値は同じ）
    await page.locator('#totalInput').dispatchEvent('change');
    await page.click('[data-act="undo"].toggle');
    await expect(page.locator('.vol')).toHaveCount(18);
  });

  test('スマホ：長押しで範囲の始点、タップで終点。スクロールの指の動きでは長押しにならない', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'タッチ操作のテスト');
    await open(page);
    await openSeries(page, '作品B');
    const press = async (label: string, moveBy = 0) => {
      const box = (await vol(page, label).boundingBox())!;
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await vol(page, label).dispatchEvent('pointerdown', { clientX: x, clientY: y, pointerType: 'touch', bubbles: true });
      if (moveBy) await page.dispatchEvent('body', 'pointermove', { clientX: x, clientY: y + moveBy, pointerType: 'touch', bubbles: true });
      await page.waitForTimeout(600);
      await vol(page, label).dispatchEvent('pointerup', { pointerType: 'touch', bubbles: true });
      await vol(page, label).dispatchEvent('click');
    };
    await press('8', 40); // 指が動いた＝スクロール → 長押しにならず、ただのタップ
    await expect(page.locator('.vol.anchor')).toHaveCount(0);
    await expect(vol(page, '8')).toHaveClass(/owned/);
    await press('10');
    await expect(page.locator('.vol.anchor')).toHaveCount(1);
    await vol(page, '12').tap();
    await expect(vol(page, '11')).toHaveClass(/owned/);
    await expect(vol(page, '12')).toHaveClass(/owned/);
  });

  test('長い作品名・HTMLタグの作品名でも崩れず、タグは文字として表示', async ({ page }) => {
    const errors = await open(page);
    await importFixture(page);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await openSeries(page, '【テスト】とても長い');
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.click('[data-act="close"]');
    await openSeries(page, '【テスト】記号');
    await expect(page.locator('h1')).toContainText('<b>太字</b>');
    expect(await page.locator('h1 b').count()).toBe(0);
    expect(await overflow()).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });

  test('モーダル：開くとフォーカスが中へ、Tab は中で循環、Esc で閉じて元のボタンへ戻る', async ({ page, isMobile }) => {
    test.skip(isMobile, 'キーボード操作のテスト');
    await open(page);
    const opener = page.locator('[data-act="addSeries"]');
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#newTitle')).toBeFocused();
    expect(await page.locator('.app').getAttribute('inert')).not.toBeNull();
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.modal'))).toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.modal'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await page.locator('.app').getAttribute('inert')).toBeNull();
  });

  test('作品の追加：既刊数 1000 は理由を表示して追加しない', async ({ page }) => {
    await open(page);
    await page.click('[data-act="addSeries"]');
    await page.fill('#newTitle', 'テスト');
    await page.fill('#newTotal', '1000');
    await page.click('#addForm button.btn:not(.ghost)');
    await expect(page.locator('#addMsg')).toContainText('999まで');
    await page.keyboard.press('Escape');
    await expect(page.locator('.row')).toHaveCount(4);
  });
});
