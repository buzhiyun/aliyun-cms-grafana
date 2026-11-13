import { of } from 'rxjs';

import { DataSource } from '../datasource';
import type { CmsQuery } from '../types';

jest.mock('@grafana/runtime', () => ({
  getTemplateSrv: () => mockTemplateSrv,
  getBackendSrv: () => ({
    fetch: (opts: { url: string }) => of({ status: 200, statusText: 'OK', ok: true, data: route(opts.url) }),
  }),
}));

// remove the CMS API throttling delays from the code under test
jest.mock('../util', () => {
  const actual = jest.requireActual('../util');
  return { ...actual, wait: () => Promise.resolve() };
});

const mockTemplateSrv = {
  getVariables: () => [{ name: 'dim' }, { name: 'inst' }],
  replace: (target: string) => {
    if (target.includes('$dim')) {
      return target.replace(/\$dim/g, '{d1,d2}');
    }
    if (target.includes('$inst')) {
      return target.replace(/\$inst/g, 'i-1');
    }
    return target;
  },
  containsTemplate: (t: string) => /\$(dim|inst)\b/.test(t),
};

const metricMeta = {
  Namespace: 'acs_ecs_dashboard',
  MetricName: 'cpu_total',
  Periods: '60,300',
  Statistics: 'Average,Maximum',
  Dimensions: 'instanceId,userId',
};

const datapoints = [
  { timestamp: 2000, instanceId: 'i-1', userId: 'u1', Average: '2.5' },
  { timestamp: 1000, instanceId: 'i-1', userId: 'u1', Average: '1.5' },
  { timestamp: 1500, instanceId: 'i-2', userId: 'u1', Average: '9' },
];

/** Record of every backend call, filled by route(). */
const backendCalls: Array<{ proxy: string; params: Record<string, string> }> = [];

/**
 * Mutable fixtures: datapoints returned by QueryMetricLast / QueryMetricList.
 * Last defaults to empty (sparse metric), List defaults to the fixture data.
 */
const state = { lastDatapoints: '[]', listDatapoints: JSON.stringify(datapoints) };

function route(url: string): any {
  const u = new URL(url, 'http://grafana.local');
  const proxy = u.pathname.split('/').pop() as string;
  const params = Object.fromEntries(u.searchParams.entries());
  backendCalls.push({ proxy, params });

  if (proxy === 'proxy_aliyun_cms_pop') {
    switch (params.Action) {
      case 'QueryMetricMeta':
        return { Code: '200', Success: true, Resources: { Resource: [metricMeta] } };
      case 'QueryProjectMeta':
        return {
          Code: '200',
          Success: true,
          Resources: { Resource: [{ Namespace: 'acs_ecs_dashboard' }, { Namespace: 'acs_rds_dashboard' }] },
        };
      case 'QueryMetricList':
        return {
          Code: '200',
          Success: true,
          Datapoints: state.listDatapoints,
          Cursor: '',
        };
      case 'QueryMetricLast':
        return {
          Code: '200',
          Success: true,
          Datapoints: state.lastDatapoints,
          Cursor: '',
        };
      case 'ListMyGroups':
        return {
          Code: '200',
          Success: true,
          Resources: { Resource: [{ GroupId: '7', GroupName: 'mygroup' }] },
        };
      default:
        return {};
    }
  }
  return {};
}

function makeDataSource() {
  return new DataSource({
    id: 1,
    uid: 'test',
    type: 'aliyun_cms_grafana_datasource',
    name: 'CMS test',
    jsonData: { userId: '12345' },
  } as any);
}

function makeOptions(targets: CmsQuery[]) {
  return {
    targets,
    range: {
      from: { valueOf: () => 1700000000000 },
      to: { valueOf: () => 1700003600000 },
    },
    scopedVars: {},
  } as any;
}

describe('DataSource', () => {
  beforeEach(() => {
    backendCalls.length = 0;
    state.lastDatapoints = '[]';
    state.listDatapoints = JSON.stringify(datapoints);
  });

  describe('query', () => {
    it('returns an empty result for targets without required fields', async () => {
      const ds = makeDataSource();
      const result = await ds.query(makeOptions([{ refId: 'A', project: '', metric: '', ycol: [] }]));
      expect(result.data).toHaveLength(0);
      expect(backendCalls).toHaveLength(0);
    });

    it('builds the request, groups datapoints by dimension and returns data frames', async () => {
      const ds = makeDataSource();
      const result = await ds.query(
        makeOptions([
          {
            refId: 'A',
            project: 'acs_ecs_dashboard',
            metric: 'cpu_total',
            period: '60',
            ycol: ['Average'],
            dimensions: ['{"instanceId":"i-1"}'],
          },
        ])
      );

      // one request to fetch metric meta + one for the metric list
      const actions = backendCalls.map((c) => c.params.Action);
      expect(actions).toContain('QueryMetricMeta');
      expect(actions).toContain('QueryMetricList');

      const listCall = backendCalls.find((c) => c.params.Action === 'QueryMetricList');
      expect(listCall?.params.Project).toBe('acs_ecs_dashboard');
      expect(listCall?.params.Metric).toBe('cpu_total');
      expect(listCall?.params.Period).toBe('60');
      expect(listCall?.params.Dimensions).toBe('[{"instanceId":"i-1"}]');
      expect(listCall?.params.StartTime).toBe('1700000000000');
      expect(listCall?.params.EndTime).toBe('1700003600000');

      // grouping key is built from non-userId dimension keys only
      expect(result.data).toHaveLength(2);
      const names = result.data.map((f) => f.name).sort();
      expect(names).toEqual(['i-1.Average', 'i-2.Average']);

      const frame = result.data.find((f) => f.name === 'i-1.Average');
      expect(frame).toBeDefined();
      // points are sorted by time
      expect(frame!.fields[0].values.map(Number)).toEqual([1000, 2000]);
      expect(frame!.fields[1].values.map(Number)).toEqual([1.5, 2.5]);
      expect(frame!.refId).toBe('A');
    });

    it('expands multi-value template variables in dimensions and y columns', async () => {
      const ds = makeDataSource();
      const result = await ds.query(
        makeOptions([
          {
            refId: 'A',
            project: 'acs_ecs_dashboard',
            metric: 'cpu_total',
            ycol: ['$dim'],
            dimensions: ['{"instanceId":"$inst"}'],
          },
        ])
      );

      const listCall = backendCalls.find((c) => c.params.Action === 'QueryMetricList');
      expect(listCall?.params.Dimensions).toBe('[{"instanceId":"i-1"}]');

      // $dim resolves to [d1, d2] -> two value columns per group
      const names = result.data.map((f) => f.name).sort();
      expect(names).toEqual(['i-1.d1', 'i-1.d2', 'i-2.d1', 'i-2.d2']);
    });

    it('uses groupId + single dimension for acs_custom projects', async () => {
      const ds = makeDataSource();
      await ds.query(
        makeOptions([
          {
            refId: 'A',
            project: 'acs_customMetric_12345',
            metric: 'my_metric',
            group: '7',
            ycol: ['Average'],
            dimensions: ['{"x":"y"}'],
          },
        ])
      );

      const listCall = backendCalls.find((c) => c.params.Action === 'QueryMetricList');
      expect(listCall?.params.Dimensions).toBe('{"groupId":"7","dimension":"{\\"x\\":\\"y\\"}"}');
    });

    it('prefixes series names with describe', async () => {
      const ds = makeDataSource();
      const result = await ds.query(
        makeOptions([
          {
            refId: 'A',
            project: 'acs_ecs_dashboard',
            metric: 'cpu_total',
            ycol: ['Average'],
            describe: 'ecs',
            dimensions: ['{"instanceId":"i-1"}'],
          },
        ])
      );
      expect(result.data.map((f) => f.name)).toEqual(['ecs.i-1.Average', 'ecs.i-2.Average']);
    });
  });

  describe('metricFindQuery', () => {
    it('lists and filters namespaces', async () => {
      const ds = makeDataSource();
      const result = await ds.metricFindQuery('namespaces(ecs)');
      expect(result).toEqual([{ text: 'acs_ecs_dashboard', value: 'acs_ecs_dashboard' }]);

      const all = await ds.metricFindQuery('namespaces(rds)');
      expect(all).toEqual([{ text: 'acs_rds_dashboard', value: 'acs_rds_dashboard' }]);
    });

    it('lists metrics of a namespace (two-arg form used by legacy dashboards)', async () => {
      const ds = makeDataSource();
      const result = await ds.metricFindQuery('metric(acs_ecs_dashboard,null)');
      expect(result).toEqual([{ text: 'cpu_total', value: 'cpu_total' }]);

      const filtered = await ds.metricFindQuery('metric(acs_ecs_dashboard,cpu)');
      expect(filtered).toEqual([{ text: 'cpu_total', value: 'cpu_total' }]);
    });

    it('returns empty array for unknown query syntax', async () => {
      const ds = makeDataSource();
      const result = await ds.metricFindQuery('something()');
      expect(result).toEqual([]);
    });
  });

  describe('metadata helpers', () => {
    it('returns periods with auto prepended', async () => {
      const ds = makeDataSource();
      const result = await ds.getPeriod('acs_ecs_dashboard', 'cpu_total');
      expect(result.map((r) => r.value)).toEqual(['auto', '60', '300']);
    });

    it('returns statistics', async () => {
      const ds = makeDataSource();
      const result = await ds.getStatistics('acs_ecs_dashboard', 'cpu_total');
      expect(result.map((r) => r.value)).toEqual(['Average', 'Maximum']);
    });

    it('returns monitor groups with name / id labels', async () => {
      const ds = makeDataSource();
      const result = await ds.getGroups();
      expect(result).toEqual([{ text: 'mygroup / 7', value: '7' }]);
    });

    it('appends custom/log monitoring namespaces to the project list', async () => {
      const ds = makeDataSource();
      const result = await ds.getProject();
      const values = result.map((r) => r.value);
      expect(values).toContain('acs_ecs_dashboard');
      expect(values).toContain('acs_logMonitor_12345');
      expect(values).toContain('acs_customMetric_12345');
    });
  });

  describe('getDimensions', () => {
    it('builds options from QueryMetricLast data when present', async () => {
      state.lastDatapoints = JSON.stringify(datapoints);
      const ds = makeDataSource();
      const result = await ds.getDimensions('acs_ecs_dashboard', 'cpu_total', 'auto', []);

      const actions = backendCalls.map((c) => c.params.Action);
      expect(actions).toContain('QueryMetricLast');
      expect(actions).not.toContain('QueryMetricList');

      expect(result).toEqual([
        { text: '{"instanceId":"i-1"}', value: '{"instanceId":"i-1"}' },
        { text: '{"instanceId":"i-2"}', value: '{"instanceId":"i-2"}' },
      ]);
    });

    it('falls back to QueryMetricList over a longer window when QueryMetricLast has no data', async () => {
      // sparse metric (e.g. MNS queue): nothing reported in the recent window
      const ds = makeDataSource();
      const result = await ds.getDimensions('acs_mns_new', 'ActiveMessages', 'auto', []);

      const listCall = backendCalls.find((c) => c.params.Action === 'QueryMetricList');
      expect(listCall).toBeDefined();
      expect(listCall?.params.Project).toBe('acs_mns_new');
      expect(listCall?.params.Metric).toBe('ActiveMessages');
      // period taken from the metric meta (largest supported = 300)
      expect(listCall?.params.Period).toBe('300');
      expect(listCall?.params.Length).toBe('1000');
      // ~72h fallback window
      const window = Number(listCall?.params.EndTime) - Number(listCall?.params.StartTime);
      expect(window).toBe(72 * 60 * 60 * 1000);

      expect(result).toEqual([
        { text: '{"instanceId":"i-1"}', value: '{"instanceId":"i-1"}' },
        { text: '{"instanceId":"i-2"}', value: '{"instanceId":"i-2"}' },
      ]);
    });

    it('returns empty when neither QueryMetricLast nor the fallback yields data', async () => {
      state.listDatapoints = '[]';
      const ds = makeDataSource();
      const result = await ds.getDimensions('acs_mns_new', 'NeverReported', 'auto', []);
      expect(result).toEqual([]);
    });
  });
});
