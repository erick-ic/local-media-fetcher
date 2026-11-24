#!/usr/bin/env node
/**
 * 真实链接快速冒烟巡检脚本（仅调用 /api/parse，不落盘下载视频）：
 * 1. 先启动本地服务：npm run dev
 * 2. 复制 scripts/smoke-urls.example.json 为 scripts/smoke-urls.local.json 并填入你想回归验证的链接
 * 3. 运行：npm run smoke
 */
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3001";
const COOKIE = process.env.SMOKE_COOKIE || undefined; // 例如 SMOKE_COOKIE=safari

const localPath = path.join(process.cwd(), "scripts/smoke-urls.local.json");
const examplePath = path.join(process.cwd(), "scripts/smoke-urls.example.json");
const targetPath = fs.existsSync(localPath) ? localPath : examplePath;

const entries = JSON.parse(fs.readFileSync(targetPath, "utf8"));
if (!Array.isArray(entries) || entries.length === 0) {
  console.error(`未在 ${targetPath} 中找到测试链接`);
  process.exit(1);
}

console.log(`使用用例文件: ${path.relative(process.cwd(), targetPath)}`);
console.log(`目标服务: ${BASE_URL} | Cookie: ${COOKIE ?? "关闭"}\n`);

let failed = 0;
const results = [];

for (const item of entries) {
  if (!item?.url || item.skip) {
    results.push({
      平台: item?.name || "未命名",
      结果: "SKIP",
      耗时: "-",
      画质数: "-",
      说明: item?.reason || "已跳过",
    });
    continue;
  }

  const started = Date.now();
  try {
    const response = await fetch(`${BASE_URL}/api/parse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: item.url,
        browserCookie: item.cookie ?? COOKIE,
        network: { cnDirect: true },
      }),
    });
    const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;
    const data = await response.json().catch(() => null);

    if (response.ok && data?.ok) {
      results.push({
        平台: item.name,
        结果: "PASS",
        耗时: elapsed,
        画质数: data.media?.presets?.length ?? 0,
        说明: String(data.media?.title || "").slice(0, 28),
      });
    } else {
      failed += 1;
      results.push({
        平台: item.name,
        结果: "FAIL",
        耗时: elapsed,
        画质数: 0,
        说明: String(data?.message || `HTTP ${response.status}`).slice(0, 42),
      });
    }
  } catch (error) {
    failed += 1;
    results.push({
      平台: item.name,
      结果: "ERROR",
      耗时: `${((Date.now() - started) / 1000).toFixed(1)}s`,
      画质数: 0,
      说明: error instanceof Error ? error.message : String(error),
    });
  }
}

console.table(results);
if (failed > 0) process.exit(1);
