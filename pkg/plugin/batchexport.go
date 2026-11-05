package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	cms "github.com/alibabacloud-go/cms-20190101/v10/client"
	"github.com/alibabacloud-go/tea/tea"

	"github.com/aliyun/aliyun-cms-grafana/pkg/models"
)

// ---------------------------------------------------------------------------
// BatchExport proxy
//
// The BatchExport API is Aliyun's recommended replacement for
// DescribeMetricList in high-throughput scenarios: its QPS limit is 1000
// (vs 50) and it returns up to 10000 datapoints per call (vs 1000).
//
// Unlike DescribeMetricList it is cursor-driven: the first call must obtain a
// cursor token from the separate Cursor API (which carries the query
// definition - namespace/metric/period/range/matchers), then BatchExport
// pages through the data with that token. The token is opaque and returned to
// the frontend, which passes it back as the Cursor query parameter for the
// next page.
//
// The response is converted to the same shape the frontend expects from
// QueryMetricList (JSON-encoded Datapoints + Cursor), so both paths share the
// frontend contract.

// batchExportLengthMax is the BatchExport API's per-call record limit.
const batchExportLengthMax = 10000

// batchExportResult mirrors the DescribeMetricList response shape consumed by
// the frontend (Code/Success omitted - absent means success).
type batchExportResult struct {
	Cursor     string `json:"Cursor,omitempty"`
	Datapoints string `json:"Datapoints"`
}

// parseDimensionMatchers converts a single dimension object (e.g.
// {"instanceId":"i-1","device":"eth0"}) into the Matcher chain expected by
// the Cursor API. Matchers within one object are ANDed; the frontend issues
// one BatchExport query per monitored object, so OR semantics across objects
// are produced by merging the per-object results client-side.
func parseDimensionMatchers(raw string) ([]*cms.Matcher, error) {
	if raw == "" {
		return nil, nil
	}
	var obj map[string]string
	if err := json.Unmarshal([]byte(raw), &obj); err != nil {
		return nil, fmt.Errorf("invalid Dimensions (expected a single JSON object): %w", err)
	}
	matchers := make([]*cms.Matcher, 0, len(obj))
	for label, value := range obj {
		matchers = append(matchers, &cms.Matcher{
			Label:    tea.String(label),
			Operator: tea.String("EQUALS"),
			Value:    tea.String(value),
		})
	}
	return matchers, nil
}

// newCursorRequest builds the Cursor API request from the proxy parameters.
func newCursorRequest(params map[string]string) (*cms.CursorRequest, error) {
	request := &cms.CursorRequest{
		Namespace: tea.String(params["Project"]),
		Metric:    tea.String(params["Metric"]),
		StartTime: tea.String(params["StartTime"]),
		EndTime:   tea.String(params["EndTime"]),
	}
	period, err := strconv.ParseInt(params["Period"], 10, 32)
	if err != nil || period <= 0 {
		return nil, errors.New("BatchExport requires a numeric Period parameter")
	}
	request.Period = tea.Int32(int32(period))
	matchers, err := parseDimensionMatchers(params["Dimensions"])
	if err != nil {
		return nil, err
	}
	request.Matchers = matchers
	return request, nil
}

// convertBatchExportBody maps the BatchExport response onto the legacy
// DescribeMetricList response shape: each MetricStat is flattened into a
// datapoint object holding the timestamp, the dimension key/values and the
// measurement (statistics) values.
func convertBatchExportBody(body *cms.BatchExportResponseBody) (*batchExportResult, error) {
	if code := body.Code; code != nil && *code != 200 {
		return nil, fmt.Errorf("BatchExport failed: code %d, message %s", *code, tea.StringValue(body.Message))
	}
	datapoints := make([]map[string]interface{}, 0, len(body.DataResults))
	for _, stat := range body.DataResults {
		if stat == nil {
			continue
		}
		dp := map[string]interface{}{}
		if stat.Timestamp != nil {
			dp["timestamp"] = *stat.Timestamp
		}
		for _, dim := range stat.Dimensions {
			if dim == nil {
				continue
			}
			dp[tea.StringValue(dim.Label)] = tea.StringValue(dim.Value)
		}
		for name, value := range stat.Measurements {
			dp[name] = value
		}
		datapoints = append(datapoints, dp)
	}
	data, err := json.Marshal(datapoints)
	if err != nil {
		return nil, err
	}
	result := &batchExportResult{Datapoints: string(data)}
	if cursor := body.Cursor; cursor != nil && *cursor != "" {
		result.Cursor = *cursor
	}
	return result, nil
}

// proxyBatchExport serves the BatchExport Action: exchanges the query for a
// cursor token (first page only) and pages through the metric data.
func proxyBatchExport(ctx context.Context, s *models.PluginSettings, params map[string]string, rw http.ResponseWriter) {
	client, err := createCmsClient(s)
	if err != nil {
		writeProxyResponse(rw, nil, err)
		return
	}

	var cursorToken string
	if cursor, ok := params["Cursor"]; ok && cursor != "" {
		// Continuation of a previous page.
		cursorToken = cursor
	} else {
		cursorRequest, err := newCursorRequest(params)
		if err != nil {
			writeProxyResponse(rw, nil, err)
			return
		}
		cursorBody, err := callCMS(ctx, func() (*cms.CursorResponseBody, error) {
			response, err := client.Cursor(cursorRequest)
			if err != nil {
				return nil, err
			}
			return response.Body, nil
		})
		if err != nil {
			writeProxyResponse(rw, nil, err)
			return
		}
		if code := cursorBody.Code; code != nil && *code != 200 {
			writeProxyResponse(rw, nil, fmt.Errorf("Cursor API failed: code %d", *code))
			return
		}
		cursorToken = tea.StringValue(cursorBody.Cursor)
		if cursorToken == "" {
			writeProxyResponse(rw, nil, errors.New("Cursor API returned an empty cursor"))
			return
		}
	}

	length := parseIntParam(params, "Length", batchExportLengthMax)
	if length < 1 {
		length = 1
	}
	if length > batchExportLengthMax {
		length = batchExportLengthMax
	}

	request := &cms.BatchExportRequest{
		Cursor:    tea.String(cursorToken),
		Length:    tea.Int32(length),
		Metric:    tea.String(params["Metric"]),
		Namespace: tea.String(params["Project"]),
	}
	body, err := callCMS(ctx, func() (*cms.BatchExportResponseBody, error) {
		response, err := client.BatchExport(request)
		if err != nil {
			return nil, err
		}
		return response.Body, nil
	})
	if err != nil {
		writeProxyResponse(rw, nil, err)
		return
	}

	result, err := convertBatchExportBody(body)
	writeProxyResponse(rw, result, err)
}
