# 同事请入缸

色块卡通风多人浏览器水族箱。当前代码与逐阶段实际结果见 `STATUS.md`；脚本或面板存在不等于全部玩法已验收。

## 本地启动

需要 Node.js24 LTS、pnpm9.15.5。在本目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm db:local
pnpm db:migrate
pnpm db:seed
pnpm dev
```

`db:local` 启动真实PostgreSQL17，监听127.0.0.1:55432，数据保存在 `.runtime/postgres`。已有数据库可设置 `DATABASE_URL` 并跳过此步；有Docker也可用 `pnpm db:up`，两种数据库二选一。开发口令只供本机，不能用于生产。

打开 http://127.0.0.1:5173/ ，默认连接API3000和真实数据库。首次建立HttpOnly游客会话并创建一条鱼。另一个浏览器或独立隐私会话创建另一位玩家；同账号新标签页默认观察，可接管控制。

`?preview=1` 是明确标识的本地美术预览，不产生真实经验、余额或库存；`?qa=1` 仅开发模式开放测试对象。单独启动可用 `pnpm dev:web`、`pnpm dev:server`。

操作：点按目的地或按住指针；WASD/方向键移动、空格冲刺、竞技场E护盾；手机有独立摇杆和技能按钮。底部五入口管理角色、投喂、商城、组织和比赛。失焦和面板优先处理输入。

## 检查与部署

`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`pnpm test:e2e`。真实数据库脚本在 `tests/integration/`；截图与追踪在 `artifacts/`。浏览器默认Edge和Chrome。`lint`检查TS/JS，Vue组件由vue-tsc检查。未执行的项目在STATUS明确标注。

30连接混合负载使用显式测试开关，脚本会建立12个测试同事、4个测试鱼群和两场3v3友谊赛，不得指向生产数据库：

```powershell
$env:LOAD_ALLOW_TEST_FIXTURES='1'
$env:LOAD_CLIENTS='30'
$env:LOAD_SECONDS='1800'
pnpm load:smoke
```

浏览器 30 分钟场景/面板耐久脚本默认跳过，显式启用后用两个独立浏览器 context 周期进入友谊赛、返回主缸并切换面板，同时记录 JS 堆、ticker 和实体数：

```powershell
$env:M8_SOAK='1'
$env:M8_SOAK_SECONDS='1800'
pnpm exec playwright test -c tests/e2e/playwright.config.ts tests/e2e/m8.spec.ts
```

不内置管理员口令。运维人员对已有用户运行 `pnpm --filter @aquarium/server exec tsx src/admin.ts promote 用户UUID`；生成单次邀请码使用 `pnpm --filter @aquarium/server exec tsx src/admin.ts invite 员工唯一标识`，明文只在生成时返回。不要把邀请码、Cookie和密钥写入源码或报告。

生产环境变量见 `.env.example`；同域Nginx、单游戏实例、PostgreSQL持久卷及备份说明见 `infra/README.md`。运维脚本为 `pnpm ops:backup -- --out <绝对目录>`、`pnpm ops:restore -- --backup ...` 与 `pnpm ops:monitor`。当前机器无Docker，生产Compose是否实际复现必须查STATUS，配置存在不能替代部署验收。

## 推荐使用方式

1. 解压到准备开发的仓库根目录，保留文档与子目录的相对路径。
2. 先打开 `游戏开发文档.md` 了解完整需求，或使用独立的 HTML 阅读版。
3. 将 `CODEX_START.md` 中的完整开发启动提示词交给 Codex；如希望先看画面，使用其中 M1 提示词。
4. 开发期间让 Codex 持续更新 `STATUS.md`，按 `ACCEPTANCE.md` 提供实际验证结果。

## 文件说明

| 文件 | 用途 |
| --- | --- |
| 游戏开发文档.md | 产品、玩法、UI、成长、经济、组织、团战、架构、数据库、接口、部署和阶段计划 |
| AGENTS.md | 仓库级开发约定，供 Codex 自动读取 |
| CODEX_START.md | 完整启动、M1至M8拆分任务和中断续做提示词 |
| config/game-balance.v1.json | 首轮数值的统一机器可读配置 |
| contracts/protocol.v1.ts | 实时协议、状态、消息、错误码与共享类型起点 |
| ACCEPTANCE.md | 身份、美术、生态、资产、个人赛、团战和运行验收清单 |
| ASSET_LIST.md | 色块卡通角色、场景、配饰、manifest与接入要求 |
| STATUS.md | 各阶段真实实现、验证证据与未完成项 |
| assets/reference/approved-color-block.png | 用户选定的色块卡通主界面参考原图 |

## 规范优先级

已确认的用户需求优先。玩法与工程默认决策以开发文档为准；机器数值以版本化 JSON 为准；接口起点以协议和实际运行时 schema 为准。变更这些规范时同步更新相关文档和验收，避免不同文件描述不同的余额、比赛或权限规则。

原始规范包已扩展为pnpm工作区。源码包括 `apps/web`、`apps/server`、共享规则与协议包、迁移、种子、测试及部署配置。完整交付状态与已知限制始终以STATUS的实际验证记录为准。
