# Changelog

## 3.0.1 (2026-11-05)

### Fixed

- Query editor dropdowns (Namespace/Metric/Period/Group/Dimensions/Y-column)
  now filter options as you type. react-select's async mode has client-side
  filtering disabled by default, so typeahead filtering is applied inside
  `loadOptions`.
- List queries backing the editor dropdowns (`QueryProjectMeta`,
  `QueryMetricMeta`, `ListMyGroups`, `QueryMetricLast` for dimensions) are
  cached for 30 seconds - the typeahead re-requests the list on every
  keystroke, which would otherwise hit the strict CMS OpenAPI QPS limits.
- `docker compose up` (test mode): the livereload script is now only injected
  into Grafana's index.html in development mode. Previously the page hung
  waiting for `http://localhost:35729/livereload.js` when `npm run dev` was
  not running.
- Development mode (`DEVELOPMENT=true`): supervisord configs referenced the
  create-plugin template's placeholder names, so Grafana never started.

## 3.0.0 (2026-11-04)

Complete rewrite of the frontend on the modern Grafana plugin platform. The
plugin no longer uses AngularJS, which was deprecated in Grafana 10/11 and
removed in Grafana 12.

### Breaking/compatibility

- Requires Grafana 10.4+ (backend plugin, unsigned plugin whitelist still
  required: `allow_loading_unsigned_plugins = aliyun_cms_grafana_datasource`).
- Queries are still executed from the browser via the datasource resource
  proxy. Server-side alerting is not supported in this release.

### Added

- React + TypeScript frontend (`@grafana/ui` based query and config editors).
- Query results are returned as data frames.
- Backend `CheckHealth` now validates the configured AccessKey by calling the
  Cloud Monitor API (the "Save & Test" button performs a real check).
- Template variable query syntaxes from the legacy plugin are preserved:
  `namespaces()`, `metrics()`, `tagFilter()`, `dimension()`, `tag()`.

### Fixed

- Race condition in the legacy `query()` where metric metadata was not awaited,
  which could produce empty panels.
- Go backend: inverted `ParseInt` error checks (PageSize/PageNumber were
  ignored), unchecked client creation errors, wrong response-header order.
- Go backend: AccessKey/Secret are no longer written to debug logs.

### Changed

- Toolchain: grunt/babel/systemjs (Node 14) replaced with the standard
  `@grafana/create-plugin` toolchain (webpack/eslint/jest, Node 20+).
- Go: grafana-plugin-sdk-go v0.298.0, alibabacloud SDKs upgraded
  (cms v10, ecs v7.11, darabonba-openapi v2.2).
