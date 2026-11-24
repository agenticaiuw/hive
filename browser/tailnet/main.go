// Tailscale inside Hive's browser extension, for a Hive at home that only its owner's tailnet reaches: a userspace node
// (netstack; control over HTTPS; data over Tailscale's DERP relays by WebSocket, since a browser has no UDP), started the
// way tailscale.com/cmd/tsconnect starts one. tsconnect's own fetch is GET-only, so this is the small part Hive needs:
// hiveTailnet.start, .fetch and .peers, used by ../tailnet.js. build.sh builds it.
package main

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"syscall/js"
	"time"

	"tailscale.com/control/controlclient"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnlocal"
	"tailscale.com/net/netns"
	"tailscale.com/net/tsdial"
	"tailscale.com/tsd"
	"tailscale.com/types/logid"
	"tailscale.com/wgengine"
	"tailscale.com/wgengine/netstack"
)

var (
	lb     *ipnlocal.LocalBackend
	client *http.Client
)

func main() {
	js.Global().Set("hiveTailnet", js.ValueOf(map[string]any{"start": js.FuncOf(start), "fetch": js.FuncOf(fetch), "peers": js.FuncOf(peers)}))
	select {}
}

// start(store, hostname, status): store is {getState(key), setState(key, hex)}, kept by the extension so the node stays
// signed in; status({state, url}) follows the node, url being the login link while it needs signing in.
func start(_ js.Value, args []js.Value) any {
	store, hostname, status := args[0], args[1].String(), args[2]
	logf := log.Printf
	netns.SetEnabled(false)
	sys := tsd.NewSystem()
	sys.Set(jsStore{store})
	dialer := &tsdial.Dialer{Logf: logf}
	dialer.SetBus(sys.Bus.Get())
	eng, err := wgengine.NewUserspaceEngine(logf, wgengine.Config{
		Dialer: dialer, SetSubsystem: sys.Set, ControlKnobs: sys.ControlKnobs(), HealthTracker: sys.HealthTracker.Get(),
		ExtraRootCAs: sys.ExtraRootCAs, Metrics: sys.UserMetricsRegistry(), EventBus: sys.Bus.Get(),
	})
	if err != nil {
		return err.Error()
	}
	sys.Set(eng)
	ns, err := netstack.Create(logf, sys.Tun.Get(), eng, sys.MagicSock.Get(), dialer, sys.DNSManager.Get(), sys.ProxyMapper())
	if err != nil {
		return err.Error()
	}
	sys.Set(ns)
	// Everything this node dials goes over the tailnet, through netstack.
	dialer.UseNetstackForIP = func(netip.Addr) bool { return true }
	dialer.NetstackDialTCP = func(ctx context.Context, dst netip.AddrPort) (net.Conn, error) {
		c, err := ns.DialContextTCP(ctx, dst)
		if err != nil {
			return nil, err // not c: a nil *gonet.TCPConn isn't a nil net.Conn
		}
		return c, nil
	}
	sys.NetstackRouter.Set(true)
	sys.Tun.Get().Start()
	// LoginDefault, not tsconnect's ephemeral login: the browser stays a machine on the tailnet between restarts.
	if lb, err = ipnlocal.NewLocalBackend(logf, logid.PublicID{}, sys, controlclient.LoginDefault); err != nil {
		return err.Error()
	}
	if err := ns.Start(lb); err != nil {
		return err.Error()
	}
	// A home Hive Server is plain HTTP inside the tailnet (WireGuard encrypts it), so no TLS here; control and the relays
	// go over the browser's own HTTPS and WebSocket.
	client = &http.Client{Transport: &http.Transport{DialContext: dialer.UserDial}}

	state, url := "Starting", ""
	lb.SetNotifyCallback(func(n ipn.Notify) {
		if n.State != nil {
			state = n.State.String()
			if *n.State == ipn.NeedsLogin {
				go lb.StartLoginInteractive(context.Background())
			}
			if *n.State == ipn.Running {
				url = ""
			}
		}
		if n.BrowseToURL != nil {
			url = *n.BrowseToURL
		}
		if n.State != nil || n.BrowseToURL != nil {
			status.Invoke(map[string]any{"state": state, "url": url})
		}
	})
	go func() {
		err := lb.Start(ipn.Options{UpdatePrefs: &ipn.Prefs{ControlURL: ipn.DefaultControlURL, WantRunning: true, Hostname: hostname}})
		if err != nil {
			logf("tailnet: %v", err)
		}
	}()
	return nil
}

// fetch(url, {method, headers, body, timeout}) → Promise<{status, headers, body}>, over the tailnet once it's connected.
func fetch(_ js.Value, args []js.Value) any {
	url, init := args[0].String(), args[1]
	str := func(k, def string) string {
		if v := init.Get(k); v.Type() == js.TypeString {
			return v.String()
		}
		return def
	}
	return promise(func() (any, error) {
		timeout := 40 * time.Second
		if t := init.Get("timeout"); t.Type() == js.TypeNumber {
			timeout = time.Duration(t.Int()) * time.Millisecond
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		for lb == nil || lb.State() != ipn.Running {
			select {
			case <-ctx.Done():
				return nil, errors.New("this browser's Tailscale isn't connected: sign in from Hive's toolbar button")
			case <-time.After(250 * time.Millisecond):
			}
		}
		req, err := http.NewRequestWithContext(ctx, str("method", "GET"), url, strings.NewReader(str("body", "")))
		if err != nil {
			return nil, err
		}
		if h := init.Get("headers"); h.Type() == js.TypeObject {
			keys := js.Global().Get("Object").Call("keys", h)
			for i := range keys.Length() {
				k := keys.Index(i).String()
				req.Header.Set(k, h.Get(k).String())
			}
		}
		res, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		defer res.Body.Close()
		body, err := io.ReadAll(res.Body)
		if err != nil {
			return nil, err
		}
		headers := map[string]any{}
		for k, v := range res.Header {
			headers[strings.ToLower(k)] = strings.Join(v, ", ")
		}
		return map[string]any{"status": res.StatusCode, "headers": headers, "body": string(body)}, nil
	})
}

// peers() → [{online, hostName, dnsName, ips}], the other machines on the owner's tailnet (none until it's connected), for
// ../hive.js to find their Hive Server among.
func peers(js.Value, []js.Value) any {
	all := []any{}
	if lb == nil || lb.State() != ipn.Running {
		return all
	}
	for _, p := range lb.Status().Peer {
		ips := []any{}
		for _, ip := range p.TailscaleIPs {
			ips = append(ips, ip.String())
		}
		all = append(all, map[string]any{"online": p.Online, "hostName": p.HostName, "dnsName": p.DNSName, "ips": ips})
	}
	return all
}

// The node's state, as hex strings in the extension's storage.
type jsStore struct{ js.Value }

func (s jsStore) ReadState(id ipn.StateKey) ([]byte, error) {
	v := s.Call("getState", string(id))
	if v.Type() != js.TypeString || v.String() == "" {
		return nil, ipn.ErrStateNotExist
	}
	return hex.DecodeString(v.String())
}

func (s jsStore) WriteState(id ipn.StateKey, bs []byte) error {
	s.Call("setState", string(id), hex.EncodeToString(bs))
	return nil
}

func promise(f func() (any, error)) js.Value {
	return js.Global().Get("Promise").New(js.FuncOf(func(_ js.Value, args []js.Value) any {
		go func() {
			if v, err := f(); err != nil {
				args[1].Invoke(fmt.Sprint(err))
			} else {
				args[0].Invoke(v)
			}
		}()
		return nil
	}))
}
