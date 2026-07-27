import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const dist = resolve('dist/assets');
const assets = await readdir(dist);

const budgets = [
  { label: 'workbench entry', pattern: /^index-[^.]+\.js$/, limit: Number(process.env.CURSEM_ENTRY_BUDGET_BYTES) || 500_000 },
  { label: 'Monaco editor API', pattern: /^editor\.api2-[^.]+\.js$/, limit: Number(process.env.CURSEM_EDITOR_API_BUDGET_BYTES) || 4_000_000 },
  { label: 'TypeScript worker', pattern: /^ts\.worker-[^.]+\.js$/, limit: Number(process.env.CURSEM_TS_WORKER_BUDGET_BYTES) || 7_500_000 },
  { label: 'CSS worker', pattern: /^css\.worker-[^.]+\.js$/, limit: Number(process.env.CURSEM_CSS_WORKER_BUDGET_BYTES) || 1_200_000 },
  { label: 'HTML worker', pattern: /^html\.worker-[^.]+\.js$/, limit: Number(process.env.CURSEM_HTML_WORKER_BUDGET_BYTES) || 800_000 },
];

for (const budget of budgets) {
  const matches = assets.filter((name) => budget.pattern.test(name));
  if (matches.length !== 1) throw new Error(`Expected one ${budget.label} bundle, found ${matches.length}.`);
  const bytes = (await stat(join(dist, matches[0]))).size;
  if (bytes > budget.limit) throw new Error(`${budget.label} bundle is ${bytes} bytes; budget is ${budget.limit}.`);
  process.stdout.write(`Bundle budget PASS: ${budget.label} ${matches[0]} is ${bytes} bytes (limit ${budget.limit}).\n`);
}

const logo = resolve('dist/brand/cursem-official.png');
const logoBytes = (await stat(logo)).size;
const logoLimit = Number(process.env.CURSEM_LOGO_BUDGET_BYTES) || 2_000_000;
if (logoBytes > logoLimit) throw new Error(`Official CURSEM logo is ${logoBytes} bytes; budget is ${logoLimit}.`);
process.stdout.write(`Bundle budget PASS: official CURSEM logo is ${logoBytes} bytes (limit ${logoLimit}).\n`);
