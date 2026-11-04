package plugin

import (
	"context"
	"errors"
	"net/http"

	cms "github.com/alibabacloud-go/cms-20190101/v10/client"
	"github.com/alibabacloud-go/tea/tea"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"

	"github.com/aliyun/aliyun-cms-grafana/pkg/models"
)

var (
	_ backend.CallResourceHandler = (*Datasource)(nil)
	_ backend.CheckHealthHandler   = (*Datasource)(nil)
	_ instancemgmt.Instance        = (*Datasource)(nil)
)

// Datasource serves the Aliyun CMS/ECS/RDS OpenAPI resource proxy used by the
// frontend. Metric queries are assembled and executed from the browser via
// these endpoints; the backend holds the credentials and does the signing.
type Datasource struct {
	backend.CallResourceHandler
	settings *models.PluginSettings
}

// NewDatasource is the instance factory used by datasource.Manage. One
// instance is created per configured datasource.
func NewDatasource(_ context.Context, s backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
	settings, err := models.LoadPluginSettings(s)
	if err != nil {
		return nil, err
	}

	ds := &Datasource{settings: settings}

	mux := http.NewServeMux()
	mux.HandleFunc("/proxy_aliyun_cms_pop", ds.ProxyCmsPopApi)
	mux.HandleFunc("/proxy_aliyun_ecs_pop", ds.ProxyEcsPopApi)
	mux.HandleFunc("/proxy_aliyun_rds_pop", ds.ProxyRdsPopApi)
	ds.CallResourceHandler = httpadapter.New(mux)

	return ds, nil
}

// QueryData is not used: queries run in the browser through the resource
// proxy. A clear error is returned for anything that invokes the backend
// query path (e.g. server-side alerting).
func (d *Datasource) QueryData(_ context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error) {
	response := backend.NewQueryDataResponse()
	for _, q := range req.Queries {
		response.Responses[q.RefID] = backend.DataResponse{
			Error: errors.New("server-side queries are not supported: queries are executed by the datasource frontend via the resource proxy"),
		}
	}
	return response, nil
}

// CheckHealth validates the configured credentials by calling the Cloud
// Monitor API (mirrors the legacy "Save & Test" behaviour).
func (d *Datasource) CheckHealth(_ context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	if d.settings.AccessKeyId == "" || d.settings.AccessKeySecret == "" {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: "AccessKeyId / AccessKeySecret is missing",
		}, nil
	}

	client, err := createCmsClient(d.settings)
	if err != nil {
		log.DefaultLogger.Error("failed to create CMS client", "error", err)
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: "Failed to create CMS client: " + err.Error(),
		}, nil
	}

	request := &cms.DescribeMetricMetaListRequest{
		Namespace: tea.String("acs_ecs_dashboard"),
		PageSize:  tea.Int32(1),
	}
	if _, err := client.DescribeMetricMetaList(request); err != nil {
		log.DefaultLogger.Error("health check failed", "error", err)
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: "Data source is not working: " + err.Error(),
		}, nil
	}

	return &backend.CheckHealthResult{
		Status:  backend.HealthStatusOk,
		Message: "Data source is working",
	}, nil
}
