import {
  createDataFrame,
  DataSourceApi,
  FieldType,
  type DataFrame,
  type DataQueryRequest,
  type DataQueryResponse,
  type DataSourceInstanceSettings,
  type MetricFindValue,
  type TestDataSourceResponse,
} from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';

import {
  CmsClient,
  type Datapoint,
  type EcsDescribeTagsResponse,
  type ListTagResourcesResponse,
  type MetricListResponse,
  type MetricMetaResource,
  type MetricMetaResponse,
  type MonitorGroupsResponse,
  type ProjectMetaResponse,
  type QueryParams,
  type RdsDescribeTagsResponse,
  type TagEntry,
} from './api';
import type { CmsDataSourceOptions, CmsQuery } from './types';
import * as util from './util';

/** Aliyun CMS OpenAPI has strict QPS limits - the legacy plugin throttled between calls. */
const LIST_THROTTLE_MS = 1000;
const LAST_THROTTLE_MS = 100;
const META_THROTTLE_MS = 500;
const MAX_CURSOR_PAGES = 20;

export class DataSource extends DataSourceApi<CmsQuery, CmsDataSourceOptions> {
  datasourceUid?: string;
  aliyunUserId?: string;
  client: CmsClient;
  cacheMeta: Map<string, MetricMetaResource[]>;

  constructor(instanceSettings: DataSourceInstanceSettings<CmsDataSourceOptions>) {
    super(instanceSettings);
    this.datasourceUid = instanceSettings.uid;
    this.aliyunUserId = instanceSettings.jsonData.userId;
    this.client = new CmsClient(instanceSettings.uid);
    this.cacheMeta = new Map<string, MetricMetaResource[]>();
  }

  /**
   * Runs every query target against the Cloud Monitor API and returns the
   * results as data frames (one frame per dimension group / Y column).
   */
  async query(options: DataQueryRequest<CmsQuery>): Promise<DataQueryResponse> {
    const frames: DataFrame[] = [];
    const results = await Promise.all(
      options.targets.map((target) => this.queryTarget(target, options).catch(() => [] as DataFrame[]))
    );
    results.forEach((targetFrames) => frames.push(...targetFrames));
    return { data: frames };
  }

  private async queryTarget(target: CmsQuery, options: DataQueryRequest<CmsQuery>): Promise<DataFrame[]> {
    const project = util.resolveScalar(target.project, options.scopedVars);
    const metric = util.resolveScalar(target.metric, options.scopedVars);
    const period = util.resolveScalar(target.period, options.scopedVars);
    const group = util.resolveScalar(target.group, options.scopedVars);
    const xcol = target.xcol || 'timestamp';

    if (util.isEmpty(project) || util.isEmpty(metric) || util.isEmpty(xcol)) {
      return [];
    }

    // Resolve template variables inside Y columns (multi-value expansion).
    const ycols: string[] = [];
    for (const y of target.ycol ?? []) {
      if (y.indexOf('$') !== -1) {
        ycols.push(...util.resolve(y, options.scopedVars));
      } else {
        ycols.push(y);
      }
    }
    if (ycols.length === 0) {
      return [];
    }

    // Build the Dimensions parameter.
    let dimensions: string;
    if (project.indexOf('acs_custom') !== -1 || project.indexOf('acs_logMonitor') !== -1) {
      // Custom metrics (acs_custom) and log monitoring (acs_logMonitor) take a
      // single dimension plus the monitor group id.
      if (!target.dimensions || target.dimensions.length === 0 || util.isEmpty(group)) {
        return [];
      }
      dimensions = JSON.stringify({ groupId: group, dimension: target.dimensions[0] });
    } else {
      let dims = '';
      for (const dimension of target.dimensions ?? []) {
        const values = util.exists(dimension) ? util.resolve(dimension, options.scopedVars) : [dimension];
        for (let d of values) {
          if (!d.includes('{')) {
            d = '{' + d;
          }
          if (!d.includes('}')) {
            d = d + '}';
          }
          dims += d + ',';
        }
      }
      if (dims.length > 0) {
        dims = dims.substring(0, dims.length - 1);
      }
      dimensions = '[' + dims + ']';
    }

    // Metric metadata tells us which dimension keys to group by.
    const resource = await this.queryMetricMeta(project, metric);
    if (!resource || resource.length === 0 || util.isEmpty(resource[0].Dimensions)) {
      return [];
    }
    const allKeys = (resource[0].Dimensions as string).split(',');
    const targetKeys = allKeys.length === 1 ? allKeys : allKeys.filter((key) => key !== 'userId');

    const params: QueryParams = {
      Action: 'QueryMetricList',
      Length: 1000,
      Project: project,
      Metric: metric,
      Dimensions: dimensions,
      StartTime: Math.round(options.range.from.valueOf()),
      EndTime: Math.round(options.range.to.valueOf()),
    };
    if (!util.isEmpty(period)) {
      params.Period = period;
    }

    const list = await this.fetchMetricData(params, 'list');
    const dataMap = this.dataGroupByKeys(list, targetKeys);

    const describe = util.isEmpty(target.describe) ? '' : (target.describe as string) + '.';
    const frames: DataFrame[] = [];
    dataMap.forEach((points, key) => {
      const sorted = [...points].sort((a, b) => Number(a[xcol]) - Number(b[xcol]));
      for (const y of ycols) {
        frames.push(
          createDataFrame({
            refId: target.refId,
            name: `${describe}${key}.${y}`,
            fields: [
              { name: xcol, type: FieldType.time, values: sorted.map((p) => Number(p[xcol])) },
              { name: y, type: FieldType.number, values: sorted.map((p) => Number(p[y])) },
            ],
          })
        );
      }
    });
    return frames;
  }

  /** Fetches a metric (list or last) following the legacy Cursor pagination. */
  private async fetchMetricData(
    params: QueryParams,
    type: 'list' | 'last',
    cursor = '',
    count = 0
  ): Promise<Datapoint[]> {
    await util.wait(type === 'list' ? LIST_THROTTLE_MS : LAST_THROTTLE_MS);
    try {
      const data = await this.client.cms<MetricListResponse>({ ...params, Cursor: cursor });
      if (!isOk(data)) {
        return [];
      }
      const result: Datapoint[] = data.Datapoints ? (JSON.parse(data.Datapoints) as Datapoint[]) : [];
      if (count >= MAX_CURSOR_PAGES) {
        return result;
      }
      const next = data.Cursor || data.NextToken || '';
      if (util.isEmpty(next)) {
        return result;
      }
      const rest = await this.fetchMetricData(params, type, next, count + 1);
      return result.concat(rest);
    } catch {
      return [];
    }
  }

  /** Groups datapoints by the given dimension keys, joining values with "_". */
  private dataGroupByKeys(list: Datapoint[], keys: string[]): Map<string, Datapoint[]> {
    const map = new Map<string, Datapoint[]>();
    for (const dataPoint of list) {
      let keyTarget = '';
      for (let j = 0; j < keys.length; j++) {
        const value = dataPoint[keys[j]];
        keyTarget += (j === 0 ? '' : '_') + String(value ?? '');
      }
      const existing = map.get(keyTarget);
      if (existing) {
        existing.push(dataPoint);
      } else {
        map.set(keyTarget, [dataPoint]);
      }
    }
    return map;
  }

  /** Metric metadata (dimension keys, periods, statistics), cached per project/metric. */
  private async queryMetricMeta(project: string, metric: string): Promise<MetricMetaResource[]> {
    const cacheKey = `${project}_${metric}`;
    const cached = this.cacheMeta.get(cacheKey);
    if (cached) {
      return cached;
    }
    await util.wait(META_THROTTLE_MS);
    try {
      const data = await this.client.cms<MetricMetaResponse>({
        Action: 'QueryMetricMeta',
        PageNumber: 1,
        PageSize: 1,
        Project: project,
        Metric: metric,
      });
      if (isOk(data)) {
        const resource = data.Resources?.Resource ?? [];
        this.cacheMeta.set(cacheKey, resource);
        return resource;
      }
    } catch {
      // fall through
    }
    return [];
  }

  /** Delegates to the backend CheckHealth handler. */
  async testDatasource(): Promise<TestDataSourceResponse> {
    try {
      const res = await lastValueFrom(
        getBackendSrv().fetch<{ status: string; message: string }>({
          url: `/api/datasources/uid/${this.datasourceUid}/health`,
          method: 'POST',
        })
      );
      if (res.data.status === 'OK') {
        return { status: 'success', message: 'Data source is working' };
      }
      return { status: 'error', message: res.data.message || 'Data source is not working' };
    } catch (err) {
      const message =
        (err as { data?: { message?: string } })?.data?.message ||
        (err as { message?: string })?.message ||
        'Data source is not working';
      return { status: 'error', message };
    }
  }

  /**
   * Template variable queries. Supported syntaxes (unchanged from the legacy
   * plugin so existing dashboards keep working):
   *   namespaces(filter?)
   *   metrics(namespace, filter?)
   *   tagFilter(type, regionId, keyOrValue, tagKey?, filter?)
   *   dimension(namespace, metric, instanceId?, filter?)
   *   tag(type, regionId, resourceType, resourceId, tag, filter?)
   */
  async metricFindQuery(query: string): Promise<MetricFindValue[]> {
    // namespaces(filter?)
    const namespacesQuery =
      query.match(/^namespaces\(([^\)]+?)(,\s?([^,]+?))?\)/) || query.match(/^namespace\(([^\)]+?)(,\s?([^,]+?))?\)/);
    if (namespacesQuery !== null) {
      const filter = util.templateToStr(namespacesQuery[1]);
      const namespaces = await this.getProject();
      if (util.isEmpty(filter)) {
        return namespaces;
      }
      return namespaces.filter((n) => n.text.includes(filter));
    }

    // metrics(namespace, filter?)
    const metricsQuery =
      query.match(/^metrics\(([^,]+?),\s?([^,]+?)\)/) || query.match(/^metric\(([^,]+?),\s?([^,]+?)\)/);
    if (metricsQuery !== null) {
      const namespace = util.templateToStr(metricsQuery[1]);
      const filter = util.templateToStr(metricsQuery[2]);
      const metrics = await this.getMetrics(namespace);
      if (util.isEmpty(filter)) {
        return metrics;
      }
      return metrics.filter((m) => m.text.includes(filter));
    }

    // tagFilter(type, regionId, keyOrValue, tagKey?, filter?)
    const tagFilterQuery =
      query.match(/^tagFilter\(([^,]+?),\s?([^,]+?),\s?([^,]+?),\s?([^,]+?)(,\s?(.+))?\)/) ||
      query.match(/^tagsFilter\(([^,]+?),\s?([^,]+?),\s?([^,]+?),\s?([^,]+?)(,\s?(.+))?\)/);
    if (tagFilterQuery !== null) {
      const type = util.templateToStr(tagFilterQuery[1]);
      const regionId = util.templateToStr(tagFilterQuery[2]);
      const tagType = util.isEmpty(tagFilterQuery[3]) ? '' : tagFilterQuery[3];
      const tagKey = util.isEmpty(tagFilterQuery[4]) ? '' : tagFilterQuery[4];

      const params: QueryParams = {
        Action: 'DescribeTags',
        PageNumber: 1,
        PageSize: 100,
        RegionId: regionId,
      };
      const tagKeyFilter: string[] = [];
      if (tagKey) {
        // tagKey is either a plain key value or a raw query fragment such as
        // "Tag.1.Key=env&Tag.2.Key=team" (typically produced by a template
        // variable), which is merged into the request parameters.
        if (tagKey.indexOf('&Tag.2.Key=') !== -1) {
          tagKey.split('&').forEach((segment) => {
            if (segment) {
              tagKeyFilter.push(
                segment.indexOf('Key=') === -1 ? segment : segment.substring(segment.indexOf('Key=') + 4)
              );
            }
          });
        } else {
          tagKeyFilter.push(tagKey);
        }
        if (tagKey.indexOf('=') !== -1) {
          tagKey.split('&').forEach((segment) => {
            const eq = segment.indexOf('=');
            if (eq > 0) {
              params[segment.substring(0, eq)] = segment.substring(eq + 1);
            }
          });
        } else {
          params['Tag.1.Key'] = tagKey;
        }
      }
      const tagsList = await this.tagsFilter(type.toUpperCase(), params, tagType, tagKeyFilter);
      return util.arrayToMap(tagsList);
    }

    // dimension(namespace, metric, instanceId?, filter?)
    const dimensionsQuery =
      query.match(/^dimension\(([^,]+?),\s?([^,]+?),\s?([^,]+?),\s?([^,]+?)(,\s?(.+))?\)/) ||
      query.match(/^dimensions\(([^,]+?),\s?([^,]+?),\s?([^,]+?),\s?([^,]+?)(,\s?(.+))?\)/);
    if (dimensionsQuery !== null) {
      const namespace = util.templateToStr(dimensionsQuery[1]);
      const metric = util.templateToStr(dimensionsQuery[2]);
      const instanceId = dimensionsQuery[3];
      let instanceIdArray = util.exists(instanceId) ? util.resolve(instanceId) : [];
      if (instanceIdArray.length === 0) {
        instanceIdArray = util.isEmpty(instanceId) ? [] : util.strToArray(instanceId);
      }
      const filter = dimensionsQuery[4];
      let filterArray = util.exists(filter) ? util.resolve(filter) : [];
      if (filterArray.length === 0) {
        filterArray = util.isEmpty(filter) ? [] : util.strToArray(filter);
      }
      const dimensions = await this.getDimensions(namespace, metric, '', []);
      if (util.isEmpty(instanceId)) {
        return dimensions;
      }
      const instanceIdResult = dimensions.filter((d) => instanceIdArray.some((i) => d.text.includes(i)));
      if (util.isEmpty(filter)) {
        return instanceIdResult;
      }
      return instanceIdResult.filter((d) => filterArray.some((i) => d.text.includes(i)));
    }

    // tag(type, regionId, resourceType, resourceId, tag, filter?)
    const tagQuery =
      query.match(/^tag\(([^,]+?),\s?([^,]+?),\s?([^,]+?),\s?([^,]+?),\s?([^,]+?)(,\s?(.+))?\)/) ||
      query.match(/^tags\(([^,]+?),\s?([^,]+?),\s?([^,]+?),\s?([^,]+?),\s?([^,]+?)(,\s?(.+))?\)/);
    if (tagQuery !== null) {
      const resourceId = tagQuery[4];
      let resourceIdArray = util.exists(resourceId) ? util.resolve(resourceId) : [];
      if (resourceIdArray.length === 0) {
        resourceIdArray = util.isEmpty(resourceId) ? [] : util.strToArray(resourceId);
      }
      const tag = tagQuery[5];
      let tagArray = util.exists(tag) ? util.resolve(tag) : [];
      if (tagArray.length === 0) {
        tagArray = util.isEmpty(tag) ? [] : util.strToArray(tag);
      }
      return this.listTagResources(tagQuery[1].toUpperCase(), tagQuery[2], tagQuery[3], resourceIdArray, tagArray);
    }

    return [];
  }

  /** All projects/namespaces, including the custom/log monitoring namespaces of the configured user. */
  async getProject(): Promise<MetricFindValue[]> {
    try {
      const data = await this.client.cms<ProjectMetaResponse>({
        Action: 'QueryProjectMeta',
        PageNumber: 1,
        PageSize: 1000,
      });
      const result: string[] = [];
      if (isOk(data)) {
        for (const resource of data.Resources?.Resource ?? []) {
          if (!util.isEmpty(resource.Namespace)) {
            result.push(resource.Namespace as string);
          }
        }
      }
      if (!util.isEmpty(this.aliyunUserId)) {
        result.push('acs_logMonitor_' + this.aliyunUserId);
        result.push('acs_customMetric_' + this.aliyunUserId);
      }
      return util.arrayToMap(result);
    } catch {
      return [];
    }
  }

  /** All metrics of a project/namespace. */
  async getMetrics(project: string): Promise<MetricFindValue[]> {
    try {
      const data = await this.client.cms<MetricMetaResponse>({
        Action: 'QueryMetricMeta',
        PageNumber: 1,
        PageSize: 1000,
        Project: project,
      });
      if (!isOk(data)) {
        return [];
      }
      const result: string[] = [];
      for (const resource of data.Resources?.Resource ?? []) {
        if (!util.isEmpty(resource.MetricName)) {
          result.push(resource.MetricName as string);
        }
      }
      return util.arrayToMap(result);
    } catch {
      return [];
    }
  }

  /** Supported aggregation periods of a metric, with "auto" prepended. */
  async getPeriod(project: string, metric: string): Promise<MetricFindValue[]> {
    const meta = await this.queryMetricMeta(project, metric);
    if (meta.length === 0 || util.isEmpty(meta[0].Periods)) {
      return [];
    }
    return util.arrayToMap(['auto', ...(meta[0].Periods as string).split(',')]);
  }

  /** Supported statistics (Y columns) of a metric. */
  async getStatistics(project: string, metric: string): Promise<MetricFindValue[]> {
    const meta = await this.queryMetricMeta(project, metric);
    if (meta.length === 0 || util.isEmpty(meta[0].Statistics)) {
      return [];
    }
    return util.arrayToMap((meta[0].Statistics as string).split(','));
  }

  /** Monitor groups (for custom metrics / log monitoring). */
  async getGroups(): Promise<MetricFindValue[]> {
    try {
      const data = await this.client.cms<MonitorGroupsResponse>({
        Action: 'ListMyGroups',
        PageNumber: 1,
        PageSize: 9000,
      });
      if (!isOk(data)) {
        return [];
      }
      const result: MetricFindValue[] = [];
      for (const group of data.Resources?.Resource ?? []) {
        if (util.isEmpty(group.GroupId) || util.isEmpty(group.GroupName)) {
          continue;
        }
        result.push({
          text: `${group.GroupName} / ${group.GroupId}`,
          value: String(group.GroupId),
        });
      }
      return result;
    } catch {
      return [];
    }
  }

  /**
   * Dimension values available for a project/metric, derived from the last
   * 15 minutes of data (not supported for custom/log monitoring projects).
   */
  async getDimensions(
    project: string,
    metric: string,
    period: string,
    dimensions: string[]
  ): Promise<MetricFindValue[]> {
    if (project.indexOf('acs_customMetric') !== -1 || project.indexOf('acs_logMonitor') !== -1) {
      return [];
    }
    const endTime = Date.now();
    const startTime = endTime - 15 * 60 * 1000;
    const params: QueryParams = {
      Action: 'QueryMetricLast',
      Project: project,
      Metric: metric,
      StartTime: startTime,
      EndTime: endTime,
    };
    if (!util.isEmpty(period)) {
      params.Period = period;
    }

    const data = await this.fetchMetricData(params, 'last');
    if (data.length === 0) {
      return [];
    }
    const meta = await this.queryMetricMeta(project, metric);
    if (util.isEmpty(meta) || util.isEmpty(meta[0].Dimensions)) {
      return [];
    }
    return this.dimensionData(data, meta, dimensions);
  }

  /** Builds distinct dimension option strings from datapoints. */
  private dimensionData(
    data: Datapoint[],
    resource: MetricMetaResource[],
    dimensions: string[]
  ): Promise<MetricFindValue[]> {
    const result: string[] = [];
    const dimensionKeys = (resource[0].Dimensions as string).split(',');
    for (const datapoint of data) {
      const obj: Record<string, string> = {};
      for (const rawKey of dimensionKeys) {
        const key = rawKey.replace(/"/g, '');
        if (key !== 'userId' || dimensionKeys.length === 1) {
          const value = datapoint[key];
          if (value !== undefined) {
            obj[key] = String(value);
          }
        }
      }
      const info = JSON.stringify(obj);
      if (!result.includes(info) && !dimensions.includes(info)) {
        result.push(info);
      }
    }
    return Promise.resolve(util.arrayToMap(result));
  }

  /** Describes tags of ECS/RDS resources (no server-side pagination). */
  private async tagsFilter(
    type: string,
    params: QueryParams,
    tagType: string,
    tagKeyFilter: string[]
  ): Promise<string[]> {
    try {
      let tags: TagEntry[] = [];
      if (type === 'ECS') {
        const data = await this.client.ecs<EcsDescribeTagsResponse>(params);
        tags = data.Tags?.Tag ?? [];
      } else if (type === 'RDS') {
        const data = await this.client.rds<RdsDescribeTagsResponse>(params);
        tags = data.Items?.TagInfos ?? [];
      } else {
        return [];
      }
      const result: string[] = [];
      for (const tag of tags) {
        if (tagType === 'key') {
          if (tag.TagKey && !result.includes(tag.TagKey)) {
            result.push(tag.TagKey);
          }
        } else if (tagType === 'value') {
          if (tagKeyFilter.length === 0 || (tag.TagKey && tagKeyFilter.includes(tag.TagKey))) {
            const value = `${tag.TagKey}:/:${tag.TagValue}`;
            if (tag.TagKey && tag.TagValue !== undefined && !result.includes(value)) {
              result.push(value);
            }
          }
        }
      }
      return result;
    } catch {
      return [];
    }
  }

  /** Lists resource ids by tag (ECS/RDS ListTagResources with NextToken pagination). */
  private async listTagResources(
    type: string,
    regionId: string,
    resourceType: string,
    resourceId: string[],
    tag: string[]
  ): Promise<MetricFindValue[]> {
    type = util.isEmpty(type) ? 'ECS' : type;
    regionId = util.isEmpty(regionId) ? 'cn-hangzhou' : regionId;
    if (type === 'ECS') {
      resourceType = util.isEmpty(resourceType) ? 'instance' : resourceType;
    } else if (type === 'RDS') {
      resourceType = util.isEmpty(resourceType) ? 'INSTANCE' : resourceType;
    }

    const params: QueryParams = {
      Action: 'ListTagResources',
      RegionId: regionId,
      ResourceType: resourceType,
    };
    // at most 50 resource ids
    resourceId.forEach((value, i) => {
      if (i < 50 && !util.isEmpty(value)) {
        params[`ResourceId.${i + 1}`] = value;
      }
    });

    const tagKeyArray: string[] = [];
    const tagValueArray: string[] = [];
    tag.forEach((t) => {
      if (!util.isEmpty(t) && t.indexOf(':/:') !== -1) {
        const [key, value] = t.split(':/:');
        if (!tagKeyArray.includes(key)) {
          tagKeyArray.push(key);
        }
        if (!tagValueArray.includes(value)) {
          tagValueArray.push(value);
        }
      }
    });
    if (tagKeyArray.length > 0) {
      tagKeyArray.forEach((key, i) => {
        params[`Tag.${i + 1}.Key`] = key;
      });
    } else if (tag.length > 0) {
      tag.forEach((key, i) => {
        params[`Tag.${i + 1}.Key`] = key;
      });
    }

    const resources = await this.tagList(type, '', params, tagValueArray);
    const distinct: string[] = [];
    resources.forEach((id) => {
      if (!distinct.includes(id)) {
        distinct.push(id);
      }
    });
    return util.arrayToMap(distinct);
  }

  private async tagList(
    type: string,
    nextToken: string,
    params: QueryParams,
    tagValueArray: string[]
  ): Promise<string[]> {
    try {
      const reqParams: QueryParams = { ...params, NextToken: nextToken };
      let data: ListTagResourcesResponse;
      if (type === 'ECS') {
        data = await this.client.ecs<ListTagResourcesResponse>(reqParams);
      } else if (type === 'RDS') {
        data = await this.client.rds<ListTagResourcesResponse>(reqParams);
      } else {
        return [];
      }
      const result: string[] = [];
      for (const resource of data.TagResources?.TagResource ?? []) {
        if (resource.ResourceId === undefined) {
          continue;
        }
        if (tagValueArray.length === 0 || (resource.TagValue && tagValueArray.includes(resource.TagValue))) {
          result.push(resource.ResourceId);
        }
      }
      if (util.isEmpty(data.NextToken)) {
        return result;
      }
      const next = await this.tagList(type, data.NextToken as string, params, tagValueArray);
      return result.concat(next);
    } catch {
      return [];
    }
  }
}

/** POP API responses embed Code/Success; absent fields are treated as success. */
function isOk(data: { Code?: string; Success?: boolean }): boolean {
  const codeOk = data.Code === undefined || data.Code === '200';
  const successOk = data.Success === undefined || data.Success === true;
  return codeOk && successOk;
}
