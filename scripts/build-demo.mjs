// デモを作る：npm run build:demo
//   src/demo/entry.ts を1つのスクリプトにまとめ、demo/template.html の <!--BSCORE--> に、
//   画面のスクリプト demo/app.js を <!--APP--> に埋め込む。
//   demo/dist/bookshelf_hub.html             … claude.ai の Artifact 用（<html> などの外枠なし）
//   demo/dist/bookshelf_hub.standalone.html  … ブラウザで直接開く用（外枠あり）
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const out = await build({
  entryPoints: [join(root, 'src/demo/entry.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  write: false,
  legalComments: 'none',
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const template = readFileSync(join(root, 'demo/template.html'), 'utf8');
if (!template.includes('<!--BSCORE-->')) throw new Error('demo/template.html に <!--BSCORE--> がありません');
if (!template.includes('<!--APP-->')) throw new Error('demo/template.html に <!--APP--> がありません');
const app = readFileSync(join(root, 'demo/app.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
const page = template
  .replace('<!--BSCORE-->', () => `<script>/* BSCore（bookshelf-hub-core から自動生成。直接編集しない） */\n${js}</script>`)
  .replace('<!--APP-->', () => `<script>\n${app}</script>`);

mkdirSync(join(root, 'demo/dist'), { recursive: true });
writeFileSync(join(root, 'demo/dist/bookshelf_hub.html'), page);
writeFileSync(
  join(root, 'demo/dist/bookshelf_hub.standalone.html'),
  `<!doctype html>\n<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n${page}\n</body></html>\n`,
);
console.log(`demo: core ${(js.length / 1024).toFixed(1)} KB, page ${(page.length / 1024).toFixed(1)} KB`);
