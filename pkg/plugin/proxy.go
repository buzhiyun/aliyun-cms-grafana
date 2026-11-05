package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	cms "github.com/alibabacloud-go/cms-20190101/v10/client"
	openapi "github.com/alibabacloud-go/darabonba-openapi/v2/client"
	ecs "github.com/alibabacloud-go/ecs-20140526/v7/client"
	rds "github.com/alibabacloud-go/rds-20140815/v12/client"
	"github.com/alibabacloud-go/tea/tea"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/aliyun/aliyun-cms-grafana/pkg/models"
)

// ---------------------------------------------------------------------------
// clients

func createCmsClient(s *models.PluginSettings) (*cms.Client, error) {
	config := &openapi.Config{
		AccessKeyId:     tea.String(s.AccessKeyId),
		AccessKeySecret: tea.String(s.AccessKeySecret),
		Endpoint:        tea.String("metrics.cn-hangzhou.aliyuncs.com"),
		Protocol:        tea.String("https"),
	}
	return cms.NewClient(config)
}

func createEcsClient(s *models.PluginSettings) (*ecs.Client, error) {
	config := &openapi.Config{
		AccessKeyId:     tea.String(s.AccessKeyId),
		AccessKeySecret: tea.String(s.AccessKeySecret),
		Endpoint:        tea.String("ecs-cn-hangzhou.aliyuncs.com"),
		Protocol:        tea.String("https"),
	}
	return ecs.NewClient(config)
}

func createRdsClient(s *models.PluginSettings) (*rds.Client, error) {
	config := &openapi.Config{
		AccessKeyId:     tea.String(s.AccessKeyId),
		AccessKeySecret: tea.String(s.AccessKeySecret),
		Endpoint:        tea.String("rds.aliyuncs.com"),
		Protocol:        tea.String("https"),
	}
	return rds.NewClient(config)
}

// ---------------------------------------------------------------------------
// helpers

// parseRequestParams flattens the query string into a map.
func parseRequestParams(req *http.Request) (map[string]string, error) {
	result := map[string]string{}
	for k, values := range req.URL.Query() {
		if len(values) > 0 {
			result[k] = values[0]
		}
	}
	if _, hasAction := result["Action"]; !hasAction {
		return result, errors.New("Action parameter is missing")
	}
	return result, nil
}

func handleResponse(rw http.ResponseWriter, data []byte, err error) {
	if err != nil {
		rw.Header().Add("Content-Type", "text/plain")
		rw.WriteHeader(http.StatusInternalServerError)
		_, _ = rw.Write([]byte(err.Error()))
		return
	}
	rw.Header().Add("Content-Type", "application/json")
	rw.WriteHeader(http.StatusOK)
	_, _ = rw.Write(data)
}

func writeProxyResponse(rw http.ResponseWriter, body interface{}, err error) {
	if err != nil {
		log.DefaultLogger.Error("proxy request failed", "error", err)
		handleResponse(rw, nil, err)
		return
	}
	data, err := json.Marshal(body)
	if err != nil {
		log.DefaultLogger.Error("failed to marshal response", "error", err)
		handleResponse(rw, nil, err)
		return
	}
	handleResponse(rw, data, nil)
}

// parseIntParam parses a query parameter, falling back to def when missing or
// invalid.
func parseIntParam(params map[string]string, key string, def int32) int32 {
	if raw, ok := params[key]; ok {
		if value, err := strconv.ParseInt(raw, 10, 32); err == nil {
			return int32(value)
		}
	}
	return def
}

// ---------------------------------------------------------------------------
// Cloud Monitor (CMS) proxies

func proxyListMetricMeta(ctx context.Context, s *models.PluginSettings, params map[string]string, rw http.ResponseWriter) {
	client, err := createCmsClient(s)
	if err != nil {
		writeProxyResponse(rw, nil, err)
		return
	}

	request := &cms.DescribeMetricMetaListRequest{
		PageNumber: tea.Int32(parseIntParam(params, "PageNumber", 1)),
		PageSize:   tea.Int32(parseIntParam(params, "PageSize", 1000)),
	}
	if project, ok := params["Project"]; ok {
		request.Namespace = tea.String(project)
	}
	if metric, ok := params["Metric"]; ok {
		request.MetricName = tea.String(metric)
	}

	body, err := callCMS(ctx, func() (*cms.DescribeMetricMetaListResponseBody, error) {
		response, err := client.DescribeMetricMetaList(request)
		if err != nil {
			return nil, err
		}
		return response.Body, nil
	})
	writeProxyResponse(rw, body, err)
}

func proxyListProjectMeta(ctx context.Context, s *models.PluginSettings, params map[string]string, rw http.ResponseWriter) {
	client, err := createCmsClient(s)
	if err != nil {
		writeProxyResponse(rw, nil, err)
		return
	}

	request := &cms.DescribeProjectMetaRequest{
		PageNumber: tea.Int32(parseIntParam(params, "PageNumber", 1)),
		PageSize:   tea.Int32(parseIntParam(params, "PageSize", 1000)),
	}

	body, err := callCMS(ctx, func() (*cms.DescribeProjectMetaResponseBody, error) {
		response, err := client.DescribeProjectMeta(request)
		if err != nil {
			return nil, err
		}
		return response.Body, nil
	})
	writeProxyResponse(rw, body, err)
}

func proxyListMyGroups(ctx context.Context, s *models.PluginSettings, params map[string]string, rw http.ResponseWriter) {
	client, err := createCmsClient(s)
	if err != nil {
		writeProxyResponse(rw, nil, err)
		return
	}

	request := &cms.DescribeMonitorGroupsRequest{
		PageNumber: tea.Int32(parseIntParam(params, "PageNumber", 1)),
		PageSize:   tea.Int32(parseIntParam(params, "PageSize", 1000)),
	}

	body, err := callCMS(ctx, func() (*cms.DescribeMonitorGroupsResponseBody, error) {
		response, err := client.DescribeMonitorGroups(request)
		if err != nil {
			return nil, err
		}
		return response.Body, nil
	})
	writeProxyResponse(rw, body, err)
}

func newDescribeMetricRequest(params map[string]string) *cms.DescribeMetricListRequest {
	request := &cms.DescribeMetricListRequest{}
	if project, ok := params["Project"]; ok {
		request.Namespace = tea.String(project)
	}
	if metric, ok := params["Metric"]; ok {
		request.MetricName = tea.String(metric)
	}
	if dims, ok := params["Dimensions"]; ok {
		request.Dimensions = tea.String(dims)
	} else {
		request.Dimensions = tea.String("{}")
	}
	if period, ok := params["Period"]; ok && period != "auto" {
		request.Period = tea.String(period)
	}
	if size, ok := params["Length"]; ok {
		request.Length = tea.String(size)
	} else {
		request.Length = tea.String("1440")
	}
	if startTime, ok := params["StartTime"]; ok {
		request.StartTime = tea.String(startTime)
	} else {
		request.StartTime = tea.String("60")
	}
	if endTime, ok := params["EndTime"]; ok {
		request.EndTime = tea.String(endTime)
	} else {
		request.EndTime = tea.String("60")
	}
	return request
}

func proxyQueryMetricData(ctx context.Context, s *models.PluginSettings, params map[string]string, rw http.ResponseWriter) {
	client, err := createCmsClient(s)
	if err != nil {
		writeProxyResponse(rw, nil, err)
		return
	}

	request := newDescribeMetricRequest(params)
	body, err := callCMS(ctx, func() (*cms.DescribeMetricListResponseBody, error) {
		response, err := client.DescribeMetricList(request)
		if err != nil {
			return nil, err
		}
		return response.Body, nil
	})
	writeProxyResponse(rw, body, err)
}

func newDescribeMetricLastRequest(params map[string]string) *cms.DescribeMetricLastRequest {
	request := &cms.DescribeMetricLastRequest{}
	if project, ok := params["Project"]; ok {
		request.Namespace = tea.String(project)
	}
	if metric, ok := params["Metric"]; ok {
		request.MetricName = tea.String(metric)
	}
	if dims, ok := params["Dimensions"]; ok {
		request.Dimensions = tea.String(dims)
	} else {
		request.Dimensions = tea.String("{}")
	}
	if period, ok := params["Period"]; ok && period != "auto" {
		request.Period = tea.String(period)
	}
	if size, ok := params["Length"]; ok {
		request.Length = tea.String(size)
	} else {
		request.Length = tea.String("1440")
	}
	if startTime, ok := params["StartTime"]; ok {
		request.StartTime = tea.String(startTime)
	} else {
		request.StartTime = tea.String("60")
	}
	if endTime, ok := params["EndTime"]; ok {
		request.EndTime = tea.String(endTime)
	} else {
		request.EndTime = tea.String("60")
	}
	return request
}

func proxyQueryMetricLast(ctx context.Context, s *models.PluginSettings, params map[string]string, rw http.ResponseWriter) {
	client, err := createCmsClient(s)
	if err != nil {
		writeProxyResponse(rw, nil, err)
		return
	}

	request := newDescribeMetricLastRequest(params)
	body, err := callCMS(ctx, func() (*cms.DescribeMetricLastResponseBody, error) {
		response, err := client.DescribeMetricLast(request)
		if err != nil {
			return nil, err
		}
		return response.Body, nil
	})
	writeProxyResponse(rw, body, err)
}

// ---------------------------------------------------------------------------
// RDS proxies

func proxyRdsDescribeTags(s *models.PluginSettings, params map[string]string, rw http.ResponseWriter) {
	client, err := createRdsClient(s)
	if err != nil {
		writeProxyResponse(rw, nil, err)
		return
	}

	request := &rds.DescribeTagsRequest{}
	if regionID, ok := params["RegionId"]; ok {
		request.RegionId = tea.String(regionID)
	}
	if instanceID, ok := params["DBInstanceId"]; ok {
		request.DBInstanceId = tea.String(instanceID)
	}

	response, err := client.DescribeTags(request)
	writeProxyResponse(rw, response.Body, err)
}

func proxyRdsListTagResources(s *models.PluginSettings, params map[string]string, rw http.ResponseWriter) {
	client, err := createRdsClient(s)
	if err != nil {
		writeProxyResponse(rw, nil, err)
		return
	}

	request := &rds.ListTagResourcesRequest{}
	if regionID, ok := params["RegionId"]; ok {
		request.RegionId = tea.String(regionID)
	} else {
		request.RegionId = tea.String("cn-hangzhou")
	}
	if resourceType, ok := params["ResourceType"]; ok {
		request.ResourceType = tea.String(resourceType)
	} else {
		request.ResourceType = tea.String("INSTANCE")
	}

	// up to 20 tag filters
	tags := []*rds.ListTagResourcesRequestTag{}
	for i := 1; i <= 20; i++ {
		tagObj := &rds.ListTagResourcesRequestTag{}
		if val, ok := params["Tag."+strconv.Itoa(i)+".Key"]; ok {
			tagObj.Key = tea.String(val)
		} else {
			continue
		}
		if val, ok := params["Tag."+strconv.Itoa(i)+".Value"]; ok {
			tagObj.Value = tea.String(val)
		}
		tags = append(tags, tagObj)
	}
	if len(tags) > 0 {
		request.Tag = tags
	}

	// up to 50 resource ids
	resourceIDs := []*string{}
	for i := 1; i <= 50; i++ {
		if val, ok := params["ResourceId."+strconv.Itoa(i)]; ok {
			resourceIDs = append(resourceIDs, tea.String(val))
		}
	}
	if len(resourceIDs) > 0 {
		request.ResourceId = resourceIDs
	}

	if nextToken, ok := params["NextToken"]; ok {
		request.NextToken = tea.String(nextToken)
	}

	response, err := client.ListTagResources(request)
	writeProxyResponse(rw, response.Body, err)
}

// ---------------------------------------------------------------------------
// ECS proxies

func proxyEcsDescribeTags(s *models.PluginSettings, params map[string]string, rw http.ResponseWriter) {
	client, err := createEcsClient(s)
	if err != nil {
		writeProxyResponse(rw, nil, err)
		return
	}

	request := &ecs.DescribeTagsRequest{
		PageSize:   tea.Int32(parseIntParam(params, "PageSize", 100)),
		PageNumber: tea.Int32(parseIntParam(params, "PageNumber", 1)),
	}
	if resourceType, ok := params["ResourceType"]; ok {
		request.ResourceType = tea.String(resourceType)
	}
	if resourceID, ok := params["ResourceId"]; ok {
		request.ResourceId = tea.String(resourceID)
	}
	if category, ok := params["Category"]; ok {
		request.Category = tea.String(category)
	}

	// up to 5 tag filters
	tags := []*ecs.DescribeTagsRequestTag{}
	for i := 1; i <= 5; i++ {
		tagObj := &ecs.DescribeTagsRequestTag{}
		if val, ok := params["Tag."+strconv.Itoa(i)+".Key"]; ok {
			tagObj.Key = tea.String(val)
		} else {
			continue
		}
		if val, ok := params["Tag."+strconv.Itoa(i)+".Value"]; ok {
			tagObj.Value = tea.String(val)
		}
		tags = append(tags, tagObj)
	}
	if len(tags) > 0 {
		request.Tag = tags
	}

	response, err := client.DescribeTags(request)
	writeProxyResponse(rw, response.Body, err)
}

func proxyEcsListTagResources(s *models.PluginSettings, params map[string]string, rw http.ResponseWriter) {
	client, err := createEcsClient(s)
	if err != nil {
		writeProxyResponse(rw, nil, err)
		return
	}

	request := &ecs.ListTagResourcesRequest{}
	if regionID, ok := params["RegionId"]; ok {
		request.RegionId = tea.String(regionID)
	} else {
		request.RegionId = tea.String("cn-hangzhou")
	}
	if resourceType, ok := params["ResourceType"]; ok {
		request.ResourceType = tea.String(resourceType)
	} else {
		request.ResourceType = tea.String("instance")
	}
	if nextToken, ok := params["NextToken"]; ok {
		request.NextToken = tea.String(nextToken)
	}

	// up to 5 tags
	tags := []*ecs.ListTagResourcesRequestTag{}
	for i := 1; i <= 5; i++ {
		tagObj := &ecs.ListTagResourcesRequestTag{}
		if val, ok := params["Tag."+strconv.Itoa(i)+".Key"]; ok {
			tagObj.Key = tea.String(val)
		} else {
			continue
		}
		if val, ok := params["Tag."+strconv.Itoa(i)+".Value"]; ok {
			tagObj.Value = tea.String(val)
		}
		tags = append(tags, tagObj)
	}
	if len(tags) > 0 {
		request.Tag = tags
	}

	// up to 5 tag filters
	tagFilters := []*ecs.ListTagResourcesRequestTagFilter{}
	for i := 1; i <= 5; i++ {
		tagObj := &ecs.ListTagResourcesRequestTagFilter{}
		if val, ok := params["TagFilter."+strconv.Itoa(i)+".TagKey"]; ok {
			tagObj.TagKey = tea.String(val)
		} else {
			continue
		}
		tagFilterValues := []*string{}
		for ii := 1; ii <= 5; ii++ {
			if val, ok := params["TagFilter."+strconv.Itoa(i)+".TagValues."+strconv.Itoa(ii)]; ok {
				tagFilterValues = append(tagFilterValues, tea.String(val))
			}
		}
		if len(tagFilterValues) > 0 {
			tagObj.TagValues = tagFilterValues
		}
		tagFilters = append(tagFilters, tagObj)
	}
	if len(tagFilters) > 0 {
		request.TagFilter = tagFilters
	}

	response, err := client.ListTagResources(request)
	writeProxyResponse(rw, response.Body, err)
}

// ---------------------------------------------------------------------------
// resource routes

// ProxyCmsPopApi proxies Cloud Monitor (CMS) OpenAPI calls.
func (d *Datasource) ProxyCmsPopApi(rw http.ResponseWriter, req *http.Request) {
	params, err := parseRequestParams(req)
	if err != nil {
		handleResponse(rw, nil, err)
		return
	}

	switch params["Action"] {
	case "QueryMetricLast":
		proxyQueryMetricLast(req.Context(), d.settings, params, rw)
	case "QueryMetricList":
		proxyQueryMetricData(req.Context(), d.settings, params, rw)
	case "QueryMetricMeta":
		proxyListMetricMeta(req.Context(), d.settings, params, rw)
	case "QueryProjectMeta":
		proxyListProjectMeta(req.Context(), d.settings, params, rw)
	case "ListMyGroups":
		proxyListMyGroups(req.Context(), d.settings, params, rw)
	default:
		handleResponse(rw, nil, errors.New("unsupported Action: "+params["Action"]))
	}
}

// ProxyEcsPopApi proxies ECS OpenAPI calls.
func (d *Datasource) ProxyEcsPopApi(rw http.ResponseWriter, req *http.Request) {
	params, err := parseRequestParams(req)
	if err != nil {
		handleResponse(rw, nil, err)
		return
	}

	switch params["Action"] {
	case "DescribeTags":
		proxyEcsDescribeTags(d.settings, params, rw)
	case "ListTagResources":
		proxyEcsListTagResources(d.settings, params, rw)
	default:
		handleResponse(rw, nil, errors.New("unsupported Action: "+params["Action"]))
	}
}

// ProxyRdsPopApi proxies RDS OpenAPI calls.
func (d *Datasource) ProxyRdsPopApi(rw http.ResponseWriter, req *http.Request) {
	params, err := parseRequestParams(req)
	if err != nil {
		handleResponse(rw, nil, err)
		return
	}

	switch params["Action"] {
	case "DescribeTags":
		proxyRdsDescribeTags(d.settings, params, rw)
	case "ListTagResources":
		proxyRdsListTagResources(d.settings, params, rw)
	default:
		handleResponse(rw, nil, errors.New("unsupported Action: "+params["Action"]))
	}
}
