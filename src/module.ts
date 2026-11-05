import { DataSourcePlugin } from '@grafana/data';

import { DataSource } from './datasource';
import { ConfigEditor } from './components/ConfigEditor';
import { QueryEditor } from './components/QueryEditor';
import type { CmsDataSourceOptions, CmsQuery } from './types';

export const plugin = new DataSourcePlugin<DataSource, CmsQuery, CmsDataSourceOptions>(DataSource)
  .setConfigEditor(ConfigEditor)
  .setQueryEditor(QueryEditor);
