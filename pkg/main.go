package main

import (
	"os"

	"github.com/grafana/grafana-plugin-sdk-go/backend/datasource"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/aliyun/aliyun-cms-grafana/pkg/plugin"
)

func main() {
	// Manage blocks until Grafana shuts down the plugin process. It creates one
	// plugin instance per configured datasource and disposes it when the
	// datasource configuration changes.
	if err := datasource.Manage("aliyun_cms_grafana_datasource", plugin.NewDatasource, datasource.ManageOpts{}); err != nil {
		log.DefaultLogger.Error(err.Error())
		os.Exit(1)
	}
}
