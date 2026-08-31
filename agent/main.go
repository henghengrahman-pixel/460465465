package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const Version = "1.3.1"

var DefaultServerURL = "https://460465465-production.up.railway.app"
var DefaultEnrollSecret = "cb455b612af9265b8fd084d11ba5516beb8c55efcdd4cac1"
var DefaultOfficeName = "UNASSIGNED"

type Config struct {
	ServerURL        string `json:"serverUrl"`
	EnrollSecret     string `json:"enrollSecret"`
	DeviceUID        string `json:"deviceUid"`
	DeviceToken      string `json:"deviceToken"`
	OfficeName       string `json:"officeName"`
	HeartbeatSeconds int    `json:"heartbeatSeconds"`
}
type Command struct {
	ID      string         `json:"id"`
	Type    string         `json:"command_type"`
	Payload map[string]any `json:"payload"`
}
type commandResp struct {
	OK       bool      `json:"ok"`
	Commands []Command `json:"commands"`
}

var cfg Config
var mu sync.Mutex
var lastApp, lastTitle string
var logger *log.Logger

func dataDir() string {
	base := os.Getenv("PROGRAMDATA")
	if base == "" {
		base = "."
	}
	return filepath.Join(base, "StaffMonitor")
}
func cfgPath() string            { return filepath.Join(dataDir(), "config.json") }
func logPath(mode string) string { return filepath.Join(dataDir(), "logs", "agent-"+mode+".log") }
func initLogger(mode string) {
	_ = os.MkdirAll(filepath.Dir(logPath(mode)), 0755)
	f, e := os.OpenFile(logPath(mode), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if e != nil {
		logger = log.New(io.Discard, "", log.LstdFlags)
		return
	}
	logger = log.New(f, "", log.LstdFlags|log.Lmicroseconds)
}
func randomID() string { b := make([]byte, 16); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func envOr(k, v string) string {
	if x := strings.TrimSpace(os.Getenv(k)); x != "" {
		return x
	}
	return v
}
func loadConfig() error {
	b, e := os.ReadFile(cfgPath())
	if e != nil {
		return e
	}
	return json.Unmarshal(b, &cfg)
}
func saveConfig() error {
	_ = os.MkdirAll(dataDir(), 0755)
	b, _ := json.MarshalIndent(cfg, "", "  ")
	return os.WriteFile(cfgPath(), b, 0600)
}
func initConfig() {
	if loadConfig() == nil {
		if x := strings.TrimSpace(os.Getenv("STAFFMON_SERVER")); x != "" {
			cfg.ServerURL = strings.TrimRight(x, "/")
		}
		if x := strings.TrimSpace(os.Getenv("STAFFMON_ENROLL_SECRET")); x != "" {
			cfg.EnrollSecret = x
		}
		if cfg.ServerURL == "" || strings.Contains(cfg.ServerURL, "localhost") {
			cfg.ServerURL = DefaultServerURL
		}
		if cfg.EnrollSecret == "" {
			cfg.EnrollSecret = DefaultEnrollSecret
		}
		if cfg.DeviceUID == "" {
			cfg.DeviceUID = randomID()
		}
		if cfg.HeartbeatSeconds < 15 {
			cfg.HeartbeatSeconds = 20
		}
		_ = saveConfig()
		return
	}
	cfg = Config{ServerURL: strings.TrimRight(envOr("STAFFMON_SERVER", DefaultServerURL), "/"), EnrollSecret: envOr("STAFFMON_ENROLL_SECRET", DefaultEnrollSecret), DeviceUID: randomID(), OfficeName: envOr("STAFFMON_OFFICE", DefaultOfficeName), HeartbeatSeconds: 20}
	_ = saveConfig()
}
func request(method, path string, body any, deviceAuth bool) ([]byte, int, error) {
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, e := http.NewRequest(method, cfg.ServerURL+path, rdr)
	if e != nil {
		return nil, 0, e
	}
	req.Header.Set("Content-Type", "application/json")
	if deviceAuth {
		req.Header.Set("X-Device-ID", cfg.DeviceUID)
		req.Header.Set("X-Device-Token", cfg.DeviceToken)
	}
	resp, e := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if e != nil {
		return nil, 0, e
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	return b, resp.StatusCode, nil
}
func enroll() error {
	host, _ := os.Hostname()
	body := map[string]any{"deviceUid": cfg.DeviceUID, "name": host, "os": "windows", "agentVersion": Version, "officeName": cfg.OfficeName}
	b, _ := json.Marshal(body)
	req, e := http.NewRequest("POST", cfg.ServerURL+"/api/agent/enroll", bytes.NewReader(b))
	if e != nil {
		return e
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Enroll-Secret", cfg.EnrollSecret)
	resp, e := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if e != nil {
		return e
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("enroll HTTP %d: %s", resp.StatusCode, string(raw))
	}
	var out struct {
		OK          bool   `json:"ok"`
		DeviceToken string `json:"deviceToken"`
	}
	if json.Unmarshal(raw, &out) != nil || !out.OK || out.DeviceToken == "" {
		return errors.New("invalid enroll response")
	}
	cfg.DeviceToken = out.DeviceToken
	logger.Printf("enrolled uid=%s", cfg.DeviceUID)
	return saveConfig()
}
func ensureEnroll() bool {
	if cfg.DeviceToken != "" {
		return true
	}
	for i := 0; i < 12; i++ {
		if e := enroll(); e == nil {
			return true
		} else {
			logger.Printf("enroll %d failed: %v", i+1, e)
		}
		time.Sleep(5 * time.Second)
	}
	return false
}
func sendSystemHeartbeat() {
	_, code, e := request("POST", "/api/agent/system-heartbeat", map[string]any{"os": "windows", "agentVersion": Version}, true)
	if e != nil {
		logger.Printf("system heartbeat error: %v", e)
	} else if code >= 300 {
		logger.Printf("system heartbeat HTTP %d", code)
	}
}
func sendHeartbeat(status, app, title string) {
	_, code, e := request("POST", "/api/agent/heartbeat", map[string]any{"status": status, "currentApp": app, "currentTitle": title, "os": "windows", "agentVersion": Version}, true)
	if e != nil {
		logger.Printf("heartbeat error: %v", e)
		return
	}
	if code == 401 {
		logger.Printf("heartbeat unauthorized")
		return
	}
	if code >= 300 {
		logger.Printf("heartbeat HTTP %d", code)
	}
}
func sendActivity(app, title, event string) {
	_, code, e := request("POST", "/api/agent/activity", map[string]any{"occurredAt": time.Now().UTC().Format(time.RFC3339), "eventType": event, "appName": app, "processName": app, "windowTitle": title}, true)
	if e != nil {
		logger.Printf("activity error: %v", e)
	} else if code >= 300 {
		logger.Printf("activity HTTP %d", code)
	}
}
func pollCommands() {
	b, code, e := request("GET", "/api/agent/commands", nil, true)
	if e != nil {
		logger.Printf("command poll: %v", e)
		return
	}
	if code >= 300 {
		return
	}
	var out commandResp
	if json.Unmarshal(b, &out) != nil {
		return
	}
	for _, c := range out.Commands {
		ok, result := execute(c)
		_, _, _ = request("POST", "/api/agent/commands/"+c.ID+"/ack", map[string]any{"ok": ok, "result": result}, true)
	}
}
func payloadDomains(v any) []string {
	out := []string{}
	switch x := v.(type) {
	case []any:
		for _, a := range x {
			if z, ok := a.(string); ok {
				out = append(out, z)
			}
		}
	case []string:
		out = append(out, x...)
	case string:
		for _, z := range strings.FieldsFunc(x, func(r rune) bool { return r == ',' || r == ';' || r == '\n' || r == '\r' }) {
			out = append(out, z)
		}
	}
	return out
}
func blockDomains(domains []string) (bool, string) {
	if len(domains) == 0 {
		return false, "daftar domain kosong"
	}
	if len(domains) > 500 {
		return false, "maksimal 500 domain per perintah"
	}
	okCount := 0
	fails := []string{}
	for _, d := range domains {
		if ok, res := blockDomain(d); ok {
			okCount++
		} else {
			fails = append(fails, cleanDomain(d)+": "+res)
		}
	}
	if len(fails) > 0 {
		return false, fmt.Sprintf("%d berhasil, %d gagal: %s", okCount, len(fails), strings.Join(fails, " | "))
	}
	return true, fmt.Sprintf("%d domain diblokir", okCount)
}
func unblockDomains(domains []string) (bool, string) {
	if len(domains) == 0 {
		return false, "daftar domain kosong"
	}
	if len(domains) > 500 {
		return false, "maksimal 500 domain per perintah"
	}
	okCount := 0
	fails := []string{}
	for _, d := range domains {
		if ok, res := unblockDomain(d); ok {
			okCount++
		} else {
			fails = append(fails, cleanDomain(d)+": "+res)
		}
	}
	if len(fails) > 0 {
		return false, fmt.Sprintf("%d berhasil, %d gagal: %s", okCount, len(fails), strings.Join(fails, " | "))
	}
	return true, fmt.Sprintf("%d domain dibuka", okCount)
}
func execute(c Command) (bool, string) {
	switch c.Type {
	case "WARN":
		msg, _ := c.Payload["message"].(string)
		if msg == "" {
			msg = "Pesan dari administrator"
		}
		return showWarning(msg)
	case "CLOSE_APP":
		p, _ := c.Payload["processName"].(string)
		return closeProcess(p)
	case "BLOCK_DOMAIN":
		domain, _ := c.Payload["domain"].(string)
		closeBrowser, _ := c.Payload["closeBrowser"].(bool)
		ok, res := blockDomain(domain)
		if ok && closeBrowser {
			_, _ = closeProcess("chrome.exe")
			_, _ = closeProcess("msedge.exe")
			_, _ = closeProcess("firefox.exe")
		}
		return ok, res
	case "UNBLOCK_DOMAIN":
		domain, _ := c.Payload["domain"].(string)
		return unblockDomain(domain)
	case "BLOCK_DOMAINS":
		domains := payloadDomains(c.Payload["domains"])
		ok, res := blockDomains(domains)
		if closeBrowser, _ := c.Payload["closeBrowser"].(bool); ok && closeBrowser {
			_, _ = closeProcess("chrome.exe")
			_, _ = closeProcess("msedge.exe")
			_, _ = closeProcess("firefox.exe")
		}
		return ok, res
	case "UNBLOCK_DOMAINS":
		return unblockDomains(payloadDomains(c.Payload["domains"]))
	default:
		return false, "unknown command"
	}
}
func closeProcess(name string) (bool, string) {
	name = strings.TrimSpace(name)
	if name == "" {
		return false, "processName kosong"
	}
	out, e := exec.Command("taskkill", "/IM", name, "/F").CombinedOutput()
	if e != nil {
		return false, string(out)
	}
	return true, string(out)
}
func showWarning(msg string) (bool, string) {
	out, e := exec.Command("msg.exe", "*", msg).CombinedOutput()
	if e != nil {
		return false, string(out)
	}
	return true, "warning displayed"
}
func cleanDomain(s string) string {
	s = strings.TrimSpace(strings.ToLower(s))
	s = strings.TrimPrefix(s, "https://")
	s = strings.TrimPrefix(s, "http://")
	if i := strings.Index(s, "/"); i >= 0 {
		s = s[:i]
	}
	s = strings.TrimPrefix(s, "www.")
	return s
}
func hostsPath() string {
	return filepath.Join(os.Getenv("SystemRoot"), "System32", "drivers", "etc", "hosts")
}
func blockDomain(domain string) (bool, string) {
	d := cleanDomain(domain)
	if d == "" || strings.ContainsAny(d, " \t\\") || !strings.Contains(d, ".") {
		return false, "domain tidak valid"
	}
	b, e := os.ReadFile(hostsPath())
	if e != nil {
		return false, e.Error()
	}
	marker := "# StaffMonitor " + d
	txt := string(b)
	if strings.Contains(txt, marker) {
		return true, "already blocked"
	}
	entry := fmt.Sprintf("\r\n127.0.0.1 %s %s %s\r\n", d, "www."+d, marker)
	if e = os.WriteFile(hostsPath(), append(b, []byte(entry)...), 0644); e != nil {
		return false, e.Error()
	}
	_ = exec.Command("ipconfig", "/flushdns").Run()
	return true, "blocked " + d
}
func unblockDomain(domain string) (bool, string) {
	d := cleanDomain(domain)
	b, e := os.ReadFile(hostsPath())
	if e != nil {
		return false, e.Error()
	}
	lines := strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
	out := lines[:0]
	for _, line := range lines {
		if !strings.Contains(line, "# StaffMonitor "+d) {
			out = append(out, line)
		}
	}
	if e = os.WriteFile(hostsPath(), []byte(strings.Join(out, "\r\n")), 0644); e != nil {
		return false, e.Error()
	}
	_ = exec.Command("ipconfig", "/flushdns").Run()
	return true, "unblocked " + d
}
func systemLoop() {
	logger.Printf("system loop starting")
	ensureEnroll()
	hb := time.NewTicker(20 * time.Second)
	cmd := time.NewTicker(2 * time.Second)
	defer hb.Stop()
	defer cmd.Stop()
	sendSystemHeartbeat()
	for {
		select {
		case <-hb.C:
			sendSystemHeartbeat()
		case <-cmd.C:
			pollCommands()
		}
	}
}
func liveActive() bool {
	b, code, e := request("GET", "/api/agent/live-state", nil, true)
	if e != nil || code >= 300 {
		return false
	}
	var o struct {
		Active bool `json:"active"`
	}
	return json.Unmarshal(b, &o) == nil && o.Active
}
func sendFrame() {
	frame, w, h, e := captureScreenJPEG()
	if e != nil {
		logger.Printf("capture: %v", e)
		return
	}
	_, code, e := request("POST", "/api/agent/live-frame", map[string]any{"jpegBase64": frame, "width": w, "height": h, "capturedAt": time.Now().UTC().Format(time.RFC3339)}, true)
	if e != nil {
		logger.Printf("frame: %v", e)
	} else if code >= 300 {
		logger.Printf("frame HTTP %d", code)
	}
}
func userLoop() {
	logger.Printf("user loop starting")
	if !ensureEnroll() {
		return
	}
	activity := time.NewTicker(2 * time.Second)
	hb := time.NewTicker(10 * time.Second)
	livePoll := time.NewTicker(2 * time.Second)
	defer activity.Stop()
	defer hb.Stop()
	defer livePoll.Stop()
	live := false
	var frameTick *time.Ticker
	for {
		var fc <-chan time.Time
		if frameTick != nil {
			fc = frameTick.C
		}
		select {
		case <-activity.C:
			app, title := foreground()
			mu.Lock()
			if app != lastApp || title != lastTitle {
				lastApp, lastTitle = app, title
				go sendActivity(app, title, "ACTIVE")
			}
			mu.Unlock()
		case <-hb.C:
			app, title := foreground()
			st := "ACTIVE"
			if idleSeconds() >= 300 {
				st = "IDLE"
			}
			sendHeartbeat(st, app, title)
		case <-livePoll.C:
			a := liveActive()
			if a && !live {
				frameTick = time.NewTicker(700 * time.Millisecond)
				live = true
				go sendFrame()
			} else if !a && live {
				frameTick.Stop()
				frameTick = nil
				live = false
			}
		case <-fc:
			go sendFrame()
		}
	}
}
func main() {
	mode := "user"
	if len(os.Args) > 1 && os.Args[1] == "--system" {
		mode = "system"
	}
	initLogger(mode)
	initConfig()
	logger.Printf("agent starting v=%s mode=%s", Version, mode)
	if mode == "system" {
		systemLoop()
	} else {
		userLoop()
	}
}
