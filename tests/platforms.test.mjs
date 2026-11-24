import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();

function loadTs(relPath, mocks = {}) {
  const fullPath = path.join(ROOT, relPath);
  const source = fs.readFileSync(fullPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const mod = { exports: {} };
  const fn = new Function("require", "module", "exports", outputText);
  fn((id) => (id in mocks ? mocks[id] : require(id)), mod, mod.exports);
  return mod.exports;
}

const platforms = loadTs("src/lib/platforms.ts");
const media = loadTs("src/lib/media.ts", { "@/lib/platforms": platforms });
const types = loadTs("src/lib/extractors/types.ts", {
  "@/lib/platforms": platforms,
});
const normalizer = loadTs("src/lib/url-normalizer.ts", {
  "@/lib/platforms": platforms,
});
const extractors = loadTs("src/lib/extractors/index.ts", {
  "@/lib/media": media,
  "@/lib/platforms": platforms,
  "@/lib/url-normalizer": normalizer,
  "@/lib/extractors/types": types,
});

test("所有已注册平台的配置完整且包含有效图标背景色", () => {
  assert.ok(platforms.PLATFORM_RULES.length >= 7);
  const ids = new Set();
  for (const rule of platforms.PLATFORM_RULES) {
    assert.ok(rule.id && !ids.has(rule.id), `重复或空的平台 ID: ${rule.id}`);
    ids.add(rule.id);
    assert.ok(rule.label, `${rule.id} 缺少 label`);
    assert.ok(rule.mark, `${rule.id} 缺少 mark`);
    assert.match(
      rule.tileBg,
      /^(#[0-9a-fA-F]{3,8}|linear-gradient\(.+\))$/,
      `${rule.id} 的 tileBg 必须是显式颜色值或渐变，避免 Tailwind 裁剪`
    );
    assert.match(
      rule.homeUrl,
      /^https:\/\/.+/,
      `${rule.id} 缺少合法的 https homeUrl`
    );
    assert.ok(rule.domains.length > 0, `${rule.id} 缺少 domains`);
  }
});

test("分享文案 URL 提取兼容中英文口令与紧贴中文字符", () => {
  const cases = [
    [
      "78 博主发布小红书😆http://xhslink.com/a/abc123【点击查看】",
      "http://xhslink.com/a/abc123",
    ],
    [
      "【B站视频】https://b23.tv/BV1xx411c7mD，快来看！",
      "https://b23.tv/BV1xx411c7mD",
    ],
    [
      "Watch this: https://youtu.be/dQw4w9WgXcQ?si=abc123)",
      "https://youtu.be/dQw4w9WgXcQ?si=abc123",
    ],
    [
      "Check https://x.com/user/status/1234567890123456789.",
      "https://x.com/user/status/1234567890123456789",
    ],
  ];

  for (const [input, expected] of cases) {
    assert.equal(platforms.extractUrlFromText(input), expected);
  }
});

test("已有 5 个国际平台回归校验：路由、标签、参数与无直连超时", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("国际平台短链不应触发服务端无代理 fetch");
  };

  try {
    const cases = [
      {
        url: "https://youtu.be/dQw4w9WgXcQ",
        id: "youtube",
        extractorKey: "Youtube",
        expectedLabel: "YouTube",
      },
      {
        url: "https://vm.tiktok.com/ZM8xxxxxx/",
        id: "tiktok",
        extractorKey: "TikTok",
        expectedLabel: "TikTok",
      },
      {
        url: "https://t.co/abcdef1234",
        id: "x",
        extractorKey: "Twitter",
        expectedLabel: "X / Twitter",
      },
      {
        url: "https://fb.watch/abcdef1234/",
        id: "facebook",
        extractorKey: "Facebook",
        expectedLabel: "Facebook",
      },
      {
        url: "https://www.instagram.com/reel/C123456789/",
        id: "instagram",
        extractorKey: "Instagram",
        expectedLabel: "Instagram",
      },
    ];

    for (const item of cases) {
      const normalized = await normalizer.normalizeMediaUrl(item.url);
      assert.equal(normalized.platform?.id, item.id);
      assert.equal(normalized.platform?.region, "global");
      assert.equal(normalized.normalizedUrl, item.url);
      assert.equal(
        platforms.resolvePlatformLabel(item.extractorKey, item.url),
        item.expectedLabel
      );

      const cmd = await extractors.prepareDownloadCommand({
        url: item.url,
        formatType: "best",
        formatArgs: extractors.resolveFormatArgs("best"),
        cookie: null,
        network: { cnDirect: true },
      });
      assert.ok(!cmd.args.includes("--proxy"), `${item.id} 默认不应注入 --proxy`);
      assert.ok(
        !cmd.args.includes("--impersonate"),
        `${item.id} 不应注入 --impersonate`
      );
      assert.equal(cmd.args.at(-1), item.url);
    }

    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("国内平台 URL 规范化、强制直连与指纹参数校验", async () => {
  // B 站保留分 P 并去除追踪参数
  const bili = await normalizer.normalizeMediaUrl(
    "https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333&p=2&vd_source=abc"
  );
  assert.equal(
    bili.normalizedUrl,
    "https://www.bilibili.com/video/BV1xx411c7mD?p=2"
  );

  // 小红书保留 xsec_token，且验证国内直连与指纹伪装参数
  const xhs = await normalizer.normalizeMediaUrl(
    "https://www.xiaohongshu.com/discovery/item/65abc123def?xsec_token=TOK123&xsec_source=pc&noise=1"
  );
  assert.equal(
    xhs.normalizedUrl,
    "https://www.xiaohongshu.com/explore/65abc123def?xsec_token=TOK123&xsec_source=pc"
  );

  const xhsCmd = await extractors.prepareDownloadCommand({
    url: xhs.normalizedUrl,
    formatType: "1080p",
    formatArgs: extractors.resolveFormatArgs("1080p"),
    cookie: "chrome",
    network: { cnDirect: true },
  });
  const proxyIdx = xhsCmd.args.indexOf("--proxy");
  assert.ok(proxyIdx >= 0 && xhsCmd.args[proxyIdx + 1] === "");
  assert.ok(xhsCmd.args.includes("--impersonate"));
  const cookieIdx = xhsCmd.args.indexOf("--cookies-from-browser");
  assert.ok(cookieIdx >= 0 && xhsCmd.args[cookieIdx + 1] === "chrome");
});

test("国内直连开关控制代理参数", () => {
  assert.deepEqual(media.buildProxyArgs("cn", { cnDirect: true }), [
    "--proxy",
    "",
  ]);
  assert.deepEqual(media.buildProxyArgs("cn", { cnDirect: false }), []);
  assert.deepEqual(media.buildProxyArgs("global", { cnDirect: true }), []);
});

test("Cookie 读取报错精确区分 Safari 权限拦截与其他浏览器路径缺失", () => {
  const safariHint = media.cookieErrorHint("could not find safari cookies database");
  assert.ok(safariHint && safariHint.includes("完全磁盘访问权限"));

  const chromeHint = media.cookieErrorHint(
    'could not find chrome cookies database in "/Users/test/Library/Application Support/Google/Chrome"'
  );
  assert.ok(
    chromeHint &&
      chromeHint.includes("Google/Chrome") &&
      chromeHint.includes("Edge")
  );

  // 非 Cookie 相关的 no such file 不应被误判为浏览器 Cookie 数据库缺失
  assert.equal(media.cookieErrorHint("No such file or directory: /tmp/foo.mp4"), null);
});

test("多来源视频时长解析（数字/字符串/duration_string/分片汇总）", () => {
  assert.equal(extractors.parsePositiveSeconds(42.6), 43);
  assert.equal(extractors.parsePositiveSeconds("18.2"), 18);
  assert.equal(extractors.parsePositiveSeconds(0.4), 1);
  assert.equal(extractors.parsePositiveSeconds(0), null);

  assert.equal(extractors.parseDurationString("0:45"), 45);
  assert.equal(extractors.parseDurationString("1:23"), 83);
  assert.equal(extractors.parseDurationString("1:02:03"), 3723);
  assert.equal(extractors.parseDurationString("invalid"), null);

  // 支持从 duration_string 提取
  assert.equal(
    extractors.extractDurationFromMetadata({ duration_string: "2:15" }, {}),
    135
  );

  // 支持从 HLS/DASH fragments 汇总时长
  assert.equal(
    extractors.extractDurationFromMetadata(
      {
        formats: [
          {
            fragments: [{ duration: 10.2 }, { duration: 10.4 }, { duration: 5.1 }],
          },
        ],
      },
      {}
    ),
    26
  );
});
