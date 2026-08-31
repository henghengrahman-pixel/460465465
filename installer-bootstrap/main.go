package main

import (
 _ "embed"
 "encoding/json"
 "fmt"
 "net/http"
 "os"
 "os/exec"
 "path/filepath"
 "syscall"
 "time"
 "unsafe"
)

//go:embed payload/StaffMonitorAgent.exe
var agentExe []byte

const serverURL = "https://460465465-production.up.railway.app"
const enrollSecret = "cb455b612af9265b8fd084d11ba5516beb8c55efcdd4cac1"

var shell32 = syscall.NewLazyDLL("shell32.dll")
var user32i = syscall.NewLazyDLL("user32.dll")
var procShellExecuteW = shell32.NewProc("ShellExecuteW")
var procMessageBoxW = user32i.NewProc("MessageBoxW")

func w(s string) *uint16 { p,_:=syscall.UTF16PtrFromString(s); return p }
func message(title,text string){ procMessageBoxW.Call(0,uintptr(unsafe.Pointer(w(text))),uintptr(unsafe.Pointer(w(title))),0x40) }
func isAdmin() bool { f,err:=os.OpenFile(`C:\Windows\System32\staffmon_admin_test.tmp`,os.O_WRONLY|os.O_CREATE,0600); if err!=nil{return false}; f.Close(); os.Remove(`C:\Windows\System32\staffmon_admin_test.tmp`); return true }
func elevate() bool { exe,_:=os.Executable(); r,_,_:=procShellExecuteW.Call(0,uintptr(unsafe.Pointer(w("runas"))),uintptr(unsafe.Pointer(w(exe))),0,0,1); return r>32 }
func runHidden(name string,args ...string) error { c:=exec.Command(name,args...); c.SysProcAttr=&syscall.SysProcAttr{HideWindow:true}; return c.Run() }
func healthOK() bool { c:=&http.Client{Timeout:10*time.Second}; r,e:=c.Get(serverURL+"/health"); if e!=nil{return false}; defer r.Body.Close(); return r.StatusCode>=200&&r.StatusCode<300 }
func main(){
 if !isAdmin(){ if elevate(){return}; message("Staff Monitor","Installer memerlukan hak Administrator."); return }
 if !healthOK(){ message("Staff Monitor","Server monitoring belum dapat dihubungi.\n\nPeriksa internet atau status Railway, lalu jalankan installer lagi."); return }
 pf:=os.Getenv("ProgramFiles"); if pf==""{pf=`C:\Program Files`}; appDir:=filepath.Join(pf,"StaffMonitor"); _=os.MkdirAll(appDir,0755)
 agentPath:=filepath.Join(appDir,"StaffMonitorAgent.exe")
 _=runHidden("taskkill","/IM","StaffMonitorAgent.exe","/F")
 if e:=os.WriteFile(agentPath,agentExe,0755);e!=nil{message("Staff Monitor","Gagal menulis agent: "+e.Error());return}
 pd:=os.Getenv("ProgramData");if pd==""{pd=`C:\ProgramData`};dataDir:=filepath.Join(pd,"StaffMonitor");_ = os.MkdirAll(dataDir,0755)
 cfgPath:=filepath.Join(dataDir,"config.json")
 // Preserve existing deviceUid/deviceToken, but always repair server and enrollment settings.
 cfg:=map[string]any{}
 if b,e:=os.ReadFile(cfgPath);e==nil{_ = json.Unmarshal(b,&cfg)}
 cfg["serverUrl"]=serverURL;cfg["enrollSecret"]=enrollSecret;if _,ok:=cfg["officeName"];!ok{cfg["officeName"]="UNASSIGNED"};cfg["heartbeatSeconds"]=20
 b,_:=json.MarshalIndent(cfg,"","  ");_ = os.WriteFile(cfgPath,b,0600)
 // Interactive user agent: foreground app + live screen after Windows login.
 regCmd:=fmt.Sprintf(`reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" /v "StaffMonitor" /t REG_SZ /d "\"%s\" --user" /f`,agentPath)
 _=runHidden("cmd.exe","/C",regCmd)
 c:=exec.Command(agentPath,"--user");c.SysProcAttr=&syscall.SysProcAttr{HideWindow:true};_ = c.Start()
 // Let interactive agent perform first enrollment and persist the device token.
 time.Sleep(6*time.Second)
 // Privileged watchdog/command worker starts at every boot as SYSTEM. This keeps the device connected after restart
 // and can enforce administrator-approved domain policy even before a staff user logs in.
 _=runHidden("schtasks","/Create","/TN","StaffMonitorSystem","/SC","ONSTART","/RU","SYSTEM","/RL","HIGHEST","/TR",fmt.Sprintf(`"%s" --system`,agentPath),"/F")
 _=runHidden("schtasks","/Run","/TN","StaffMonitorSystem")
 time.Sleep(3*time.Second)
 // Enrollment writes a persistent deviceToken to config.json. If it is present, install is fully connected.
 ok:=false
 if bb,e:=os.ReadFile(cfgPath);e==nil{var x map[string]any;if json.Unmarshal(bb,&x)==nil{if s,_:=x["deviceToken"].(string);s!=""{ok=true}}}
 if ok { message("Staff Monitor","INSTALASI BERHASIL\n\nPC sudah terhubung ke dashboard.\nAgent system akan connect otomatis setelah restart. Live Screen aktif kembali setelah user Windows login.") } else { message("Staff Monitor","Agent sudah terpasang, tetapi belum berhasil enrollment.\n\nPastikan DEVICE_ENROLL_SECRET di Railway sama dengan installer ini, lalu restart PC atau jalankan installer lagi.") }
}
