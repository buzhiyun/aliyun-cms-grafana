package plugin

import (
	"context"
	"errors"
	"testing"
	"time"
)

const throttlingErrMsg = "SDKError: StatusCode: 400 Code: Throttling.User Message: code: 400, Request was denied due to user flow control. request id: 01A1AAB1-378F-55CB-8CD2-F1DDAE006FB3"

func TestIsThrottlingError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"throttling user", errors.New(throttlingErrMsg), true},
		{"throttling api", errors.New("SDKError: StatusCode: 403 Code: Throttling.Api"), true},
		{"flow control text", errors.New("Request was denied due to user flow control"), true},
		{"invalid key", errors.New("SDKError: StatusCode: 400 Code: InvalidAccessKeyId.NotFound"), false},
		{"network error", errors.New("connection refused"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isThrottlingError(tt.err); got != tt.want {
				t.Errorf("isThrottlingError(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}

func TestCallCMSRetriesOnThrottling(t *testing.T) {
	origBase, origJitter := throttleBackoffBase, throttleBackoffJitter
	throttleBackoffBase, throttleBackoffJitter = time.Millisecond, time.Millisecond
	t.Cleanup(func() { throttleBackoffBase, throttleBackoffJitter = origBase, origJitter })

	calls := 0
	res, err := callCMS(context.Background(), func() (string, error) {
		calls++
		if calls < 3 {
			return "", errors.New(throttlingErrMsg)
		}
		return "ok", nil
	})
	if err != nil {
		t.Fatalf("expected success after retries, got error: %v", err)
	}
	if res != "ok" {
		t.Errorf("expected result %q, got %q", "ok", res)
	}
	if calls != 3 {
		t.Errorf("expected 3 calls (2 throttled + 1 success), got %d", calls)
	}
}

func TestCallCMSGivesUpAfterMaxRetries(t *testing.T) {
	origBase, origJitter := throttleBackoffBase, throttleBackoffJitter
	throttleBackoffBase, throttleBackoffJitter = time.Millisecond, time.Millisecond
	t.Cleanup(func() { throttleBackoffBase, throttleBackoffJitter = origBase, origJitter })

	calls := 0
	_, err := callCMS(context.Background(), func() (string, error) {
		calls++
		return "", errors.New(throttlingErrMsg)
	})
	if err == nil {
		t.Fatal("expected the throttling error to surface after exhausting retries")
	}
	if want := maxThrottleRetries + 1; calls != want {
		t.Errorf("expected %d calls, got %d", want, calls)
	}
}

func TestCallCMSDoesNotRetryOtherErrors(t *testing.T) {
	calls := 0
	_, err := callCMS(context.Background(), func() (string, error) {
		calls++
		return "", errors.New("SDKError: StatusCode: 400 Code: InvalidAccessKeyId.NotFound")
	})
	if err == nil {
		t.Fatal("expected the error to be returned")
	}
	if calls != 1 {
		t.Errorf("non-throttling errors must not be retried, got %d calls", calls)
	}
}
