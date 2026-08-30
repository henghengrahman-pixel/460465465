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

const Version = "1.1.0"

var DefaultServerURL = "https://460465465-production.up.railway.app"
var DefaultEnrollSecret = "cb455b612af9265b8fd084d11ba5516beb8c55efcdd4cac1"
var DefaultOfficeName = "UNASSIGNED"

type Config struct {
 ServerURL string `json:"serverUrl"`
 EnrollSecret string `json:"enrollSecret"`
 DeviceUID string `json:"deviceUid"`
 DeviceToken string `json:"deviceToken"`
 OfficeName string `json:"officeName"`
 HeartbeatSeconds int `json:"heartbeatSeconds"`
}
type Command struct{ID string `json:"id"`; Type string `json:"command_type"`; Payload map[string]any `json:"payload"`}
type heartbeatResp struct{OK bool `json:"ok"`; Commands []Command `json:"commands"`}

var cfg Config
var mu sync.Mutex
var lastApp,lastTitle string
var logger *log.Logger

func dataDir() string { base:=os.Getenv("PROGRAMDATA"); if base=="" { base="." }; return filepath.Join(base,"StaffMonitor") }
func cfgPath() string { return filepath.Join(dataDir(),"config.json") }
func logPath() string { return filepath.Join(dataDir(),"logs","agent.log") }
func initLogger(){ _=os.MkdirAll(filepath.Dir(logPath()),0755); f,e:=os.OpenFile(logPath(),os.O_CREATE|os.O_WRONLY|os.O_APPEND,0644); if e!=nil { logger=log.New(io.Discard,"",log.LstdFlags); return }; logger=log.New(f,"",log.LstdFlags|log.Lmicroseconds) }
func randomID() string{b:=make([]byte,16);_,_=rand.Read(b);return hex.EncodeToString(b)}
func envOr(k,v string)string{if x:=strings.TrimSpace(os.Getenv(k));x!=""{return x};return v}
func loadConfig() error{p:=cfgPath();b,e:=os.ReadFile(p);if e!=nil{return e};return json.Unmarshal(b,&cfg)}
func saveConfig() error{p:=cfgPath();_ = os.MkdirAll(filepath.Dir(p),0755);b,_:=json.MarshalIndent(cfg,"","  ");return os.WriteFile(p,b,0600)}

func initConfig(){
 if loadConfig()==nil {
  // Allow centrally supplied values to repair old localhost configs without deleting the device identity/token.
  if x:=strings.TrimSpace(os.Getenv("STAFFMON_SERVER")); x!="" { cfg.ServerURL=strings.TrimRight(x,"/") }
  if x:=strings.TrimSpace(os.Getenv("STAFFMON_ENROLL_SECRET")); x!="" { cfg.EnrollSecret=x }
  if x:=strings.TrimSpace(os.Getenv("STAFFMON_OFFICE")); x!="" { cfg.OfficeName=x }
  if cfg.ServerURL=="" || strings.Contains(cfg.ServerURL,"localhost") || strings.Contains(cfg.ServerURL,"127.0.0.1") { cfg.ServerURL=strings.TrimRight(DefaultServerURL,"/") }
  if cfg.EnrollSecret=="" || cfg.EnrollSecret=="local-enroll-secret" { cfg.EnrollSecret=DefaultEnrollSecret }
  if cfg.DeviceUID=="" { cfg.DeviceUID=randomID() }
  if cfg.HeartbeatSeconds<15 { cfg.HeartbeatSeconds=20 }
  _=saveConfig(); return
 }
 cfg=Config{ServerURL:strings.TrimRight(envOr("STAFFMON_SERVER",DefaultServerURL),"/"),EnrollSecret:envOr("STAFFMON_ENROLL_SECRET",DefaultEnrollSecret),DeviceUID:randomID(),OfficeName:envOr("STAFFMON_OFFICE",DefaultOfficeName),HeartbeatSeconds:20}
 _=saveConfig()
}

func request(method,path string,body any,deviceAuth bool)([]byte,int,error){
 var rdr io.Reader
 if body!=nil{b,_:=json.Marshal(body);rdr=bytes.NewReader(b)}
 req,e:=http.NewRequest(method,cfg.ServerURL+path,rdr);if e!=nil{return nil,0,e}
 req.Header.Set("Content-Type","application/json")
 if deviceAuth{req.Header.Set("X-Device-ID",cfg.DeviceUID);req.Header.Set("X-Device-Token",cfg.DeviceToken)}
 cl:=&http.Client{Timeout:10*time.Second};resp,e:=cl.Do(req);if e!=nil{return nil,0,e}
 defer resp.Body.Close();b,_:=io.ReadAll(io.LimitReader(resp.Body,1<<20));return b,resp.StatusCode,nil
}
func enroll() error{
 host,_:=os.Hostname();body:=map[string]any{"deviceUid":cfg.DeviceUID,"name":host,"os":"windows","agentVersion":Version,"officeName":cfg.OfficeName}
 b,_:=json.Marshal(body);req,e:=http.NewRequest("POST",cfg.ServerURL+"/api/agent/enroll",bytes.NewReader(b)); if e!=nil{return e}
 req.Header.Set("Content-Type","application/json");req.Header.Set("X-Enroll-Secret",cfg.EnrollSecret)
 resp,e:=(&http.Client{Timeout:15*time.Second}).Do(req);if e!=nil{return e};defer resp.Body.Close();raw,_:=io.ReadAll(io.LimitReader(resp.Body,1<<20))
 if resp.StatusCode>=300{return fmt.Errorf("enroll HTTP %d: %s",resp.StatusCode,string(raw))}
 var out struct{OK bool `json:"ok"`;DeviceToken string `json:"deviceToken"`};if json.Unmarshal(raw,&out)!=nil||!out.OK||out.DeviceToken==""{return errors.New("invalid enroll response")}
 cfg.DeviceToken=out.DeviceToken;logger.Printf("device enrolled uid=%s server=%s",cfg.DeviceUID,cfg.ServerURL);return saveConfig()
}
func sendActivity(app,title,event string){_,code,e:=request("POST","/api/agent/activity",map[string]any{"occurredAt":time.Now().UTC().Format(time.RFC3339),"eventType":event,"appName":app,"processName":app,"windowTitle":title},true);if e!=nil{logger.Printf("activity error: %v",e)}else if code>=300{logger.Printf("activity HTTP %d",code)}}
func heartbeat(){status:="ACTIVE"; app,title:=foreground(); idle:=idleSeconds(); if idle>=300{status="IDLE"}; body:=map[string]any{"status":status,"currentApp":app,"currentTitle":title,"os":"windows","agentVersion":Version};b,code,e:=request("POST","/api/agent/heartbeat",body,true);if e!=nil{logger.Printf("heartbeat error: %v",e);return};if code==401{logger.Printf("heartbeat unauthorized, re-enrolling");cfg.DeviceToken="";_ = saveConfig();if e:=enroll();e!=nil{logger.Printf("re-enroll failed: %v",e)};return};if code>=300{logger.Printf("heartbeat HTTP %d: %s",code,string(b));return};var out heartbeatResp;if json.Unmarshal(b,&out)!=nil{return};for _,c:=range out.Commands{ok,result:=execute(c);_,_,_=request("POST","/api/agent/commands/"+c.ID+"/ack",map[string]any{"ok":ok,"result":result},true)}}
func execute(c Command)(bool,string){switch c.Type{case "WARN":msg,_:=c.Payload["message"].(string);if msg==""{msg="Pesan dari administrator"};return showWarning(msg);case "CLOSE_APP":p,_:=c.Payload["processName"].(string);return closeProcess(p);case "SET_POLICY":return true,"policy acknowledged";default:return false,"unknown command"}}
func closeProcess(name string)(bool,string){name=strings.TrimSpace(name);if name==""{return false,"processName kosong"};cmd:=exec.Command("taskkill","/IM",name,"/F");out,e:=cmd.CombinedOutput();if e!=nil{return false,string(out)};return true,string(out)}
func showWarning(msg string)(bool,string){cmd:=exec.Command("msg.exe","*",msg);out,e:=cmd.CombinedOutput();if e!=nil{return false,string(out)};return true,"warning displayed"}
func loop(){ticker:=time.NewTicker(time.Duration(max(cfg.HeartbeatSeconds,15))*time.Second);defer ticker.Stop();for{app,title:=foreground();mu.Lock();if app!=lastApp||title!=lastTitle{lastApp,lastTitle=app,title;go sendActivity(app,title,"ACTIVE")};mu.Unlock();heartbeat();<-ticker.C}}
func main(){initLogger();logger.Printf("agent starting version=%s",Version);initConfig();if cfg.DeviceToken==""{for i:=0;i<12;i++{if e:=enroll();e==nil{break}else{logger.Printf("enroll attempt %d failed: %v",i+1,e)};time.Sleep(5*time.Second)}};loop()}
