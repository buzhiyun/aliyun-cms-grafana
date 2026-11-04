# aliyun-cms-grafana 数据源插件现代化改造执行计划

> 目标：消除新版 Grafana 中的 "Angular plugin" 弃用告警，使插件兼容 Grafana 10.4+ / 11.x（Angular 在 Grafana 12 中被彻底移除，必须在此之前完成改造）。
> 本机环境：Node v22.20.0、Go 1.26.3，满足新工具链要求。

---

## 一、现状分析

### 1.1 架构总览（改造前）

```
┌─ Grafana 前端（Angular，产生弃用告警的根源）──────────────────┐
│ src/module.js      导出 Datasource/QueryCtrl/ConfigCtrl 等      │
│ src/query_ctrl.js  extends QueryCtrl (from 'app/plugins/sdk')   │
│ src/partials/*.html  Angular 模板（ng-model/gf-form-dropdown）  │
│ src/datasource.js  全部查询逻辑在浏览器端：模板变量解析、        │
│                    Dimensions 拼接、Cursor 翻页、数据分组       │
│ src/util.js        模板变量解析工具                              │
│ src/signer.js      v1.0 遗留的前端签名逻辑，现已废弃（死代码）   │
│ src/sha1.js        同上                                          │
└──────────────┬──────────────────────────────────────────┘
               │  HTTP: /api/datasources/:id/resources/proxy_aliyun_{cms,ecs,rds}_pop
┌──────────────▼──────────────────────────────────────────┐
│ Go 后端（pkg/plugin.go + pkg/datasource.go）                     │
│ CallResourceHandler 路由到 3 个 proxy handler；                 │
│ 用阿里云官方 SDK (cms/ecs/rds) 调用云监控/ECS/RDS OpenAPI        │
│ QueryDataHandler 被注释掉；CheckHealth 恒返回 OK                 │
└─────────────────────────────────────────────────────────┘
```

### 1.2 各文件现状

| 文件 | 作用 | 改造处置 |
|---|---|---|
| `src/module.js` | Angular 插件入口，导出 5 个控制器 | **重写** → `src/plugin.ts` |
| `src/query_ctrl.js` | Angular QueryCtrl（告警直接来源） | **重写** → React `QueryEditor` |
| `src/partials/query.editor.html` | Angular 查询编辑器模板 | **重写** → React 组件 |
| `src/partials/config.html` | Angular 数据源配置页 | **重写** → React `ConfigEditor` |
| `src/partials/{annotations.editor,query.options}.html` | 空壳模板 | **删除**（annotations 暂不支持，见 1.4） |
| `src/datasource.js` | 查询主逻辑（约 880 行） | **重写** → TypeScript `DataSourceApi` 实现 |
| `src/util.js` | 模板变量解析 | **移植** → TS（用 `getTemplateSrv().replace` 重写 `resolve`） |
| `src/signer.js` / `src/sha1.js` | v1.0 前端签名 | **删除**（签名已在 Go 后端完成） |
| `pkg/plugin.go` / `pkg/datasource.go` | 资源代理后端 | **保留架构，升级 SDK + 修 bug** |
| `Gruntfile.js` + package.json（grunt/babel/systemjs，Node 14） | 旧构建链 | **替换** → `@grafana/create-plugin` 工具链（webpack/eslint/jest） |
| `spec/*.js` | mocha 单测（引用了已不存在的方法，早已失效） | **重写** → Jest |
| `src/json/*.json` | ECS/RDS 示例 dashboard | 保留，作为**回归验证用例** |

### 1.3 必须保留的对外契约（兼容性红线）

1. **插件 ID 不变**：`aliyun_cms_grafana_datasource`（保证已安装数据源平滑升级）。
2. **查询 target 数据模型字段不变**：`project / metric / period / group / dimensions / ycol / xcol / describe / type`，存量 dashboard 的 panel JSON 无需迁移。
3. **后端资源路由不变**：`/api/datasources/:id/resources/proxy_aliyun_{cms,ecs,rds}_pop` 及其 `Action` 参数协议（前端改走 `getBackendSrv().fetch`，Go 端零改动即可对接）。
4. **模板变量查询语法不变**：`namespaces() / metrics(ns) / tagFilter(...) / dimension(...) / tag(...)`，存量 dashboard 的变量查询不失效。
5. **凭据字段名不变**：`secureJsonData.cmsAccessKey / cmsSecretKey`、`jsonData.userId`（Go 端 `CmsSetting` 依赖这些 key）。

### 1.4 顺带决策

- `plugin.json` 中 `annotations: true` 但 `annotationQuery` 为空实现 → 本期**移除** annotations 声明，二期可选实现。
- 查询逻辑仍留在前端（走 resource proxy），与现状一致、改造风险最小；**未实现 `QueryDataHandler` 意味着不支持统一告警（Alerting）**，列入二期（见阶段 8）。

---

## 二、改造策略

- **前端**：用 `@grafana/create-plugin` 脚手架重建，React + TypeScript + `@grafana/ui` / `@grafana/data` / `@grafana/runtime`。
- **后端**：保持"资源代理"架构不变，仅升级依赖与修复缺陷，`QueryData` 后端化作为二期。
- **数据返回**：旧版返回 `{target, datapoints:[[value,ts]]}`，新版前端必须返回 **DataFrame**（`createDataFrame`，time 字段取 `xcol`，value 字段取各 `ycol`，series 名保持 `describe + key + "." + ycol`），`type: 'table'` 的 target 构造表格 frame。

---

## 三、分阶段执行计划

### 阶段 0：准备（0.5 天）
- [ ] 新建分支 `feat/react-migration`；给当前 v2.0 打 tag（如 `v2.0-legacy`）留档。
- [ ] 归档 `src/json/` 示例 dashboard 备用（回归基准）。

### 阶段 1：脚手架重建（0.5 天）
- [ ] 在临时目录 `npx @grafana/create-plugin@latest`（datasource 模板），将生成的 `src/`、`.config/`（webpack/eslint/prettier）、`package.json`、`tsconfig.json` 并入仓库；删除 `Gruntfile.js`、`spec/`、`src/*.js`、`src/partials/`、`src/signer.js`、`src/sha1.js`。
- [ ] `package.json` scripts：`dev / build / test / lint / e2e`；保留 `Magefile.go`（Go 构建），确保产物可执行文件名与 `plugin.json` 的 `"executable": "cms-datasource"` 一致。
- [ ] 定义类型：`src/types.ts` 中 `CmsQuery`（含 1.3-2 的全部字段，`dimensions: string[]`、`ycol: string[]`）与 `CmsDataSourceOptions`。

### 阶段 2：Go 后端升级（1 天，可与前端并行）
- [ ] `go.mod`：`go 1.22`；`grafana-plugin-sdk-go` 升级至最新稳定版；`alibabacloud-go/*` SDK 升级并回归编译。
- [ ] 修复已知缺陷（详见第四节清单 #4–#8）。
- [ ] `CheckHealth` 真正实现：调用 `DescribeMetricMetaList`（`Namespace=acs_ecs_dashboard, PageSize=1`）验证 AK 可用，替代前端 `testDatasource` 的假校验。
- [ ] `go vet ./...` 通过。

### 阶段 3：前端基础设施（1 天）
- [ ] `src/api.ts`：封装 resource 调用——`cmsRequest(params)` / `ecsRequest(params)` / `rdsRequest(params)`，基于 `getBackendSrv().fetch({url: \`/api/datasources/${id}/resources/...\`})`，统一错误处理与响应码校验。
- [ ] `src/util.ts`：移植 `Util`——`resolve/exists/isEmpty/arrayToMap/strToArray/templateToStr`，其中 `resolve` 改用 `getTemplateSrv()` 实现（Grafana 9+ `templateSrv.variables` 私有化，不能直接读）。
- [ ] `ConfigEditor.tsx`：`userId`（jsonData）+ `AccessKeyId`/`AccessKeySecret`（secureJsonData，用 `secretSrv` 的 SecretField 模式，支持"已配置/重置"状态展示）。

### 阶段：核心 DataSource（2 天，工作量最大）
- [ ] `src/datasource.ts` 实现 `DataSourceApi`：
  - `metricFindQuery(query)`：完整移植 5 种语法（namespaces/metrics/tagFilter/dimension/tag），保持正则与过滤行为逐行等价。
  - 元数据方法：`getProject / getMetrics / getPeriod / getStatistics / getGroups / getDimensions / queryMetricMeta`（含 `cacheMeta` 缓存与限速 `wait`，CMS OpenAPI 有 QPS 限制，保留节流但抽成常量）。
  - `query(options)`：用 async/await 重写（顺带修复第四节 #1 的竞态 bug）——解析模板 → 组装 Dimensions（保留 `acs_custom/acs_logMonitor` 特殊分支与 `%26/%7B/%7D` 转义）→ `doNextToken` Cursor 翻页（上限 20 次）→ `dataGroupByKeys` 分组 → 转 DataFrame 返回。
  - `testDatasource`：改为调用后端 `CheckHealth`（`getBackendSrv().fetch('/api/datasources/:id/health')`）。
- [ ] 删除所有 `angular.*` 引用（`angular.fromJson` → `JSON.parse`）。

### 阶段 5：React QueryEditor（1.5 天）
- [ ] `QueryEditor.tsx` 替代 `query.editor.html + query_ctrl.js`：
  - Namespace/Metric/Period/Group：`Select`（allowCustomValues，options 来自元数据方法，随上游选择级联刷新）。
  - Dimensions：`MultiSelect`（替代原"选一个加一个 chip"交互，值仍写入 `target.dimensions: string[]`）。
  - Y-column：`MultiSelect`（对应 `target.ycol: string[]`）。
  - X-column（默认 `timestamp`）、Describe：`Input`。
  - 所有变更调用 `props.onChange(target)` + `props.onRunQuery()`。
- [ ] 空值清洗逻辑（`checkIsNull`）简化进 TS 工具函数。

### 阶段 6：plugin.json 与打包（0.5 天）
- [ ] 新 `plugin.json`：移除 `partials`；`"metrics": true`、`"backend": true`、`"executable": "cms-datasource"` 保留；`dependencies.grafanaDependency: ">=10.4.0"`；`info.version` 升为 `3.0.0`，更新 `updated`。
- [ ] `npm run build && mage -v` 产出 `dist/`；更新 README（去掉 grunt/node14 说明，改为 npm+mage；说明仍需 `allow_loading_unsigned_plugins`，可选后续接入官方签名）。

### 阶段 7：测试与验收（1–2 天）
- [ ] Jest 单测：Dimensions 拼装（普通/自定义监控/多值变量）、`dataGroupByKeys`、DataFrame 转换、`metricFindQuery` 各语法解析（mock `backendSrv` 与 `templateSrv`）。
- [ ] `docker run grafana/grafana:11.x` 挂载 dist + 未签名白名单，人工验收：
  1. 数据源配置、Save & Test（真校验 AK）；
  2. 导入 `src/json/` 两个示例 dashboard，出图正常（对比旧版截图）；
  3. 模板变量 5 种语法逐一验证；
  4. Cursor 翻页（选长时间范围）；
  5. 多 `ycol`、多 dimensions、`describe` 生效；
  6. 插件页无任何 Angular 告警。
- [ ] 更新/删除失效的旧 spec。

### 阶段 8（二期可选，本期不做）
- [ ] 实现 `QueryDataHandler` 将查询逻辑后端化 → 支持统一告警（Alerting）、减少浏览器端压力；前端可换 `DataSourceWithBackend`。
- [ ] Annotations 支持。
- [ ] 接入 Grafana 官方插件签名（`npx @grafana/sign-plugin`）。

**预估总工期：约 7–8 个工作日（一至七阶段）。**

---

## 四、重写时顺带修复的已知缺陷清单

| # | 位置 | 问题 |
|---|---|---|
| 1 | `datasource.js query()` | 竞态：`queryMetricMeta().then(...)` 与 `dataGroupByKeys().then(...)` 均未 await/return 进请求链，`target_keys`/分组结果可能在响应返回后才填充，导致偶发空图。重写时用 async/await 串行化。 |
| 2 | `datasource.js doNextToken()` | `angular.fromJson` 全局引用，非 Angular 环境直接崩溃。 |
| 3 | `doNextToken()` | `response.status == "200"`（number 与 string 弱比较，靠隐式转换才成立）；`data.Code == "200"` 同理。 |
| 4 | Go `handleResponse()` | 先 `Write` body 再 `WriteHeader`，顺序错误（部分场景状态码失效）。 |
| 5 | Go `newDataSourceInstance()` | **以 Debug 日志明文打印 AK/SK，属安全隐患，必须删除。** |
| 6 | Go 各 `proxy*` 函数 | `strconv.ParseInt` 的 `err` 判断逻辑写反（`if err != nil` 才赋值），PageSize/PageNumber 解析实际无效。 |
| 7 | Go 各 `proxy*` 函数 | `createCmsClient/createEcsClient/createRdsClient` 的 `err` 未检查，client 创建失败时后续 nil 指针 panic。 |
| 8 | Go `CheckHealth` | 恒返回 OK，未真正校验凭据。 |
| 9 | `spec/datasource_spec.js` | 引用 `mapToTextValue/getTagKeys/getTagValues` 等插件中不存在的方法，测试早已失效。 |

## 五、风险与对策

| 风险 | 对策 |
|---|---|
| Grafana 9+ `templateSrv.variables` 不可直接访问，`Util.resolve` 的多值展开行为难精确复刻 | 用 `getTemplateSrv().replace(name, scopedVars, 'raw')` 或 `getVariables()` 重写；用旧 dashboard 实测变量展开结果对齐 |
| CMS OpenAPI QPS 限制（现有 `wait(1000)` 硬编码节流） | 保留节流常量并集中管理；二期 QueryData 后端化后统一处理 |
| `dimensions` 交互从"逐个添加 chip"改为 MultiSelect，用户习惯变化 | 值模型不变（`string[]`），仅交互升级；README 注明 |
| 升级 alibabacloud-go SDK 带来 API 变更 | 阶段 2 单独验证编译与三个 proxy 的响应结构 |
| 未签名插件需 Grafana 配置白名单 | 维持现状（README 已有说明）；签名列入二期 |
