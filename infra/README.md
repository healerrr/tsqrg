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

1. 在服务器设置 `POSTGRES_PASSWORD`、`SESSION_SECRET` 和 `APP_ORIGIN`。密钥用密码管理器生成；会话密钥至少 32 字节，不使用开发值。数据库密码进入连接 URL，特殊字符须按 URL 规则编码，或使用仅含安全字母、数字和下划线的随机密码。
2. `APP_ORIGIN` 填最终 HTTPS 同域地址，例如 `https://fish.example.com`，不带尾斜杠。前端不接收数据库或会话密钥。
3. 执行 `docker compose -f infra/compose.yml build` 和 `docker compose -f infra/compose.yml up -d`。
4. 在宿主机 TLS 反向代理或公司网关将该域名转发到 `127.0.0.1:8080`，保留 Host、Origin 和 WebSocket Upgrade。生产 HttpOnly Cookie 使用 Secure，必须经 HTTPS 访问。内置 Nginx 只监听容器 HTTP，并将宿主端口限制在回环。
5. 访问 `/api/v1/health/live` 和 `/api/v1/health/ready`。readiness 必须在数据库可用、唯一模拟实例锁取得、旧冻结恢复之后才成功。

Docker 生产配置未在当前无 Docker 的 Windows 环境执行；不能仅凭配置文件存在将 OPS03 标为通过。首次生产使用前须按本节从空数据库复现、确认迁移/种子和同域上传、HTTP、WebSocket，并记录结果。

不要将 `game` 扩容为多个权威实例。数据库 advisory lock 作为最后防线拒绝第二实例，主锁丢失时应停止资产写入并使 readiness 失败。没有房间调度的首版不支持多节点并行模拟。

## 健康、日志与发布

日志保留 requestId、userId、matchId、错误码和事务来源，隐藏 Cookie、邀请码明文和密钥。至少持续监测 tick P95、连接数、内存、失败购买、冻结总额、待结算比赛年龄、outbox 积压和数据库连接池。公共缸负载烟测为 `pnpm load:smoke`，其报告明确记录尚未覆盖的性能目标。

发布前备份数据库和上传目录。先停止接新邀请与准备，短比赛有界排空；剩余比赛由服务器系统中止并退款。`stop_grace_period` 设为 45 秒。重启后必须先恢复未完成比赛，已提交的最终结果不再退款。不要直接删除 wallet_holds 或修改余额来清除准备状态。

## 备份与恢复演练

数据库和上传文件必须作为一套备份保存，至少每日一次、保留最近七份，并在发布前另存一份。下面命令仅针对命名的游戏服务和数据库，路径由操作者明确填写：

```text
docker compose -f infra/compose.yml exec -T db pg_dump -U aquarium -d aquarium -Fc -f /tmp/aquarium.dump
docker compose -f infra/compose.yml cp db:/tmp/aquarium.dump ./backup/aquarium.dump
docker compose -f infra/compose.yml cp game:/data/uploads ./backup/uploads
```

为确保数据库与图片关联一致，制作最终发布备份期间暂停资产写入。恢复演练应在独立环境进行：创建空 PostgreSQL 17 数据库，用 `pg_restore --no-owner --clean --if-exists` 恢复指定备份，复制同一批上传目录，使用新环境的密钥启动服务，等待 readiness，再核对鱼、库存、上传归属、钱包余额、冻结合计、流水零和及比赛唯一结果。恢复命令包含清理选项，只能对已确认的独立恢复数据库执行，不能直接指向生产。

本文件提供演练步骤；没有实际执行演练的记录前，OPS05 状态为未执行。

