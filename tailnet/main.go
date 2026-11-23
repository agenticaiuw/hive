// hive-tailnet: Tailscale built into Hive (tailscale.com/tsnet), so a Hive on a laptop at home is reachable by its owner's own
// devices from anywhere, with nobody installing the Tailscale app. Traffic between them is end-to-end encrypted (WireGuard).
//
//	hive-tailnet serve --state DIR --name hive --to 127.0.0.1:8790
//	    the Hive server: joins the owner's tailnet as `name` and serves http://<name>.<tailnet>.ts.net (its 100.x address
//	    when the tailnet has MagicDNS off) through to `to`. Plain HTTP inside the tailnet: WireGuard already encrypts it end to
//	    end and only the owner's devices reach it, so the owner never has to turn on HTTPS certificates in Tailscale's console.
//	hive-tailnet dial --state DIR --name NAME --to http://hive.<tailnet>.ts.net --listen 127.0.0.1:PORT
//	    a Hive device: a plain-HTTP port on this computer that reaches the server across the tailnet
//
// It says what's happening as one JSON line per change on stdout: {"login": url} until the owner signs in, {"address": url}
// once serving, {"error": text}. It
// stops when its stdin closes, so it never outlives the program that started it.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"tailscale.com/tsnet"
)

var (
	mu   sync.Mutex
	last string
)

// say prints a state line once: the same state twice in a row is said once.
func say(v map[string]string) {
	b, _ := json.Marshal(v)
	mu.Lock()
	defer mu.Unlock()
	if string(b) == last {
		return
	}
	last = string(b)
	fmt.Println(string(b))
}

func main() {
	log.SetFlags(0)
	if len(os.Args) < 2 || (os.Args[1] != "serve" && os.Args[1] != "dial") {
		log.Fatal("usage: hive-tailnet serve|dial --state DIR --name NAME --to TARGET [--listen ADDR]")
	}
	mode := os.Args[1]
	f := flag.NewFlagSet(mode, flag.ExitOnError)
	state := f.String("state", "", "where the node keeps its keys")
	name := f.String("name", "hive", "this node's name on the tailnet")
	to := f.String("to", "", "serve: the local Hive server (host:port); dial: the Hive server's tailnet address")
	listen := f.String("listen", "127.0.0.1:0", "dial: the local address to listen on")
	f.Parse(os.Args[2:])
	if *state == "" || *to == "" {
		log.Fatal("--state and --to are required")
	}
	// Whoever started it decides how long it lives.
	go func() { io.Copy(io.Discard, os.Stdin); os.Exit(0) }()

	s := &tsnet.Server{Dir: *state, Hostname: *name, Logf: func(string, ...any) {}, UserLogf: func(string, ...any) {}}
	if err := s.Start(); err != nil {
		say(map[string]string{"error": err.Error()})
		os.Exit(1)
	}
	defer s.Close()
	host := ready(s)
	if mode == "serve" {
		serve(s, host, *to)
	} else {
		dial(s, *to, *listen)
	}
}

// ready waits for the owner's sign-in, saying what they need to do, and returns this node's name on the tailnet (like
// hive.tail1234.ts.net), or its 100.x address when the tailnet has MagicDNS off.
func ready(s *tsnet.Server) string {
	lc, err := s.LocalClient()
	if err != nil {
		say(map[string]string{"error": err.Error()})
		os.Exit(1)
	}
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		st, err := lc.StatusWithoutPeers(ctx)
		cancel()
		switch {
		case err != nil:
			say(map[string]string{"error": err.Error()})
		case st.BackendState == "NeedsLogin" && st.AuthURL != "":
			say(map[string]string{"login": st.AuthURL})
		case st.BackendState == "Running" && st.Self != nil:
			if st.CurrentTailnet != nil && st.CurrentTailnet.MagicDNSEnabled && st.Self.DNSName != "" {
				return strings.TrimSuffix(st.Self.DNSName, ".")
			}
			if ip4, _ := s.TailscaleIPs(); ip4.IsValid() {
				return ip4.String()
			}
		}
		time.Sleep(2 * time.Second)
	}
}

// serve publishes the local Hive server on the tailnet.
func serve(s *tsnet.Server, host, to string) {
	ln, err := s.Listen("tcp", ":80")
	if err != nil {
		say(map[string]string{"error": err.Error()})
		os.Exit(1)
	}
	target := &url.URL{Scheme: "http", Host: to}
	proxy := httputil.NewSingleHostReverseProxy(target)
	// Hive sees who's asking: the tailnet address of the owner's device.
	proxy.Director = func(r *http.Request) {
		peer, _, _ := net.SplitHostPort(r.RemoteAddr)
		r.URL.Scheme, r.URL.Host = target.Scheme, target.Host
		r.Header.Set("X-Forwarded-For", peer)
		r.Header.Set("X-Forwarded-Proto", "http")
	}
	say(map[string]string{"address": "http://" + host})
	if err := http.Serve(ln, proxy); err != nil {
		say(map[string]string{"error": err.Error()})
		os.Exit(1)
	}
}

// dial gives this computer a plain-HTTP port that reaches the Hive server across the tailnet (encrypted by WireGuard).
func dial(s *tsnet.Server, to, listen string) {
	target, err := url.Parse(to)
	if err != nil || target.Host == "" {
		say(map[string]string{"error": "not a server address: " + to})
		os.Exit(1)
	}
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		say(map[string]string{"error": err.Error()})
		os.Exit(1)
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = s.HTTPClient().Transport
	director := proxy.Director
	proxy.Director = func(r *http.Request) { director(r); r.Host = target.Host }
	// The door is plain HTTP on this computer only, where a browser won't keep a Secure cookie.
	proxy.ModifyResponse = func(res *http.Response) error {
		for i, c := range res.Header.Values("Set-Cookie") {
			if i == 0 {
				res.Header.Del("Set-Cookie")
			}
			res.Header.Add("Set-Cookie", strings.ReplaceAll(c, "; Secure", ""))
		}
		return nil
	}
	say(map[string]string{"address": "http://" + ln.Addr().String()})
	if err := http.Serve(ln, proxy); err != nil {
		say(map[string]string{"error": err.Error()})
		os.Exit(1)
	}
}
