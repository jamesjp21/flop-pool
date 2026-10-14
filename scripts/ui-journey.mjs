// Drives the real UI through the acceptance journey in headless Chromium and saves
// screenshots to .screens/. Usage:
//   node scripts/ui-journey.mjs http://127.0.0.1:8787          (server build)
//   node scripts/ui-journey.mjs artifact                        (dist/artifact/local-test.html)

import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const target = process.argv[2] ?? 'http://127.0.0.1:8787';
const outDir = resolve('.screens', target === 'artifact' ? 'artifact' : 'server');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const problems = [];

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1320, height: 900 }, ...opts });
  // The CDN and font hosts are unreachable from the sandbox: serve React from node_modules, drop fonts.
  await ctx.route(/cdnjs\.cloudflare\.com\/ajax\/libs\/react\/.*\/react\.production\.min\.js/, (r) => r.fulfill({ body: readFileSync('node_modules/react/umd/react.production.min.js'), contentType: 'text/javascript' }));
  await ctx.route(/cdnjs\.cloudflare\.com\/ajax\/libs\/react-dom\/.*\/react-dom\.production\.min\.js/, (r) => r.fulfill({ body: readFileSync('node_modules/react-dom/umd/react-dom.production.min.js'), contentType: 'text/javascript' }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ body: '', contentType: 'text/css' }));
  const page = await ctx.newPage();
  // 4xx responses are expected where the journey checks rejections (e.g. a duplicate receipt).
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return page;
}

const url = (hash = '') => (target === 'artifact' ? `file://${resolve('dist/artifact/local-test.html')}${hash}` : `${target}/${hash}`);
const shot = async (page, name) => page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
const toast = async (page, re) => {
  await page.locator('.toast', { hasText: re }).first().waitFor({ timeout: 8000 });
};
const step = (s) => console.log(`• ${s}`);

const page = await newPage();
await page.goto(url('#/'));
await page.getByRole('heading', { name: /Fund part of a managed miner/ }).waitFor();
if (target !== 'artifact') {
  // Start from a clean seed.
  await page.request.post(`${target}/api/demo/reset`, { headers: { 'X-Demo-Role': 'demo' } });
  await page.reload();
}
await page.getByRole('heading', { name: /Fund part of a managed miner/ }).waitFor();
await shot(page, '01-overview');
step('overview');

await page.getByRole('button', { name: 'View and contribute' }).first().click();
const amount = page.locator('#contrib-amount');
await amount.fill('50');
await page.getByText('The minimum contribution is 100.00 USDC.').waitFor();
await amount.fill('700');
await page.getByText(/Only 600.00 USDC is left to fund/).waitFor();
await amount.fill('12.3456789');
await page.getByText(/at most 6 decimal places/).waitFor();
await amount.fill('600');
await page.getByText('This contribution completes funding.').waitFor();
await shot(page, '02-campaign-contribute');
await page.getByRole('button', { name: 'Contribute 600.00 USDC' }).click();
await toast(page, /Funding is complete/);
await page.getByText('Allocation (frozen)').waitFor();
await shot(page, '03-campaign-funded');
step('contributed and funding closed');

await page.getByRole('button', { name: 'Operator', exact: true }).click();
await page.getByRole('heading', { name: 'Campaign operations' }).waitFor();
await page.getByRole('tab', { name: /C-001/ }).click();
await page.getByRole('button', { name: 'Start campaign' }).click();
await toast(page, /miner healthy/);
step('started');
await page.getByRole('button', { name: '+1 day' }).click();
await toast(page, /Demo clock now/);
await page.getByRole('button', { name: 'Simulate machine failure' }).click();
await toast(page, /automation replaced the machine/);
await shot(page, '04-operator-replaced');
step('failure replaced');
await page.getByRole('button', { name: '+1 day' }).click();
await toast(page, /Demo clock now/);
await page.getByRole('button', { name: 'Simulate machine failure' }).click();
await toast(page, /incident is open/);
await page.locator('.incident').first().waitFor();
await shot(page, '05-operator-incident');
step('incident opened');

await page.getByRole('button', { name: /Add capacity/ }).click();
await toast(page, /is now in the simulated market/);
await page.getByRole('button', { name: 'Retry automated recovery' }).click();
await toast(page, /Recovered on/);
await page.getByRole('button', { name: 'Resolve' }).click();
await toast(page, /resolved/);
step('recovered and resolved');

await page.getByRole('button', { name: '+7 days' }).click();
await toast(page, /Demo clock now/);
await page.locator('#r-kind').selectOption('block_reward');
await page.locator('#r-amount').fill('1000');
await page.getByRole('button', { name: 'Record receipt' }).click();
await toast(page, /Recorded R-001/);
await page.locator('#r-kind').selectOption('airdrop');
await page.locator('#r-amount').fill('4000');
await page.getByRole('button', { name: 'Record receipt' }).click();
await toast(page, /Recorded R-002/);
await page.locator('#r-ref').fill(await page.locator('#r-ref').inputValue()); // fresh ref is generated after each receipt
const dupRef = 'sim-dup-check-1';
await page.locator('#r-ref').fill(dupRef);
await page.getByRole('button', { name: 'Record receipt' }).click();
await toast(page, /Recorded R-003/);
await page.locator('#r-ref').fill(dupRef);
await page.getByRole('button', { name: 'Record receipt' }).click();
await toast(page, /already recorded/);
await shot(page, '06-operator-rewards');
step('receipts recorded; duplicate rejected');

await page.getByRole('button', { name: 'Participant', exact: true }).click();
await page.getByRole('button', { name: 'My positions', exact: true }).click();
await page.getByRole('heading', { name: 'My positions' }).waitFor();
await shot(page, '07-portfolio-before-claim');
await page.getByRole('button', { name: /^Claim / }).click();
await toast(page, /Claimed/);
await page.getByRole('button', { name: 'Nothing to claim' }).waitFor();
await page.getByText('Your locked share becomes claimable only when it unlocks.').waitFor();
await shot(page, '08-portfolio-after-claim');
step('claimed; locked not claimable');

await page.getByRole('button', { name: 'Operator', exact: true }).click();
await page.getByRole('tab', { name: /C-001/ }).click();
await page.getByRole('button', { name: 'Record unlock' }).first().click();
await toast(page, /credited to the campaign/);
await page.getByRole('button', { name: 'End campaign' }).click();
await page.getByRole('button', { name: 'End now and settle' }).click();
await toast(page, /Unused budget returned/);
await shot(page, '09-operator-ended');
step('unlocked and ended');

await page.getByRole('button', { name: 'Participant', exact: true }).click();
await page.getByRole('button', { name: 'My positions', exact: true }).click();
await page.getByRole('button', { name: /^Claim / }).click();
await toast(page, /Claimed/);
await shot(page, '10-portfolio-after-end');
step('claimed unlocked share after campaign end');

await page.getByRole('button', { name: 'Operator', exact: true }).click();
await page.getByRole('button', { name: 'Audit and ledger' }).click();
await page.getByRole('heading', { name: 'Audit log and ledger' }).waitFor();
await page.getByText(/All \d+ ledger checks pass/).waitFor();
await shot(page, '11-audit');
await page.getByRole('tab', { name: 'Ledger balances and checks' }).click();
await shot(page, '12-ledger');
step('audit and ledger');

// Phone width, light and dark.
for (const scheme of ['light', 'dark']) {
  const p = await newPage({ viewport: { width: 390, height: 844 }, colorScheme: scheme, deviceScaleFactor: 2 });
  await p.goto(url('#/campaign/C-002'));
  await p.getByRole('heading', { name: /Campaign 2/ }).first().waitFor();
  await shot(p, `13-phone-campaign-${scheme}`);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) problems.push(`horizontal overflow on phone (${scheme}): ${overflow}px`);
  await p.goto(url('#/portfolio'));
  await p.getByRole('heading', { name: 'My positions' }).waitFor();
  await shot(p, `14-phone-portfolio-${scheme}`);
  await p.goto(url('#/operator/C-001'));
  await p.getByRole('heading', { name: 'Campaign operations' }).waitFor();
  const overflowOp = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflowOp > 1) problems.push(`horizontal overflow on phone operator (${scheme}): ${overflowOp}px`);
  await shot(p, `15-phone-operator-${scheme}`);
}
const dark = await newPage({ colorScheme: 'dark' });
await dark.goto(url('#/operator/C-001'));
await dark.getByRole('heading', { name: 'Campaign operations' }).waitFor();
await shot(dark, '16-operator-dark');

await browser.close();
if (problems.length) {
  console.log('\nProblems:');
  for (const p of problems) console.log(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log(`\nUI journey passed. Screenshots in ${outDir}`);
}
