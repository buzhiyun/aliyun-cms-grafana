package models

import (
	"encoding/json"
	"fmt"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// PluginSettings holds the per-datasource instance configuration.
type PluginSettings struct {
	// Aliyun account id, used by the frontend to build the
	// acs_customMetric_<uid> / acs_logMonitor_<uid> namespaces.
	UserId string
	// Aliyun AccessKeyId / AccessKeySecret.
	AccessKeyId     string
	AccessKeySecret string
	// Optional OpenAPI endpoints. Empty means the built-in default (see
	// pkg/plugin/proxy.go), which is what the legacy plugin used.
	CmsEndpoint string
	EcsEndpoint string
	RdsEndpoint string
}

// LoadPluginSettings reads jsonData (userId) and the secureJsonData
// credentials (cmsAccessKey / cmsSecretKey). The field names are kept from
// the legacy plugin so existing datasource configurations keep working.
func LoadPluginSettings(source backend.DataSourceInstanceSettings) (*PluginSettings, error) {
	settings := &PluginSettings{}

	var jsonData struct {
		UserId      string `json:"userId"`
		CmsEndpoint string `json:"cmsEndpoint"`
		EcsEndpoint string `json:"ecsEndpoint"`
		RdsEndpoint string `json:"rdsEndpoint"`
	}
	if len(source.JSONData) > 0 {
		if err := json.Unmarshal(source.JSONData, &jsonData); err != nil {
			return nil, fmt.Errorf("could not unmarshal jsonData: %w", err)
		}
	}
	settings.UserId = jsonData.UserId
	settings.CmsEndpoint = jsonData.CmsEndpoint
	settings.EcsEndpoint = jsonData.EcsEndpoint
	settings.RdsEndpoint = jsonData.RdsEndpoint

	settings.AccessKeyId = source.DecryptedSecureJSONData["cmsAccessKey"]
	settings.AccessKeySecret = source.DecryptedSecureJSONData["cmsSecretKey"]

	// Fallback for the legacy configuration where the credentials were stored
	// unencrypted in jsonData.
	if settings.AccessKeyId == "" {
		var legacy struct {
			CmsAccessKey   string `json:"cmsAccessKey"`
			CmsAcessSecret string `json:"cmsSecretKey"`
		}
		if err := json.Unmarshal(source.JSONData, &legacy); err == nil {
			settings.AccessKeyId = legacy.CmsAccessKey
			settings.AccessKeySecret = legacy.CmsAcessSecret
		}
	}

	return settings, nil
}
