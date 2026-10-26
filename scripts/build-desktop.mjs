import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist/desktop-app');
const sourcePackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const require = createRequire(import.meta.url);
const sqlitePackage = JSON.parse(await readFile(require.resolve('better-sqlite3/package.json'), 'utf8'));

// 只从明确列出的资源生成安装内容，个人配置、数据库和日志不进入打包目录。
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  entryPoints: [join(root, 'src/desktop/main.ts')],
  outfile: join(output, 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['electron', 'better-sqlite3'],
  // 少数 CommonJS 依赖仍使用 require；只为打包后的 Node 入口提供标准解析器。
  banner: { js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);" },
});
await cp(join(root, 'dist/web'), join(output, 'web'), { recursive: true });
await cp(join(root, 'src/store/migrations'), join(output, 'migrations'), { recursive: true });
await cp(join(root, 'docs/assets/branding/icon.png'), join(output, 'icon.png'));
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  await cp(join(root, name), join(output, name));
}

/** 复制原生模块及其明确依赖，解开 pnpm 链接，使安装包可以脱离源码目录运行。 */
async function copyDependency(name, fromRequire, destination) {
  const packagePath = fromRequire.resolve(`${name}/package.json`);
  const packageRoot = dirname(packagePath);
  const metadata = JSON.parse(await readFile(packagePath, 'utf8'));
  const target = resolve(destination, 'node_modules', name);
  await cp(packageRoot, target, {
    recursive: true,
    dereference: true,
    filter: (path) => path !== join(packageRoot, 'node_modules'),
  });
  const dependencyRequire = createRequire(packagePath);
  for (const dependency of Object.keys(metadata.dependencies ?? {})) {
    await copyDependency(dependency, dependencyRequire, target);
  }
}

await copyDependency('better-sqlite3', require, output);
await writeFile(join(output, 'package.json'), `${JSON.stringify({
  name: sourcePackage.name,
  version: sourcePackage.version,
  description: sourcePackage.description,
  author: sourcePackage.author,
  homepage: sourcePackage.homepage,
  desktopName: sourcePackage.desktopName,
  license: sourcePackage.license,
  type: 'module',
  main: 'main.mjs',
  // 临时目录采用普通 node_modules 布局，避免打包器回到源码目录收集全部依赖。
  packageManager: `npm@${execSync('npm --version', { encoding: 'utf8' }).trim()}`,
  dependencies: { 'better-sqlite3': sqlitePackage.version },
  devDependencies: { electron: sourcePackage.devDependencies.electron },
}, null, 2)}\n`);
console.log(`桌面应用内容已生成：${output}`);
