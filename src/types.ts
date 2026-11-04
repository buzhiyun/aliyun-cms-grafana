import type { DataQuery, DataSourceJsonData } from '@grafana/data';

/**
 * Query model. Field names are kept identical to the legacy Angular plugin
 * (v1.x/v2.x) so existing dashboards keep working without migration.
 */
export interface CmsQuery extends DataQuery {
  /** Cloud Monitor namespace/project, e.g. acs_ecs_dashboard */
  project?: string;
  /** Metric name, e.g. cpu_total */
  metric?: string;
  /** Aggregation period in seconds, e.g. 60/300/900, or "auto" */
  period?: string;
  /** Monitor group id (custom/log monitoring only) */
  group?: string;
  /** Selected dimension filters, each a JSON string like {"instanceId":"i-xxx"} */
  dimensions?: string[];
  /** Selected statistics (Y columns), e.g. Average, Maximum */
  ycol?: string[];
  /** Time axis field, defaults to "timestamp" */
  xcol?: string;
  /** Optional prefix used to distinguish series with the same Y column */
  describe?: string;
}

export interface CmsDataSourceOptions extends DataSourceJsonData {
  /** Aliyun user id (numeric string), used to build acs_custom/acs_logMonitor namespaces */
  userId?: string;
}

export interface CmsSecureJsonData {
  cmsAccessKey?: string;
  cmsSecretKey?: string;
}
