# 启动、部署与运维

源码要求 Node.js 24 LTS、pnpm 9.15.5、PostgreSQL 17。业务时区固定 Asia/Shanghai，数值版本来自 `config/game-balance.v1.json`。

## 本地开发

```powershell
pnpm install --frozen-lockfile
docker compose -f infra/compose.dev.yml up -d db
pnpm db:migrate
pnpm db:seed
pnpm dev
```

本机没有 Docker 时，可使用项目提供的 `infra/dev-db.ts` 启动真实 PostgreSQL 17 开发集群（具体根脚本以 `package.json` 为准）。两种方式二选一，同一端口不要同时启动两套数据库。开发数据放在 `.runtime/` 或 Docker 持久卷；不能把这些目录作为生产数据库或交付源码。

默认 Web 为 `http://127.0.0.1:5173`，服务器为 `http://127.0.0.1:3000`，本地数据库为 `127.0.0.1:55432/aquarium`。Vite 将 API、上传与 Socket.IO 代理到游戏服务器。`?preview=1` 是明确标识的 M1 本地美术预览；默认入口连接真实服务器。`?qa=1` 的调试对象仅开发模式存在。

## 生产部署

`infra/compose.yml` 使用 PostgreSQL 17.6、一个持续运行的 Node.js 24.12.0 游戏实例和 Nginx 1.28.0。服务镜像在构建时执行锁文件安装和 Web 构建，启动时执行版本化迁移及商品种子。

1. 在服务器设置 `POSTGRES_PASSWORD`、`SESSION_SECRET`、`OPS_METRICS_TOKEN` 和 `APP_ORIGIN`。密钥用密码管理器生成；会话密钥至少 32 字节、监控令牌至少 24 字节，不使用开发值。数据库密码进入连接 URL，特殊字符须按 URL 规则编码，或使用仅含安全字母、数字和下划线的随机密码。
2. `APP_ORIGIN` 填最终 HTTPS 同域地址，例如 `https://fish.example.com`，不带尾斜杠。前端不接收数据库或会话密钥。
3. 执行 `docker compose -f infra/compose.yml build` 和 `docker compose -f infra/compose.yml up -d`。
4. 在宿主机 TLS 反向代理或公司网关将该域名转发到 `127.0.0.1:8080`，保留 Host、Origin 和 WebSocket Upgrade。生产 HttpOnly Cookie 使用 Secure，必须经 HTTPS 访问。内置 Nginx 只监听容器 HTTP，并将宿主端口限制在回环。
5. 访问 `/api/v1/health/live` 和 `/api/v1/health/ready`。readiness 必须在数据库可用、唯一模拟实例锁取得、旧冻结恢复之后才成功。

生产启动会在连接数据库前校验全部必要环境变量：`APP_ORIGIN` 必须是无额外路径的 HTTPS 来源，`UPLOAD_DIR` 必须是非根目录绝对路径，业务时区固定为 `Asia/Shanghai`，`RULES_VERSION` 必须与构建内配置一致，端口与日志级别必须有效。任何一项缺失或不一致都会直接拒绝启动，不回退到开发默认值。

`OPERATIONS_CHECK_INTERVAL_MS` 允许 10000—3600000 的整数，默认 60000；`SHUTDOWN_DRAIN_MS` 允许 0—35000，默认 35000。无效计时参数会拒绝启动。容器在迁移和种子完成后直接以 Node 作为主进程接收 SIGTERM，配合 45 秒停止宽限执行比赛排空。

Docker 生产配置未在当前无 Docker 的 Windows 环境执行；不能仅凭配置文件存在将 OPS03 标为通过。首次生产使用前须按本节从空数据库复现、确认迁移/种子和同域上传、HTTP、WebSocket，并记录结果。

不要将 `game` 扩容为多个权威实例。数据库 advisory lock 作为最后防线拒绝第二实例，主锁丢失时应停止资产写入并使 readiness 失败。没有房间调度的首版不支持多节点并行模拟。

## 健康、日志与发布

日志保留 requestId、userId、matchId、错误码、操作来源、状态码和耗时，隐藏 Cookie、邀请码明文和密钥。`Authorization: Bearer $OPS_METRICS_TOKEN` 可读取 `/metrics` 的 Prometheus 文本；`pnpm ops:monitor -- --seconds 1800 --interval 5` 可保存趋势报告。至少持续监测 HTTP 请求/错误、tick P95、连接数、内存、失败购买、冻结总额、待结算比赛年龄、outbox 积压和数据库连接池。公共缸负载烟测为 `pnpm load:smoke`，其报告明确记录尚未覆盖的性能目标。

发布前备份数据库和上传目录。先停止接新邀请与准备，短比赛有界排空；剩余比赛由服务器系统中止并退款。`stop_grace_period` 设为 45 秒。重启后必须先恢复未完成比赛，已提交的最终结果不再退款。不要直接删除 wallet_holds 或修改余额来清除准备状态。

## 备份与恢复演练

数据库和上传文件必须作为一套备份保存，至少每日一次、保留最近七份，并在发布前另存一份。推荐从能访问数据库和上传目录的 Node.js 24 运维主机执行：

```powershell
$env:DATABASE_URL='postgresql://aquarium:...@127.0.0.1:5432/aquarium'
$env:UPLOAD_DIR='D:\aquarium\uploads'
pnpm ops:backup -- --out 'D:\aquarium\backups'
```

备份脚本在同一数据库会话持有资产写 advisory lock，执行 PostgreSQL 17 自定义格式备份、复制数据库引用的上传文件并生成 SHA256 manifest；不会自动删除旧备份。恢复脚本只允许创建名为 `aquarium_restore_*` 的全新数据库和全新上传目录，不执行 DROP 或覆盖：

```powershell
$env:RESTORE_ADMIN_URL='postgresql://postgres:...@127.0.0.1:5432/postgres'
pnpm ops:restore -- --backup 'D:\aquarium\backups\aquarium-...' --database aquarium_restore_drill_01 --uploads 'D:\aquarium\restore-uploads-01'
```

恢复完成后脚本会重新核对行数、钱包/上传指纹和基础账目不变量，并写出恢复报告。随后使用新环境密钥启动该隔离实例、等待 readiness，并进行人工抽查；绝不能把恢复目标指向生产现库。

本文件提供演练步骤；没有实际执行演练的记录前，OPS05 状态为未执行。

