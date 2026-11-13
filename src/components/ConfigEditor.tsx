import React from 'react';

import { DataSourcePluginOptionsEditorProps } from '@grafana/data';
import { CollapsableSection, Field, FieldSet, Input, SecretInput } from '@grafana/ui';

import type { CmsDataSourceOptions, CmsSecureJsonData } from '../types';

type Props = DataSourcePluginOptionsEditorProps<CmsDataSourceOptions, CmsSecureJsonData>;

export function ConfigEditor(props: Props) {
  const { options, onOptionsChange } = props;
  const { jsonData, secureJsonData, secureJsonFields } = options;

  // JSON data: Aliyun user id
  const onUserIdChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({
      ...options,
      jsonData: { ...jsonData, userId: event.currentTarget.value },
    });
  };

  // JSON data: optional OpenAPI endpoints
  const onEndpointChange = (key: keyof CmsDataSourceOptions) => (event: React.ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({
      ...options,
      jsonData: { ...jsonData, [key]: event.currentTarget.value },
    });
  };

  // Secure data: AccessKeyId / AccessKeySecret
  const onSecretChange = (key: keyof CmsSecureJsonData) => (event: React.ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({
      ...options,
      secureJsonData: { ...secureJsonData, [key]: event.currentTarget.value },
    });
  };

  const onResetSecret = (key: keyof CmsSecureJsonData) => () => {
    onOptionsChange({
      ...options,
      secureJsonFields: { ...secureJsonFields, [key]: false },
      secureJsonData: { ...secureJsonData, [key]: '' },
    });
  };

  return (
    <FieldSet label="Cloud Monitor service details">
      <Field
        label="Aliyun UserId"
        description="阿里云账号ID(数字串)，用于自定义监控(acs_customMetric)与日志监控(acs_logMonitor)的命名空间"
      >
        <Input value={jsonData.userId ?? ''} onChange={onUserIdChange} placeholder="阿里云ID(数字串)" width={40} />
      </Field>

      <Field label="AccessKeyId">
        <SecretInput
          value={secureJsonData?.cmsAccessKey ?? ''}
          isConfigured={Boolean(secureJsonFields?.cmsAccessKey)}
          onReset={onResetSecret('cmsAccessKey')}
          onChange={onSecretChange('cmsAccessKey')}
          placeholder="LTAI****************"
          width={40}
        />
      </Field>

      <Field label="AccessKeySecret">
        <SecretInput
          value={secureJsonData?.cmsSecretKey ?? ''}
          isConfigured={Boolean(secureJsonFields?.cmsSecretKey)}
          onReset={onResetSecret('cmsSecretKey')}
          onChange={onSecretChange('cmsSecretKey')}
          placeholder="************"
          width={40}
        />
      </Field>

      <CollapsableSection label="API endpoints (advanced)" isOpen={false}>
        <Field
          label="Cloud Monitor (CMS) endpoint"
          description="云监控 OpenAPI 接入点。CMS 是全局服务，一般无需修改；留空使用默认 metrics.cn-hangzhou.aliyuncs.com"
        >
          <Input
            value={jsonData.cmsEndpoint ?? ''}
            onChange={onEndpointChange('cmsEndpoint')}
            placeholder="metrics.cn-hangzhou.aliyuncs.com"
            width={40}
          />
        </Field>
        <Field
          label="ECS endpoint"
          description="ECS OpenAPI 接入点（标签查询用）。留空使用默认 ecs-cn-hangzhou.aliyuncs.com"
        >
          <Input
            value={jsonData.ecsEndpoint ?? ''}
            onChange={onEndpointChange('ecsEndpoint')}
            placeholder="ecs-cn-hangzhou.aliyuncs.com"
            width={40}
          />
        </Field>
        <Field
          label="RDS endpoint"
          description="RDS OpenAPI 接入点（标签查询用）。留空使用默认 rds.aliyuncs.com"
        >
          <Input
            value={jsonData.rdsEndpoint ?? ''}
            onChange={onEndpointChange('rdsEndpoint')}
            placeholder="rds.aliyuncs.com"
            width={40}
          />
        </Field>
      </CollapsableSection>
    </FieldSet>
  );
}
