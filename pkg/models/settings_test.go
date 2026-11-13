package models

import (
	"encoding/json"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

func TestLoadPluginSettings(t *testing.T) {
	jsonData, err := json.Marshal(map[string]string{
		"userId":      "1234567890",
		"cmsEndpoint": "metrics.example.com",
		"ecsEndpoint": "ecs.example.com",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	settings, err := LoadPluginSettings(backend.DataSourceInstanceSettings{
		JSONData:              jsonData,
		DecryptedSecureJSONData: map[string]string{
			"cmsAccessKey": "ak",
			"cmsSecretKey": "sk",
		},
	})
	if err != nil {
		t.Fatalf("LoadPluginSettings: %v", err)
	}

	if settings.UserId != "1234567890" {
		t.Errorf("UserId = %q, want 1234567890", settings.UserId)
	}
	if settings.AccessKeyId != "ak" || settings.AccessKeySecret != "sk" {
		t.Errorf("credentials = %q/%q, want ak/sk", settings.AccessKeyId, settings.AccessKeySecret)
	}
	if settings.CmsEndpoint != "metrics.example.com" {
		t.Errorf("CmsEndpoint = %q, want metrics.example.com", settings.CmsEndpoint)
	}
	if settings.EcsEndpoint != "ecs.example.com" {
		t.Errorf("EcsEndpoint = %q, want ecs.example.com", settings.EcsEndpoint)
	}
	// not configured -> empty (the proxy falls back to the built-in default)
	if settings.RdsEndpoint != "" {
		t.Errorf("RdsEndpoint = %q, want empty", settings.RdsEndpoint)
	}
}

func TestLoadPluginSettingsLegacyJsonDataCredentials(t *testing.T) {
	jsonData, err := json.Marshal(map[string]string{
		"userId":       "123",
		"cmsAccessKey": "legacy-ak",
		"cmsSecretKey": "legacy-sk",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	settings, err := LoadPluginSettings(backend.DataSourceInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("LoadPluginSettings: %v", err)
	}
	if settings.AccessKeyId != "legacy-ak" || settings.AccessKeySecret != "legacy-sk" {
		t.Errorf("legacy credentials = %q/%q, want legacy-ak/legacy-sk", settings.AccessKeyId, settings.AccessKeySecret)
	}
}
