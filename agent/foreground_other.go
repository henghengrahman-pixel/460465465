//go:build !windows
package main
func foreground()(string,string){return "",""}
func idleSeconds()int{return 0}
