package plugin

import (
	"encoding/json"
	"testing"

	cms "github.com/alibabacloud-go/cms-20190101/v10/client"
	"github.com/alibabacloud-go/tea/tea"
)

func TestParseDimensionMatchers(t *testing.T) {
	matchers, err := parseDimensionMatchers(`{"instanceId":"i-1","device":"eth0"}`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(matchers) != 2 {
		t.Fatalf("expected 2 matchers, got %d", len(matchers))
	}
	byLabel := map[string]string{}
	for _, m := range matchers {
		byLabel[tea.StringValue(m.Label)] = tea.StringValue(m.Value)
		if got := tea.StringValue(m.Operator); got != "EQUALS" {
			t.Errorf("matcher operator = %q, want EQUALS", got)
		}
	}
	if byLabel["instanceId"] != "i-1" || byLabel["device"] != "eth0" {
		t.Errorf("unexpected matcher values: %v", byLabel)
	}

	// empty dimensions are allowed (no matchers)
	if matchers, err = parseDimensionMatchers(""); err != nil || matchers != nil {
		t.Errorf("empty dimensions should yield no matchers, got %v, %v", matchers, err)
	}

	// arrays are rejected - the frontend sends one object per query
	if _, err = parseDimensionMatchers(`[{"instanceId":"i-1"}]`); err == nil {
		t.Error("array Dimensions should be rejected")
	}
}

func TestNewCursorRequest(t *testing.T) {
	req, err := newCursorRequest(map[string]string{
		"Project":    "acs_ecs_dashboard",
		"Metric":     "cpu_total",
		"Period":     "60",
		"Dimensions": `{"instanceId":"i-1"}`,
		"StartTime":  "1700000000000",
		"EndTime":    "1700003600000",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tea.StringValue(req.Namespace) != "acs_ecs_dashboard" ||
		tea.StringValue(req.Metric) != "cpu_total" ||
		tea.Int32Value(req.Period) != 60 ||
		tea.StringValue(req.StartTime) != "1700000000000" ||
		tea.StringValue(req.EndTime) != "1700003600000" {
		t.Errorf("unexpected request: %s", req.String())
	}
	if len(req.Matchers) != 1 {
		t.Fatalf("expected 1 matcher, got %d", len(req.Matchers))
	}

	// a missing or non-numeric period is rejected
	for _, period := range []string{"", "auto", "abc"} {
		if _, err = newCursorRequest(map[string]string{"Period": period}); err == nil {
			t.Errorf("Period %q should be rejected", period)
		}
	}
}

func TestConvertBatchExportBody(t *testing.T) {
	body := &cms.BatchExportResponseBody{
		Code: tea.Int32(200),
		DataResults: []*cms.MetricStat{
			{
				Timestamp: tea.Int64(1700000060000),
				Dimensions: []*cms.Dimension{
					{Label: tea.String("instanceId"), Value: tea.String("i-1")},
				},
				Measurements: map[string]interface{}{"Average": 3.5, "Maximum": 9},
			},
			nil, // skipped
		},
		Cursor: tea.String("next-token"),
	}
	result, err := convertBatchExportBody(body)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var points []map[string]interface{}
	if err := json.Unmarshal([]byte(result.Datapoints), &points); err != nil {
		t.Fatalf("Datapoints is not valid JSON: %v", err)
	}
	if len(points) != 1 {
		t.Fatalf("expected 1 datapoint, got %d", len(points))
	}
	p := points[0]
	if p["timestamp"] != float64(1700000060000) || p["instanceId"] != "i-1" ||
		p["Average"] != 3.5 || p["Maximum"] != float64(9) {
		t.Errorf("unexpected datapoint: %v", p)
	}
	if result.Cursor != "next-token" {
		t.Errorf("Cursor = %q, want next-token", result.Cursor)
	}
}

func TestConvertBatchExportBodyErrors(t *testing.T) {
	if _, err := convertBatchExportBody(&cms.BatchExportResponseBody{
		Code:    tea.Int32(400),
		Message: tea.String("failed"),
	}); err == nil {
		t.Error("non-200 code should produce an error")
	}

	// no cursor -> empty Cursor field (frontend stops paginating)
	result, err := convertBatchExportBody(&cms.BatchExportResponseBody{Code: tea.Int32(200)})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Cursor != "" {
		t.Errorf("Cursor = %q, want empty", result.Cursor)
	}
}
