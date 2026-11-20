package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

// Runs inside the distroless backend image, which has no curl/wget or shell.
func checkBackendHealth(endpoint string) error {
	client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Get(endpoint)
	if err != nil {
		return errors.New("Go backend health request failed")
	}
	defer response.Body.Close()
	var body struct {
		Status string `json:"status"`
	}
	if response.StatusCode != 200 || response.Header.Get("X-Family-Routes-Service") != "backend" || json.NewDecoder(io.LimitReader(response.Body, 1024)).Decode(&body) != nil || body.Status != "alive" {
		return errors.New("Go backend did not answer /healthz")
	}
	return nil
}
