import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';

/**
 * The three resource-proxy routes served by the Go backend (pkg/plugin).
 * Route names are kept from the legacy plugin so the frontend/backend
 * contract is unchanged.
 */
export type ProxyKind = 'proxy_aliyun_cms_pop' | 'proxy_aliyun_ecs_pop' | 'proxy_aliyun_rds_pop';

export type QueryParams = Record<string, string | number | undefined>;

export interface Datapoint {
  timestamp: number;
  [key: string]: string | number | undefined;
}

/** Response body of DescribeMetricList / DescribeMetricLast (marshalled by the Go backend). */
export interface MetricListResponse {
  Code?: string;
  Success?: boolean;
  /** Legacy pagination token (POP API) */
  Cursor?: string;
  NextToken?: string;
  /** JSON-encoded array of datapoints */
  Datapoints?: string;
  Period?: string;
  RequestId?: string;
}

export interface MetricMetaResource {
  Namespace?: string;
  MetricName?: string;
  /** Comma separated list of supported periods, e.g. "15,60,900" */
  Periods?: string;
  /** Comma separated list of supported statistics, e.g. "Average,Maximum" */
  Statistics?: string;
  /** Comma separated list of dimension keys, e.g. "instanceId,device" */
  Dimensions?: string;
  Description?: string;
  Unit?: string;
}

export interface MetricMetaResponse {
  Code?: string;
  Success?: boolean;
  Resources?: { Resource?: MetricMetaResource[] };
  RequestId?: string;
}

export interface ProjectMetaResponse {
  Code?: string;
  Success?: boolean;
  Resources?: { Resource?: Array<{ Namespace?: string }> };
  RequestId?: string;
}

export interface MonitorGroup {
  GroupId?: string | number;
  GroupName?: string;
}

export interface MonitorGroupsResponse {
  Code?: string;
  Success?: boolean;
  Resources?: { Resource?: MonitorGroup[] };
  RequestId?: string;
}

export interface TagEntry {
  TagKey?: string;
  TagValue?: string;
}

export interface EcsDescribeTagsResponse {
  Tags?: { Tag?: TagEntry[] };
}

export interface RdsDescribeTagsResponse {
  Items?: { TagInfos?: TagEntry[] };
}

export interface TagResourceEntry {
  ResourceId?: string;
  TagKey?: string;
  TagValue?: string;
}

export interface ListTagResourcesResponse {
  NextToken?: string;
  TagResources?: { TagResource?: TagResourceEntry[] };
}

/**
 * Thin client for the plugin backend resource endpoints.
 * All calls go through Grafana's datasource resource proxy:
 *   /api/datasources/uid/:uid/resources/<route>?<query>
 */
export class CmsClient {
  constructor(private readonly datasourceUid?: string) {}

  private async fetch<T>(proxy: ProxyKind, params: QueryParams): Promise<T> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') {
        search.append(key, String(value));
      }
    }
    const url = `/api/datasources/uid/${this.datasourceUid}/resources/${proxy}?${search.toString()}`;
    const res = await lastValueFrom(getBackendSrv().fetch<T>({ url }));
    return res.data;
  }

  /** Cloud Monitor (CMS) OpenAPI calls. */
  cms<T>(params: QueryParams): Promise<T> {
    return this.fetch<T>('proxy_aliyun_cms_pop', params);
  }

  /** ECS OpenAPI calls. */
  ecs<T>(params: QueryParams): Promise<T> {
    return this.fetch<T>('proxy_aliyun_ecs_pop', params);
  }

  /** RDS OpenAPI calls. */
  rds<T>(params: QueryParams): Promise<T> {
    return this.fetch<T>('proxy_aliyun_rds_pop', params);
  }
}
