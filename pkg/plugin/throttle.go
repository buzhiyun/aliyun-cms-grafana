package plugin

import (
	"context"
	"math/rand"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"golang.org/x/time/rate"
)

// Aliyun Cloud Monitor query APIs (DescribeMetricList / DescribeMetricLast /
// DescribeMetricData / DescribeMetricTop) are limited to 50 QPS per account,
// shared by the account and all its RAM users. Exceeding the limit returns
// HTTP 400 with code "Throttling.User" (Aliyun does not use 429 or a
// Retry-After header). The limits below are deliberately conservative.
const (
	// cmsQPS is the sustained rate the plugin sends CMS requests at. Shared by
	// every datasource instance in this plugin process, since the Aliyun
	// account-level quota is shared too.
	cmsQPS = 25
	// cmsBurst allows short bursts (e.g. a dashboard refresh firing one query
	// per panel simultaneously) to proceed without queueing.
	cmsBurst = 10
	// maxThrottleRetries is how many times a throttled CMS call is retried
	// with exponential backoff before the error is surfaced to Grafana.
	maxThrottleRetries = 3
)

// throttleBackoffBase / throttleBackoffJitter: 400ms, 1.2s, 3.6s (+jitter).
// Variables so tests can shorten the waits.
var (
	throttleBackoffBase   = 400 * time.Millisecond
	throttleBackoffJitter = 250 * time.Millisecond
)

// cmsLimiter smooths request bursts coming from concurrent panels/variables.
var cmsLimiter = rate.NewLimiter(rate.Limit(cmsQPS), cmsBurst)

// isThrottlingError reports whether err is an Aliyun flow-control rejection
// (Throttling.User / Throttling.Api / ...). Such errors are transient and a
// short backoff is enough to recover from Throttling.User.
func isThrottlingError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "Throttling") || strings.Contains(msg, "flow control")
}

// callCMS executes a CMS API call behind the global rate limiter and retries
// throttled calls with exponential backoff. ctx cancels the wait when the
// originating browser request goes away.
func callCMS[T any](ctx context.Context, fn func() (T, error)) (T, error) {
	var zero T
	if err := cmsLimiter.Wait(ctx); err != nil {
		return zero, err
	}

	backoff := throttleBackoffBase
	for attempt := 0; ; attempt++ {
		res, err := fn()
		if err == nil {
			return res, nil
		}
		if !isThrottlingError(err) || attempt >= maxThrottleRetries {
			return zero, err
		}
		sleep := backoff + time.Duration(rand.Int63n(int64(throttleBackoffJitter)))
		log.DefaultLogger.Warn(
			"CMS request throttled by Aliyun, retrying",
			"attempt", attempt+1,
			"backoff", sleep.String(),
			"error", err.Error(),
		)
		select {
		case <-ctx.Done():
			return zero, ctx.Err()
		case <-time.After(sleep):
		}
		backoff *= 3
	}
}
