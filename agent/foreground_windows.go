//go:build windows
package main
import("syscall";"unsafe";"time")
var user32=syscall.NewLazyDLL("user32.dll");var kernel32=syscall.NewLazyDLL("kernel32.dll")
var pGetForegroundWindow=user32.NewProc("GetForegroundWindow");var pGetWindowTextW=user32.NewProc("GetWindowTextW");var pGetWindowThreadProcessId=user32.NewProc("GetWindowThreadProcessId");var pOpenProcess=kernel32.NewProc("OpenProcess");var pQueryFullProcessImageNameW=kernel32.NewProc("QueryFullProcessImageNameW");var pCloseHandle=kernel32.NewProc("CloseHandle");var pGetLastInputInfo=user32.NewProc("GetLastInputInfo");var pGetTickCount=kernel32.NewProc("GetTickCount")
type lastInputInfo struct{CbSize uint32;DwTime uint32}
func foreground()(string,string){hwnd,_,_:=pGetForegroundWindow.Call();if hwnd==0{return "",""};buf:=make([]uint16,512);pGetWindowTextW.Call(hwnd,uintptr(unsafe.Pointer(&buf[0])),uintptr(len(buf)));title:=syscall.UTF16ToString(buf);var pid uint32;pGetWindowThreadProcessId.Call(hwnd,uintptr(unsafe.Pointer(&pid)));const PROCESS_QUERY_LIMITED_INFORMATION=0x1000;h,_,_:=pOpenProcess.Call(PROCESS_QUERY_LIMITED_INFORMATION,0,uintptr(pid));if h==0{return "",title};defer pCloseHandle.Call(h);pbuf:=make([]uint16,1024);sz:=uint32(len(pbuf));r,_,_:=pQueryFullProcessImageNameW.Call(h,0,uintptr(unsafe.Pointer(&pbuf[0])),uintptr(unsafe.Pointer(&sz)));if r==0{return "",title};full:=syscall.UTF16ToString(pbuf[:sz]);for i:=len(full)-1;i>=0;i--{if full[i]=='\\'{full=full[i+1:];break}};return full,title}
func idleSeconds()int{li:=lastInputInfo{CbSize:uint32(unsafe.Sizeof(lastInputInfo{}))};r,_,_:=pGetLastInputInfo.Call(uintptr(unsafe.Pointer(&li)));if r==0{return 0};tick,_,_:=pGetTickCount.Call();return int((uint32(tick)-li.DwTime)/1000)}
var _=time.Second
