package main

import (
 "bytes"
 "crypto/rand"
 "encoding/hex"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "net/http"
 "os"
 "os/exec"
 "path/filepath"
 "runtime"
 "strings"
 "sync"
 "time"
)
const Version="1.0.0"
type Config struct{ServerURL string `json:"serverUrl"`; EnrollSecret string `json:"enrollSecret"`; DeviceUID string `json:"deviceUid"`; DeviceToken string `json:"deviceToken"`; OfficeName string `json:"officeName"`; HeartbeatSeconds int `json:"heartbeatSeconds"`}
type Command struct{ID string `json:"id"`; Type string `json:"command_type"`; Payload map[string]any `json:"payload"`}
type heartbeatResp struct{OK bool `json:"ok"`; Commands []Command `json:"commands"`}
var cfg Config; var mu sync.Mutex; var lastApp,lastTitle string
func cfgPath() string{base:=os.Getenv("PROGRAMDATA");if base==""{base="."};return filepath.Join(base,"StaffMonitor","config.json")}
func randomID() string{b:=make([]byte,16);_,_=rand.Read(b);return hex.EncodeToString(b)}
func loadConfig() error{p:=cfgPath();b,e:=os.ReadFile(p);if e!=nil{return e};return json.Unmarshal(b,&cfg)}
func saveConfig() error{p:=cfgPath();_ = os.MkdirAll(filepath.Dir(p),0755);b,_:=json.MarshalIndent(cfg,"","  ");return os.WriteFile(p,b,0600)}
func envOr(k,v string)string{if x:=os.Getenv(k);x!=""{return x};return v}
func initConfig(){if loadConfig()==nil{return};cfg=Config{ServerURL:strings.TrimRight(envOr("STAFFMON_SERVER","http://localhost:8080"),"/"),EnrollSecret:envOr("STAFFMON_ENROLL_SECRET","local-enroll-secret"),DeviceUID:randomID(),OfficeName:envOr("STAFFMON_OFFICE","KANTOR A"),HeartbeatSeconds:20};_ = saveConfig()}
func request(method,path string,body any,deviceAuth bool)([]byte,int,error){var rdr io.Reader;if body!=nil{b,_:=json.Marshal(body);rdr=bytes.NewReader(b)};req,e:=http.NewRequest(method,cfg.ServerURL+path,rdr);if e!=nil{return nil,0,e};req.Header.Set("Content-Type","application/json");if deviceAuth{req.Header.Set("X-Device-ID",cfg.DeviceUID);req.Header.Set("X-Device-Token",cfg.DeviceToken)};cl:=&http.Client{Timeout:10*time.Second};resp,e:=cl.Do(req);if e!=nil{return nil,0,e};defer resp.Body.Close();b,_:=io.ReadAll(io.LimitReader(resp.Body,1<<20));return b,resp.StatusCode,nil}
func enroll() error{host,_:=os.Hostname();body:=map[string]any{"deviceUid":cfg.DeviceUID,"name":host,"os":runtime.GOOS,"agentVersion":Version,"officeName":cfg.OfficeName};b,_:=json.Marshal(body);req,_:=http.NewRequest("POST",cfg.ServerURL+"/api/agent/enroll",bytes.NewReader(b));req.Header.Set("Content-Type","application/json");req.Header.Set("X-Enroll-Secret",cfg.EnrollSecret);resp,e:=(&http.Client{Timeout:15*time.Second}).Do(req);if e!=nil{return e};defer resp.Body.Close();raw,_:=io.ReadAll(resp.Body);if resp.StatusCode>=300{return fmt.Errorf("enroll HTTP %d: %s",resp.StatusCode,string(raw))};var out struct{OK bool `json:"ok"`;DeviceToken string `json:"deviceToken"`};if json.Unmarshal(raw,&out)!=nil||!out.OK||out.DeviceToken==""{return errors.New("invalid enroll response")};cfg.DeviceToken=out.DeviceToken;return saveConfig()}
func sendActivity(app,title,event string){_,_,_=request("POST","/api/agent/activity",map[string]any{"occurredAt":time.Now().UTC().Format(time.RFC3339),"eventType":event,"appName":app,"processName":app,"windowTitle":title},true)}
func heartbeat(){status:="ACTIVE"; app,title:=foreground(); idle:=idleSeconds(); if idle>=300{status="IDLE"}; body:=map[string]any{"status":status,"currentApp":app,"currentTitle":title,"os":runtime.GOOS,"agentVersion":Version};b,code,e:=request("POST","/api/agent/heartbeat",body,true);if e!=nil{return};if code==401{_ = enroll();return};if code>=300{return};var out heartbeatResp;if json.Unmarshal(b,&out)!=nil{return};for _,c:=range out.Commands{ok,result:=execute(c);_,_,_=request("POST","/api/agent/commands/"+c.ID+"/ack",map[string]any{"ok":ok,"result":result},true)}}
func execute(c Command)(bool,string){switch c.Type{case "WARN":msg,_:=c.Payload["message"].(string);if msg==""{msg="Pesan dari administrator"};return showWarning(msg);case "CLOSE_APP":p,_:=c.Payload["processName"].(string);return closeProcess(p);case "SET_POLICY":return true,"policy acknowledged";default:return false,"unknown command"}}
func closeProcess(name string)(bool,string){name=strings.TrimSpace(name);if name==""{return false,"processName kosong"};if runtime.GOOS!="windows"{return false,"close process hanya didukung Windows"};cmd:=exec.Command("taskkill","/IM",name,"/F");out,e:=cmd.CombinedOutput();if e!=nil{return false,string(out)};return true,string(out)}
func showWarning(msg string)(bool,string){if runtime.GOOS!="windows"{return false,"warning popup hanya didukung Windows"};cmd:=exec.Command("msg.exe","*",msg);out,e:=cmd.CombinedOutput();if e!=nil{return false,string(out)};return true,"warning displayed"}
func loop(){ticker:=time.NewTicker(time.Duration(max(cfg.HeartbeatSeconds,15))*time.Second);defer ticker.Stop();for{app,title:=foreground();mu.Lock();if app!=lastApp||title!=lastTitle{lastApp,lastTitle=app,title;go sendActivity(app,title,"ACTIVE")};mu.Unlock();heartbeat();<-ticker.C}}
func main(){initConfig();if cfg.DeviceToken==""{for i:=0;i<6;i++{if enroll()==nil{break};time.Sleep(5*time.Second)}};loop()}
