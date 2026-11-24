package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"tailscale.com/ipn/ipnstate"
)

// hiveServer finds the owner's Hive Server among the machines on their tailnet, for a device's hive-tailnet (main.go) and
// the browser extension's (wasm.go) alike: a machine named hive (hive-1, … when there's more than one) that is online and
// answers /health as Hive, the first one in Tailscale's list. "" when there's none.
func hiveServer(st *ipnstate.Status, c *http.Client) string {
	for _, k := range st.Peers() {
		p := st.Peer[k]
		if !p.Online || !strings.HasPrefix(strings.ToLower(p.HostName), "hive") {
			continue
		}
		host := strings.TrimSuffix(p.DNSName, ".")
		if host == "" && len(p.TailscaleIPs) > 0 {
			host = p.TailscaleIPs[0].String()
		}
		if host != "" && healthy(c, "http://"+host) {
			return "http://" + host
		}
	}
	return ""
}

func healthy(c *http.Client, server string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", server+"/health", nil)
	if err != nil {
		return false
	}
	r, err := c.Do(req)
	if err != nil {
		return false
	}
	defer r.Body.Close()
	var h struct{ Ok bool }
	return json.NewDecoder(r.Body).Decode(&h) == nil && h.Ok
}
