import React from 'react';

import { DataSourcePluginOptionsEditorProps } from '@grafana/data';
import { Field, FieldSet, Input, SecretInput } from '@grafana/ui';

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
    </FieldSet>
  );
}
