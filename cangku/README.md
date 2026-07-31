# 云衣仓库

面向单企业、单仓小团队的服装仓库管理系统。V1 覆盖款式与颜色尺码 SKU、入出退盘调、不可变库存流水、双人审批、AI/OCR 导入、受限报表导出、权限、审计和站内通知。

## 本地开发

要求：Node.js 22、pnpm 11、Docker Desktop。

```powershell
Copy-Item .env.example .env
docker compose up -d postgres redis
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

默认开发存储为本地 `storage/`。Web 地址为 `http://127.0.0.1:5173`，OpenAPI 为 `http://127.0.0.1:4000/api/docs`。首次使用前必须修改 `.env` 中的所有者密码；`.env` 不会被 Git 跟踪。

常用验证命令：

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm test:e2e
```

## 生产部署

生产方案使用 PostgreSQL 16、带密码 Redis、MinIO、自动迁移、NestJS API 和 Caddy。Caddy 仅暴露 `80/443`，自动申请和续期 HTTPS 证书；数据库、队列和对象存储不发布到宿主机端口。

1. 将域名解析到服务器，并仅开放 TCP `80/443` 与 UDP `443`。
2. 创建生产配置并替换每个占位密码。数据库密码若含 URL 保留字符，需要先进行 URL 编码。
3. 构建并启动服务；迁移容器成功后 API 才会启动。
4. 运行一次所有者初始化。该命令可重复执行，但不会创建演示库存。

```bash
cp .env.production.example .env.production
docker compose --env-file .env.production -f docker-compose.prod.yml build
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm bootstrap
```

健康检查：`https://你的域名/api/v1/health`。OpenAPI：`https://你的域名/api/docs`。

AI 适配层使用 OpenAI 兼容接口。只在 `.env.production` 设置 `AI_BASE_URL`、`AI_API_KEY` 和 `AI_MODEL`；系统页面、数据库和结构化请求日志不会显示密钥。外部文件只作为不可信数据解析，AI 结果必须人工确认并生成草稿，不能直接改变库存。导入源文件与导出文件默认分别保留 30 天和 7 天，每日清理，可通过 `IMPORT_RETENTION_DAYS`、`EXPORT_RETENTION_DAYS` 调整。

## 备份与恢复

`backup` 服务启动后立即生成一次 PostgreSQL 自定义格式备份，之后按 `BACKUP_INTERVAL_SECONDS`（默认 24 小时）执行。备份与 SHA-256 校验文件保存在宿主机 `backups/`；请另行同步到异机或云存储，并按企业策略管理保留周期。

手工备份：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm backup /scripts/backup.sh
```

恢复会清理目标数据库中的现有对象，必须先停止 API、核对目标库并显式设置确认值：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml stop api
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm \
  -e CONFIRM_RESTORE=RESTORE_CANGKU backup \
  /scripts/restore.sh /backups/cangku-YYYYMMDDTHHMMSSZ.dump
docker compose --env-file .env.production -f docker-compose.prod.yml up -d api
```

恢复演练后检查健康接口，并抽查用户登录、库存余额、单据、流水和审计记录。

## 运维检查

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml ps
docker compose --env-file .env.production -f docker-compose.prod.yml logs --since=30m api
docker compose --env-file .env.production -f docker-compose.prod.yml logs --since=30m backup
```

API 为每个请求返回 `x-request-id`，并记录不含请求体的 JSON 请求摘要。BullMQ 对导入任务重试 3 次、导出任务重试 2 次；导入失败和任务完成会写入站内通知。上线前必须执行一次迁移演练、备份恢复演练和移动端验收。

## V1 边界

V1 不包含采购财务、销售财务、多租户、SaaS 计费、平台直连、多仓调拨、条码、标签打印、离线写入、评论、在线状态、企业微信通知或原生 App。所有库存变化均由确定性事务规则和具备权限的人工操作完成。
