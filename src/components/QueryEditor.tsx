import React from 'react';

import type { MetricFindValue, QueryEditorProps, SelectableValue } from '@grafana/data';
import { AsyncMultiSelect, AsyncSelect, InlineField, InlineFieldRow, Input } from '@grafana/ui';

import { DataSource } from '../datasource';
import type { CmsDataSourceOptions, CmsQuery } from '../types';
import * as util from '../util';

type Props = QueryEditorProps<DataSource, CmsQuery, CmsDataSourceOptions>;

/**
 * Converts metric find values to select options, filtered by the select's
 * current input (react-select's async mode has client-side filtering disabled
 * by default, so the filtering has to happen inside loadOptions).
 */
const toOptions = (items: MetricFindValue[], input = ''): Array<SelectableValue<string>> => {
  const filter = input.trim().toLowerCase();
  return items
    .filter((i) => !!i.text && (filter === '' || i.text.toLowerCase().includes(filter)))
    .map((i) => ({ label: i.text, value: String(i.value ?? i.text) }));
};

export function QueryEditor({ query, datasource, onChange, onRunQuery }: Props) {
  const q: CmsQuery = {
    project: 'acs_ecs_dashboard',
    metric: '',
    period: '',
    group: '',
    dimensions: [],
    ycol: [],
    xcol: 'timestamp',
    describe: '',
    ...query,
  };

  // Resolve template variables before issuing metadata lookups.
  const project = util.resolveScalar(q.project);
  const metric = util.resolveScalar(q.metric);

  const onSelect =
    (field: keyof CmsQuery) =>
    (option: SelectableValue<string>): void => {
      onChange({ ...q, [field]: option?.value ?? '' });
      onRunQuery();
    };

  const onMultiSelect =
    (field: 'dimensions' | 'ycol') =>
    (options: Array<SelectableValue<string>>): void => {
      onChange({
        ...q,
        [field]: (options ?? []).map((o) => o.value).filter((v): v is string => !!v),
      });
      onRunQuery();
    };

  const onInputBlur =
    (field: 'xcol' | 'describe') =>
    (event: React.FocusEvent<HTMLInputElement>): void => {
      if (event.currentTarget.value !== q[field]) {
        onChange({ ...q, [field]: event.currentTarget.value });
        onRunQuery();
      }
    };

  const hasProjectMetric = !util.isEmpty(project) && !util.isEmpty(metric);

  return (
    <>
      <InlineFieldRow>
        <InlineField
          label="Namespace"
          labelWidth={14}
          tooltip='名字空间,表明监控数据所属产品,如"acs_ecs_dashboard","acs_rds_dashboard";支持自定义监控指标:acs_custom_$uid;日志监控指标:acs_logMonitor_$uid.'
          grow
        >
          <AsyncSelect
            key={`ns-${project}`}
            value={q.project ? { label: q.project, value: q.project } : null}
            loadOptions={(input) => datasource.getProject().then((items) => toOptions(items, input))}
            defaultOptions
            allowCustomValue
            onChange={onSelect('project')}
          />
        </InlineField>
        <InlineField label="Metric" labelWidth={12} tooltip="监控项名称,例如cpu_total、cpu_other." grow>
          <AsyncSelect
            key={`m-${project}`}
            value={q.metric ? { label: q.metric, value: q.metric } : null}
            loadOptions={async (input) =>
              util.isEmpty(project) ? [] : toOptions(await datasource.getMetrics(project), input)
            }
            defaultOptions
            allowCustomValue
            onChange={onSelect('metric')}
          />
        </InlineField>
      </InlineFieldRow>

      <InlineFieldRow>
        <InlineField
          label="Period"
          labelWidth={14}
          tooltip="时间间隔,统一用秒数来计算,例如60,300,900.如果不填写,则按照注册监控项时申明的上报周期来查询原始数据.如果填写统计周期,则查询对应的统计数据."
          grow
        >
          <AsyncSelect
            key={`p-${project}-${metric}`}
            value={q.period ? { label: q.period, value: q.period } : null}
            loadOptions={async (input) =>
              hasProjectMetric ? toOptions(await datasource.getPeriod(project, metric), input) : []
            }
            defaultOptions
            allowCustomValue
            onChange={onSelect('period')}
          />
        </InlineField>
        <InlineField label="Group" labelWidth={12} tooltip="云监控应用分组(自定义监控/日志监控使用)." grow>
          <AsyncSelect
            value={q.group ? { label: q.group, value: q.group } : null}
            loadOptions={(input) => datasource.getGroups().then((items) => toOptions(items, input))}
            defaultOptions
            allowCustomValue
            onChange={onSelect('group')}
          />
        </InlineField>
      </InlineFieldRow>

      <InlineFieldRow>
        <InlineField
          label="Dimensions"
          labelWidth={14}
          tooltip='监控数据维度.样例:{"instanceId":"xx-xxxx";"device":"/xx/xx"},{"instanceId":"xx-xxxx";"state":"xxx"},{"instanceId":"xx-xxxx";"port":"xx";"vip":"0.0.0.0"}'
          grow
        >
          <AsyncMultiSelect
            key={`d-${project}-${metric}`}
            value={(q.dimensions ?? []).map((d) => ({ label: d, value: d }))}
            loadOptions={async (input) =>
              hasProjectMetric
                ? toOptions(
                    await datasource.getDimensions(project, metric, q.period ?? '', q.dimensions ?? []),
                    input
                  )
                : []
            }
            defaultOptions
            allowCustomValue
            closeMenuOnSelect={false}
            onChange={onMultiSelect('dimensions')}
          />
        </InlineField>
      </InlineFieldRow>

      <InlineFieldRow>
        <InlineField label="Y - column" labelWidth={14} tooltip="统计目标,例如Average、Maximum." grow>
          <AsyncMultiSelect
            key={`y-${project}-${metric}`}
            value={(q.ycol ?? []).map((y) => ({ label: y, value: y }))}
            loadOptions={async (input) =>
              hasProjectMetric ? toOptions(await datasource.getStatistics(project, metric), input) : []
            }
            defaultOptions
            allowCustomValue
            closeMenuOnSelect={false}
            onChange={onMultiSelect('ycol')}
          />
        </InlineField>
        <InlineField label="X - column" labelWidth={12} tooltip="时间轴,默认timestamp." grow>
          <Input defaultValue={q.xcol} placeholder="x column name" onBlur={onInputBlur('xcol')} />
        </InlineField>
        <InlineField label="Describe" labelWidth={12} tooltip="相同统计目标区分标识." grow>
          <Input defaultValue={q.describe} placeholder="" onBlur={onInputBlur('describe')} />
        </InlineField>
      </InlineFieldRow>
    </>
  );
}
