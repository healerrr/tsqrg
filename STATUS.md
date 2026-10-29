# 开发进度

已从规范包建立 pnpm workspace，开始逐阶段实现。以下仅记录实际实现与验证；完整第一版尚未交付。

| 阶段 | 状态 | 验证证据 |
| --- | --- | --- |
| M1 美术和可操作主缸 | 功能验收通过，完整美术随最终复查 | Edge / Chrome 10/10：六型、位移、冲刺、失焦、面板隔离和3尺寸 |
| M2 身份和真实联机 | 验收通过 | PostgreSQL17、7组DB、Edge/Chrome4/4、实例UUID变化的异常重启恢复 |
| M3 生态和成长 | 验收通过 | 11组真实DB检查；Edge/Chrome2/2补给、投食与钱包UI |
| M4 商城和自定义 | 验收通过 | PostgreSQL/HTTP 14组；Edge/Chrome 2/2；独立渲染11项 |
| M5 个人 PK | 验收通过 | PostgreSQL 11组；Edge/Chrome 2/2；权威技能、断线恢复与幂等结算 |
| M6 组织和群游 | 验收通过 | PostgreSQL 10组；Edge/Chrome 2/2；三会话权威群游与账目 |
| M7 组织团战 | 未开始 | 待六客户端正式团战 |
| M8 完整验收和部署 | 未开始 | 待兼容、负载与恢复验证 |

## 下一步

继续M7组织团战。主缸入口 http://127.0.0.1:5173/ 默认真实联机；`?preview=1` 才是本地美术预览。

## 2026-10-27 · M1

- 建立根工作区、Web 工程和共享 core/protocol/ui-tokens；保留原规范、配置和参考图。原目录没有 Git 元数据或游戏源码。
- Vue 管理中文 HUD、底部五入口、面板、六鱼型/配色和试穿；PixiJS 管理独立鱼体/尾鳍/表情/配饰、分层场景、食物、冲刺/护盾及动画。参考图没有作为生产背景使用。
- 自制矢量美术与锚点见 `assets/manifest.v1.json`、`assets/SOURCES.md`。六鱼型目前达到可辨认基础方向，仍需最终逐鱼型、所有配饰与状态的视觉复查，不宣称完整美术验收通过。
- 实际命令：`pnpm install` 成功；`pnpm test` 27/27 通过；core、protocol、web 的 typecheck 通过；`pnpm exec eslint apps/web/src/game` 通过。
- `pnpm dev:web` 在沙箱内因 esbuild 目录祖先读取权限失败；经执行工具审批后在沙箱外正常启动，HTTP 200。此为当前执行环境限制，非项目依赖错误。
- `node tests/m1-check.mjs` 通过：Edge 1440×900、844×390、390×844，操作移动、空格冲刺、切换河豚，页面错误为 0。截图 `artifacts/m1/`。当前测试尚未断言物理位移数值，后续补充。
- 初始手机竖屏留空过大，已实现竖屏跟随摄像机并通过 typecheck；修改后截图尚待重跑。
- 本机 Node 24.12.0、pnpm 9.15.5；未找到 Docker 或 PostgreSQL 服务。正在安装可放入项目目录运行的真实 PostgreSQL17，不使用内存数据替代事务验收。

## 每次更新格式

### M1 补充验证（2026-10-27）

- 软件WebGL低帧率下预览步长被视觉delta上限拖慢，已改独立30Hz控制与固定步长累计。
- 实际M1 Playwright最终10/10通过（Edge5、Chrome5，约3.4分钟）：600ms真实位移、冲刺、失焦停止、面板输入隔离、六型切换与1280×720/844×390/390×844坐标。
- 结果 `artifacts/m1/e2e-results.json`，截图 `artifacts/m1/e2e/`。竖屏摄像机已实际截图。
- `pnpm build`通过；初次生产主chunk gzip190.16KB，总关键JS低于800KB目标；未压缩主chunk超过500KB提示仍存在，此结果不等于性能验收。
- 新增6项运动预测测试通过。手机虚拟摇杆、独立试穿预览与贴图引用清理已接入。

### M2 验证中（2026-10-27）

- 真实PostgreSQL17.10已在55432运行，持久数据 `.runtime/postgres`。迁移、种子、server typecheck成功；API3000 health/ready就绪。
- 已实现游客HttpOnly会话、邀请码单次绑定、一账号一鱼、一次新手奖励、统一幂等事务、单模拟实例锁、30Hz权威移动、10Hz快照、20Hz输入和控制租约。
- `pnpm exec tsx tests/integration/m2.ts` 7项通过：独立会话、一鱼、新手重试唯一、payload冲突、邀请码并发唯一、查询恢复、真实流水平衡。
- Edge双context互看移动/刷新恢复/租约通过。Chrome租约通过，双context曾遇PG新连接5秒超时，已调整连接池并复测。异常重启恢复须证明实例UUID变化并核对数据，尚未计为通过。

### M2 最终结果

- 最终Edge/Chrome双context与控制租约4/4通过，`artifacts/m2/e2e-results.json` 与双视角截图为证。
- 真正强停旧进程后重启，实例UUID已变化；浏览器Cookie仅留内存，账号、鱼、XP、外观、余额和冻结一致。记录 `artifacts/m2/server-restart.json`、`after-server-restart.png`。早期超时不能证明重启的无效记录已作废，未计通过。
- 首实例运行时启动第二服务，明确拒绝并exit1，原服务继续运行；此仅覆盖OPS04单实例子项。

### M3（2026-10-27）

- 已挂接真实生态、每日补给、随机投食、手动投食、三类NPC、成长与真实排行榜。30Hz循环只标记CLAIM_PENDING，异步以唯一source事务发收益，提交不明时保留待确认并按来源重试。
- `0002`迁移成功，增加日限额数据库约束和持久投食批次。补充落速、主缸判定半径、NPC速度等统一配置参数，不改变既定货币、权限或押注规则。
- `pnpm exec tsx tests/integration/m3.ts` 11组通过：来源并发唯一、补给10次重试、295/79截断至300/80、上海跨日、30级封顶、同tick争食、活跃资格、投食幂等、满缸不扣次数、五次/落点校验、流水零和及日额度约束。
- `pnpm exec playwright test -c tests/e2e/playwright.config.ts --grep M3 --output artifacts/m3/e2e` Edge/Chrome2/2通过（20.3秒）。真实80XP/20战力到账及重试提示、服务端食物快照、Lv2和B/C/H/A面板已截图并目视复查；证据 `artifacts/m3/e2e-results.json`。
- 低画质、静态场景缓存、三类NPC独立轮廓已接入。硬件NVIDIA Quadro M2000M/ANGLE D3D11六鱼1280×720 DPR2实测约60FPS、P95 16.8—17.8ms；强制SwiftShader约1.4—1.6FPS，两者均有原始记录。这些4秒段不代表30连接或30分钟验收通过。

### M4（2026-10-28）

- 已实现真实商品目录、试穿、购买、永久衣橱、穿戴/脱下、配色/鱼型/花纹保存，以及受保护的自定义贴图上传与读取。购买使用统一幂等事务，按 `A=C-H` 校验可用额度；库存唯一、账本平衡和外观版本由数据库约束与事务保证。
- `pnpm exec tsx tests/integration/m4.ts` 在真实 PostgreSQL 17 上 14 组通过：Lv11 账目、同键十次重试、同键换商品冲突、同商品并发、最后余额竞争、真实冻结不可消费、衣橱/版本/准备期外观锁、PNG→WebP/1024边长/去元数据、异常文件拒绝、贴图归属与同场景授权、真实 HTTP/multipart 边界。结束时全库冻结与 hold 一致、流水净和为 0、库存无重复。
- `node_modules/@playwright/test/cli.js test -c tests/e2e/playwright.config.ts --grep 'M4 商城'` 在 Edge/Chrome 2/2 通过（31.4秒）：模拟购买成功响应丢失后以同一幂等键重试，只扣一次；试穿取消不入库；耳机永久穿戴；上传后未保存不生效，保存并刷新后 WebP 贴图和衣橱均恢复；伪装图片被拒绝。证据 `artifacts/m4/e2e-results.json` 与 `artifacts/m4/e2e/`。
- `node tests/m4-rendering.mjs http://127.0.0.1:5173` 11项通过：六种鱼型使用精确身体遮罩显示上传贴图、内部配饰随方向翻转且昵称不翻转、10次权威快照不冲掉本地试穿、竞技场拒绝本地覆盖、异步取消/失败回退、共享纹理引用和最终 ticker/实体/缓存清理。证据 `artifacts/m4/rendering/renderer-qa.json` 与六鱼型截图。
- 修复 Pixi 多应用销毁：主缸和 `FishPreview` 不再通过 `destroy(true, …)` 提前释放全局纹理池，避免关闭试穿预览后其他鱼的文字或贴图资源被二次释放。Web `vue-tsc` 与相关 ESLint 均通过。

### M5（2026-10-28）

- 已实现个人友谊赛和正式赛的邀请、接受、S 报价与重确认、双方准备、原子冻结、3 秒倒计时、30 秒服务端权威竞技、认输、断线宽限、结果查询和历史。竞技 HUD 显示生命、阶段、时间、技能冷却和重连状态；结算后保留真实余额变化。
- `C:\nvm\v24.12.0\node.exe --import tsx tests/integration/m5.ts` 在真实 PostgreSQL 17 上 11 组通过：S=20 双边冻结、条件变化不留单边冻结、低余额回退友谊赛、护盾/冷却/扫掠碰撞、十次结算只转移一次、平局/认输、单双方断线、旧实例恢复、正式次数/同对手限制、跨日归属和全库流水/冻结/配额约束。
- Edge/Chrome 两个独立 context 2/2 通过（58.4 秒）：双方独立确认 S=20，权威移动、护盾和实际扣血可见，B 认输后 A +20、B -20，冻结归零；DB 只有一个结果和一次结算流水。证据 `artifacts/m5/e2e-results.json`、`artifacts/m5/e2e/**/authoritative-hit-and-hud.png`、`winner-settlement.png` 与 `loser-settlement.png`。
- 最终复跑 Server TypeScript、Web `vue-tsc`、33 项规则测试和相关 Server/协议/测试 ESLint 均通过。现有 ESLint 配置忽略 `.vue`，不把 Vue 文件记为 ESLint 已覆盖；它们由 `vue-tsc` 检查。
- 验收记录见 `tests/acceptance/M5-2026-10-28.md`。M6 组织与群游、M7 六人团战及 M8 运维验收仍未完成。

### M6（2026-10-28）

- 已实现 8 人鱼群组织、创建扣款、申请/邀请与本人接受、组织长/管理员/成员权限、原子转让、退出/移除冷却、比赛锁、自愿捐献、组织钱包、公共旗帜、统一尾迹、组织内部流水与解散归档。写操作使用幂等键，个人与组织资产变动使用真实事务和守恒流水。
- 已实现服务器权威群游：领游者手动移动时队伍跟随；跟随成员手动输入立即脱队；松散队形包含软分离、追赶和停止后的巡游；领游断线 5 秒后按加入时间接替。快照携带 `followLeaderFishId` 与 `guildMark`，主缸真实渲染公共旗帜、统一尾迹和组织名徽章，个人形象保留。
- `C:\nvm\v24.12.0\node.exe --import tsx tests/integration/m6.ts` 在真实 PostgreSQL 17 上 10 组通过：第 8 席并发竞争、权限与转让、捐献重试、公共资产、并发购买、退出冷却、比赛锁、三运行时群游、解散限制及全库账目约束。
- Edge/Chrome 三个独立 context 2/2 通过（70.6 秒）：申请加入、邀请与本人接受、捐献 600、购买并启用 200 点旗帜和 300 点统一尾迹、余额/流水、三鱼权威群游、手动脱队和领游断线接替。证据 `artifacts/m6/e2e-results.json` 与 `artifacts/m6/e2e/`，六张截图已目视复查。
- 最终复跑 Server TypeScript、Protocol TypeScript、Web `vue-tsc`、33 项规则测试和相关 ESLint 均通过。回归中移除了 `leaveGuild` 的一个未使用局部变量，不改变业务行为。验收记录见 `tests/acceptance/M6-2026-10-28.md`。
- M7 六人团战与 M8 运维验收仍未完成；当前 `MatchService` 尚未开放 TEAM 模式，避免把未验收路径暴露为可用功能。

记录日期、所完成阶段、改变的文件、实际运行命令、运行结果、人工验证证据、尚未完成的事项以及下一步。项目原有规则调整也在这里记录，不把尚未实现的需求标为完成。
