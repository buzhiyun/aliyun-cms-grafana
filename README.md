# aliyun-cms-grafana

阿里云云监控（Cloud Monitor / CMS）的 Grafana 数据源插件。

v3.0 是一次完整的前端重写：插件不再基于 AngularJS（Angular 支持已在 Grafana 12 中被彻底移除），改为 React + TypeScript 的现代插件平台实现，查询结果以 DataFrame 返回。**插件 ID、查询参数模型、模板变量语法与 v1/v2 完全兼容，存量 dashboard 无需迁移。**

## 环境要求

| 组件 | 版本 |
|---|---|
| Grafana | **>= 10.4**（在 10.4 ~ 13.x 上工作；不再依赖 Angular） |
| Node.js（构建） | >= 20 |
| Go（构建后端） | >= 1.24 |

## 安装

### 方式一：直接安装 release

1. 从 [releases](https://github.com/aliyun/aliyun-cms-grafana/releases) 下载 `aliyun_cms_grafana_datasource_v3.x.tar.gz`；
2. 解压到 Grafana 插件目录：`tar -xzf aliyun_cms_grafana_datasource_v3.x.tar.gz -C <grafana插件目录>`；
3. 未签名插件需要在 `conf/defaults.ini`（或环境变量）中放行：

   ```ini
   allow_loading_unsigned_plugins = aliyun_cms_grafana_datasource
   ```

   环境变量方式：`GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=aliyun_cms_grafana_datasource`
4. 重启 Grafana。

### 方式二：源码构建

```bash
# 前端
npm install
npm run build

# 后端（需要 mage，见 Magefile.go）
go run github.com/magefile/mage@latest build:backend     # 当前平台
go run github.com/magefile/mage@latest build:linux       # linux 全架构

# 产物都在 dist/ 目录，将整个 dist 目录作为插件目录安装
```

校验与测试：

```bash
npm run typecheck   # TypeScript 类型检查
npm run lint        # eslint
npm run test:ci     # jest 单元测试
go vet ./...
```

### 本地开发

```bash
npm run dev         # webpack watch，热更新前端
npm run server      # docker compose 启动带插件的 Grafana（默认 13.x，见 .config/）
GRAFANA_VERSION=11.6.0 npm run server   # 指定 Grafana 版本
```

开发前先在 `provisioning/datasources/datasources.yml` 中填入你的 AK。

## 配置数据源

1. Grafana → Connections → Data sources → Add data source → **CMS Grafana Service**；
2. 填写：
   - **Aliyun UserId**：阿里云账号 ID（数字串），用于自定义监控（`acs_customMetric_<uid>`）与日志监控（`acs_logMonitor_<uid>`）命名空间；
   - **AccessKeyId / AccessKeySecret**：保存在 secureJsonData 中，仅在保存时传输；
3. Save & Test（后端会真实调用云监控 API 校验 AK 有效性）。

## 查询

查询编辑器支持：Namespace（项目）、Metric（监控项）、Period（聚合周期）、Group（应用分组）、Dimensions（维度，多选）、Y-column（统计值，多选）、X-column（时间轴字段，默认 `timestamp`）、Describe（序列名前缀）。

## 模板变量语法（与 v1/v2 兼容）

| 语法 | 说明 |
|---|---|
| `namespace(filter)` / `namespaces(filter)` | 云监控项目列表，按关键字过滤 |
| `metric(namespace, filter)` / `metrics(...)` | 指定项目的监控项列表 |
| `tagFilter(type, regionId, keyOrValue, tagKey)` / `tagsFilter(...)` | ECS/RDS 标签的 key 或 value，`type` 为 `ecs`/`rds` |
| `tag(type, regionId, resourceType, resourceId, tag)` / `tags(...)` | 按标签反查资源 ID |
| `dimension(namespace, metric, instanceId, filter)` / `dimensions(...)` | 指定监控项的可用维度值 |

参数传 `null` 表示不过滤。示例见 `testdata/*.json` 示例 dashboard。

## 已知限制

- 查询仍在浏览器端通过数据源 resource proxy 执行（与 v2 架构一致），因此**不支持服务端告警（Unified Alerting）**；`QueryDataHandler` 后端化规划中；
- CMS OpenAPI 有严格的 QPS 限制（查询类接口 50 QPS/账号，与 RAM 用户共享），插件保留了节流并在后端对限流错误自动重试，大量面板同屏刷新时响应仍可能变慢；
- 数据查询优先使用 **BatchExport** 接口（QPS 1000、每页 10000 点，可显著减少调用次数与翻页耗时）。该接口属于**付费的企业云监控**能力：未开通的账号会自动回退到 DescribeMetricList 并在本次会话内不再尝试，功能不受影响；
- 插件未签名，需要管理员放行 unsigned 插件。

## License

MIT
