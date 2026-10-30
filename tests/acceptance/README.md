# 实际验收记录

这里只保存实际运行获得的记录。阶段状态以根目录 `STATUS.md` 为准；脚本存在不代表已经通过。

## 可重复命令

先启动真实 PostgreSQL、执行迁移与种子并启动 Vite/游戏服务器，再运行：

```powershell
pnpm test
pnpm exec playwright test -c tests/e2e/playwright.config.ts --grep M1
pnpm exec playwright test -c tests/e2e/playwright.config.ts --grep M2
pnpm load:smoke
```

默认浏览器项目为本机 Edge 和 Chrome。可通过 `AQUARIUM_BROWSER_CHANNELS=msedge` 选一个浏览器，或者安装 Playwright Chromium 后设为 `chromium`。浏览器不可用时应记录失败或未执行，不静默跳过。

默认使用浏览器正常的硬件 WebGL。只有显式设置 `AQUARIUM_SOFTWARE_WEBGL=1` 才强制 SwiftShader；软件渲染记录不能作为设备正常帧率的结论。

环境参数：`AQUARIUM_WEB_URL` 默认 `http://127.0.0.1:5173`，`AQUARIUM_API_URL` 默认 `http://127.0.0.1:3000`。开发 QA 入口只在 Vite 开发模式加 `qa=1` 时开放。M1 使用 `preview=1`，真实联机路径不传该参数。

Playwright 输出在 `artifacts/e2e/`，包含 JSON 结果和阶段截图。默认关闭 trace，避免把认证 Cookie 保存在调试包中；`AQUARIUM_TRACE=1` 只允许在本地显式诊断，不作为交付附件，联机用例始终关闭 trace。负载报告在 `artifacts/load/`。负载脚本默认仅测公共缸；显式设置 `LOAD_ALLOW_TEST_FIXTURES=1`、至少 30 个连接且采集至少 8 秒时，会通过真实接口准备两场 3v3 友谊赛。该模式会创建测试身份和鱼群，仅用于隔离测试数据库。脚本存在或完成普通主缸烟测，不代表混合负载、桌面 FPS 或 30 分钟内存验收通过。

每份阶段记录须写明日期、浏览器、分辨率、服务端及数据库版本、配置版本、命令、实际结果、截图路径、失败或未执行项。接口返回的账号 ID 可以留作核对；Cookie、邀请码和密钥不得写入记录。
